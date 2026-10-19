'use strict';
// 👥 Several people on one CI Manager (the shared server): who's here and what they're looking at,
// what others have just changed (so open pages can say so, or refresh), and no silent overwrites
// of text two people were editing at once.
//
// - Every change request runs "as" its person and browser (X-User-Name, X-Client-Id), so the audit
//   log's triggers record who made each change (db.asActor → cim_who() / cim_client()).
// - After a change, the audit rows it wrote become one entry in a short feed of changes, with the
//   topics it touches (task:12, project:3, idea, kpi, planning, …) and a line saying what it was.
// - A text field saved with `_base: { field: value when editing began }` is refused (409) when the
//   field has since been changed by someone else: the page then shows both versions to choose from.
const db = require('./db');
const config = require('./config');

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
const header = (req, name, max) => { let v = String(req.get(name) || ''); try { v = decodeURIComponent(v); } catch { /* as sent */ } return v.trim().slice(0, max) || null; };
// the signed-in account's person, else the name the browser gave
const whoOf = (req) => req.account?.person || header(req, 'X-User-Name', 60);
const clientOf = (req) => header(req, 'X-Client-Id', 60);

// ---- what a change touches, and how to say it ---------------------------------------------------
const LABEL = { projects: 'project', tasks: 'task', ideas: 'idea', idea_notes: 'idea note', meetings: 'meeting', notes: 'note', reminders: 'reminder',
  project_phases: 'phase', project_costs: 'cost', project_team: 'team member', project_kpis: 'project KPI', task_links: 'task link', attachments: 'attachment',
  kpi_edits: 'the A3', kpi_notes: 'the week\'s notes', kpi_manual: 'KPI figures', settings: 'the settings', areas: 'areas', lookups: 'project lists',
  name_lists: 'contacts lists', name_list_items: 'contacts' };
const SKIP_COLS = new Set(['updated_at', 'created_at', 'completed_at', 'dismissed_at', 'sort_order', 'id']);
const kindOf = (table) => (table.startsWith('plan_') ? 'planning' : table.startsWith('kpi_') ? 'kpi' : table === 'settings' ? 'settings'
  : table.replace(/_items$/, '').replace(/ies$/, 'y').replace(/s$/, ''));
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const nice = (c) => c.replace(/_at$/, '').replace(/_id$/, '').replace(/_/g, ' ');

function describe(rows) {
  const topics = new Set();
  const parts = [];
  for (const r of rows) {
    const kind = kindOf(r.table_name);
    topics.add(kind);
    if (r.record_id !== null) topics.add(`${kind}:${r.record_id}`);
    if (r.project_id) { topics.add(`project:${r.project_id}`); topics.add('project'); }
    const o = parse(r.old_data) || {}; const n = parse(r.new_data) || {};
    // the parents it hangs from (idea_id → idea:5, meeting_id → meeting:2, …)
    for (const [k, v] of Object.entries({ ...o, ...n })) if (/_id$/.test(k) && Number.isInteger(v) && k !== 'area_id') topics.add(`${k.slice(0, -3)}:${v}`);
    const label = r.table_name.startsWith('plan_') ? 'the planning setup' : LABEL[r.table_name] || nice(r.table_name);
    const title = n.title || n.name || o.title || o.name || null;
    const what = `${label}${title && !label.startsWith('the ') ? ` “${String(title).slice(0, 60)}”` : ''}`;
    if (r.action === 'INSERT') parts.push(`added ${what}`);
    else if (r.action === 'DELETE') parts.push(`removed ${what}`);
    else {
      const cols = Object.keys(n).filter((c) => !SKIP_COLS.has(c) && JSON.stringify(o[c]) !== JSON.stringify(n[c]));
      parts.push(`changed ${what}${cols.length && cols.length <= 3 && !label.startsWith('the ') ? ` (${cols.map(nice).join(', ')})` : ''}`);
    }
  }
  const uniq = [...new Set(parts)];
  return { topics: [...topics], text: uniq.length > 2 ? `${uniq.slice(0, 2).join(', ')} and ${uniq.length - 2} more` : uniq.join(', ') };
}

// ---- the feed of recent changes (in memory; the audit log keeps them for good) ---------------------
const FEED_MAX = 500;
const feed = [];
let seq = 0;
function record(startId, who, client, path) {
  const rows = db.all('SELECT table_name, record_id, project_id, action, old_data, new_data FROM audit_log WHERE id > ? AND client_id IS ? ORDER BY id', [startId, client]);
  if (!rows.length) return;
  const d = describe(rows);
  feed.push({ seq: ++seq, at: new Date().toISOString(), by: who || 'Someone', client, path, topics: d.topics, text: d.text });
  if (feed.length > FEED_MAX) feed.splice(0, feed.length - FEED_MAX);
}
const since = (n, client) => feed.filter((c) => c.seq > n && c.client !== client);

// ---- no silent overwrites ------------------------------------------------------------------------
// The record a save goes to, and its current row (null: not checked).
const TARGETS = [[/^\/projects\/(\d+)$/, 'projects'], [/^\/phases\/(\d+)$/, 'project_phases'], [/^\/tasks\/(\d+)$/, 'tasks'], [/^\/meetings\/(\d+)$/, 'meetings'],
  [/^\/notes\/(\d+)$/, 'notes'], [/^\/ideas\/(\d+)$/, 'ideas'], [/^\/costs\/(\d+)$/, 'project_costs']];
function targetOf(req) {
  for (const [re, table] of TARGETS) {
    const m = req.path.match(re);
    if (m) { const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, [Number(m[1])]); return row ? { table, row } : null; }
  }
  let m = req.path.match(/^\/kpi\/edits\/([^/]+)$/);
  if (m) { const row = db.get('SELECT * FROM kpi_edits WHERE week = ? AND ref = ?', [m[1].toUpperCase(), String(req.body?.ref || '').toUpperCase()]); return row ? { table: 'kpi_edits', row } : null; }
  m = req.path.match(/^\/kpi\/notes\/([^/]+)$/);
  if (m) { const row = db.get('SELECT * FROM kpi_notes WHERE week = ?', [m[1].toUpperCase()]); return row ? { table: 'kpi_notes', row } : null; }
  return null;
}
const norm = (v) => (v === null || v === undefined ? '' : String(v)).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
// The last change to a field of a record: { by, client, at } (null when there's none recorded).
function lastChangeOf(table, id, field) {
  for (const r of db.all('SELECT action, old_data, new_data, changed_by, client_id, changed_at FROM audit_log WHERE table_name = ? AND record_id = ? ORDER BY id DESC LIMIT 200', [table, id])) {
    const o = parse(r.old_data) || {}; const n = parse(r.new_data) || {};
    if (r.action === 'INSERT' || JSON.stringify(o[field]) !== JSON.stringify(n[field])) return { by: r.changed_by, client: r.client_id, at: r.changed_at };
  }
  return null;
}
// → null (fine to save) or { field, theirs, by, at }: the field was changed by someone else after
// this person started editing it (their starting value no longer matches, and the last change to
// it came from another browser — so a value the server tidied up never counts as a conflict).
function conflictOf(req, client) {
  const base = req.body?._base;
  if (!base || typeof base !== 'object') return null;
  const t = targetOf(req);
  if (!t) return null;
  for (const [field, was] of Object.entries(base)) {
    if (!(field in t.row) || !(field in req.body)) continue;
    const now = t.row[field];
    if (norm(now) === norm(was) || norm(now) === norm(req.body[field])) continue;
    const last = lastChangeOf(t.table, t.row.id, field);
    if (!last || !last.client || last.client === client) continue;
    return { field, theirs: now ?? '', by: last.by || 'Someone', at: last.at };
  }
  return null;
}

// ---- the middleware for change requests ---------------------------------------------------------
function changes(req, res, next) {
  if (req.method === 'GET') return next();
  const who = whoOf(req); const client = clientOf(req);
  const conflict = conflictOf(req, client);
  if (conflict) return res.status(409).json({ error: `${conflict.by} changed this while you were editing it`, conflict });
  if (req.body && typeof req.body === 'object' && '_base' in req.body) delete req.body._base;
  const startId = db.get('SELECT coalesce(max(id), 0) AS m FROM audit_log').m;
  res.on('finish', () => { if (res.statusCode < 400) { try { record(startId, who, client, req.path); } catch { /* the feed is a nicety */ } } });
  db.asActor({ who: who || (config.shared && !isLocal(req) ? req.ip : null), client }, next);
}

// ---- who's here -----------------------------------------------------------------------------------
const presence = new Map(); // client → { name, view, topic, at, since }
function here(body, req) {
  const id = String(body?.id || '').slice(0, 60);
  const now = Date.now();
  for (const [k, v] of presence) if (now - v.at > 60000) presence.delete(k);
  if (id) presence.set(id, { name: String(body.name || '').slice(0, 60) || 'Someone', view: String(body.view || '').slice(0, 60), topic: String(body.topic || '').slice(0, 60) || null,
    at: now, since: presence.get(id)?.since || now, ip: req.ip });
  const n = Number(body?.seq);
  return {
    others: [...presence.entries()].filter(([k]) => k !== id).map(([, v]) => ({ name: v.name, view: v.view, topic: v.topic, since: new Date(v.since).toISOString() })),
    seq, changes: Number.isFinite(n) && n >= 0 ? since(n, id) : [],
  };
}

// How many browsers have it open now (seen in the last minute).
const peopleHere = () => [...presence.values()].filter((v) => Date.now() - v.at < 60000).length;

module.exports = { changes, here, peopleHere, isLocal, whoOf, clientOf, describe, lastChangeOf, conflictOf, feed };
