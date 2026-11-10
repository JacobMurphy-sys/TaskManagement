'use strict';
// 📄 Automatic plans (Production › Setup): the 📄 Generate plan PDF made on a schedule, like a report
// subscription. Each one is a saved set-up (Perso or Matching, the order, cells or lists, layout, rows,
// overdue apart, testing) with the times and days it runs and the file it writes. Each run overwrites
// that file, so the shop floor always opens the same file and finds the latest plan in it.
//
// Kept in settings: plan_auto (the list) and plan_auto_state (each one's last run). Checked every minute;
// a time is only run in the quarter of an hour after it, so a restart doesn't make a pile of old plans.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { planSheetModel, ottoGroups, orderSpec, ottoSpec } = require('../public/plansheet-model');

const MODES = { fifo: 'FIFO', bau: 'BAU', score: 'Score', mitigation: 'Mitigation' };
const LATE_WINDOW_MIN = 15; // a missed time is still run this long after it (not later)
const MAX = 20;

const kv = (k) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value;
const setKv = (k, v) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v]);
const json = (s, d) => { try { const v = JSON.parse(s || ''); return v ?? d; } catch { return d; } };
const pad = (n) => String(n).padStart(2, '0');
const localKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const err400 = (msg) => Object.assign(new Error(msg), { status: 400 });

const list = () => json(kv('plan_auto'), []);
const states = () => json(kv('plan_auto_state'), {});
const saveState = (id, st) => { const all = states(); all[id] = { ...(all[id] || {}), ...st }; setKv('plan_auto_state', JSON.stringify(all)); return all[id]; };

// one subscription, checked and tidied (throws a 400 with what's wrong)
function clean(x, i) {
  const name = String(x.name || '').trim().slice(0, 80) || `Plan ${i + 1}`;
  const half = x.half === 'otto' ? 'otto' : 'perso';
  const times = [...new Set(String(Array.isArray(x.times) ? x.times.join(',') : x.times || '').split(/[\s,;]+/).filter(Boolean).map((t) => {
    const m = t.match(/^(\d{1,2})[:.h]?(\d{2})$/); if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw err400(`“${name}”: ${t} isn't a time (e.g. 06:00, 14:30)`);
    return `${pad(Number(m[1]))}:${m[2]}`;
  }))].sort();
  if (x.enabled !== false && !times.length) throw err400(`“${name}”: give at least one time it runs`);
  const days = [...new Set((Array.isArray(x.days) ? x.days : String(x.days ?? '1,2,3,4,5').split(',')).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const folder = String(x.folder || '').trim().replace(/^"|"$/g, '');
  if (!folder) throw err400(`“${name}”: say which folder the plan is saved in`);
  if (!path.isAbsolute(folder) && !/^\\\\/.test(folder)) throw err400(`“${name}”: the folder needs a full path, e.g. S:\\Production\\Plans or \\\\server\\share\\Plans`);
  const file = String(x.file || '').trim().replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*]/g, '').slice(0, 120) || (half === 'otto' ? 'Matching plan' : 'Production plan');
  return {
    id: String(x.id || '').match(/^[a-z0-9]{4,20}$/) ? x.id : Math.random().toString(36).slice(2, 10),
    name, enabled: x.enabled !== false, half, mode: half === 'otto' ? 'fifo' : (MODES[x.mode] ? x.mode : 'fifo'),
    cells: Array.isArray(x.cells) ? x.cells.map((c) => String(c).trim()).filter(Boolean).slice(0, 20) : [],
    layout: x.layout === 'side' ? 'side' : 'pages', limit: Math.max(0, Math.min(500, Math.round(Number(x.limit) || 0))),
    split: !!x.split, testing: !!x.testing, times, days: days.length ? days : [1, 2, 3, 4, 5], folder, file,
  };
}
function save(items) {
  if (!Array.isArray(items)) throw err400('Send the list of automatic plans');
  if (items.length > MAX) throw err400(`At most ${MAX} automatic plans`);
  const out = items.map(clean);
  setKv('plan_auto', JSON.stringify(out));
  const keep = new Set(out.map((s) => s.id)); const st = states();
  for (const id of Object.keys(st)) if (!keep.has(id)) delete st[id];
  setKv('plan_auto_state', JSON.stringify(st));
  return out;
}
const target = (s) => path.join(s.folder, `${s.file}.pdf`);

// makes one plan now and overwrites its file: { ok, at, file, bytes, jobs } or { ok: false, error }
let deps = null; // { planData(mode), renderPlanPdf(model), log }
const useDeps = (d) => { deps = d; };
const running = new Set();
async function run(s, { slot = null, now = new Date() } = {}) {
  if (!deps) throw new Error('Automatic plans aren\'t ready yet');
  if (running.has(s.id)) return { ok: false, error: 'Already being made' };
  running.add(s.id);
  const at = new Date().toISOString();
  try {
    const p = deps.planData(s.mode);
    if (s.half === 'perso' && p.source?.status !== 'ok') throw new Error(`The open work orders export couldn't be read (${p.source?.error || p.source?.status || 'not linked'})`);
    const otto = s.half === 'otto';
    const groups = otto ? ottoGroups(p.otto || { running: [], queue: [] }) : null;
    const jobs = otto ? [] : [...p.running, ...p.queue];
    const model = planSheetModel(jobs, {
      cells: s.cells.length ? s.cells : undefined, layout: s.layout, limit: s.limit, splitOverdue: s.split, groups, test: s.testing, now,
      method: otto ? 'Matching' : MODES[s.mode], spec: s.testing ? (otto ? ottoSpec({ split: s.split }, now) : orderSpec(p, s.mode, { split: s.split }, now)) : null,
      title: otto ? 'Matching plan' : 'Production plan', fileLabel: s.file,
    });
    model.title = `${model.title} · ${s.name} (automatic)`;
    const buf = await deps.renderPlanPdf(model);
    const file = target(s);
    fs.mkdirSync(s.folder, { recursive: true });
    // written beside it, then swapped in, so nobody opens a half-written plan; if the old one is open on a
    // PC (Windows won't replace it), written over in place instead
    const tmp = `${file}.sithub-tmp`;
    try { fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file); } catch (e1) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* fine */ }
      try { fs.writeFileSync(file, buf); } catch (e2) {
        throw new Error(e2.code === 'EBUSY' || e2.code === 'EPERM' || e1.code === 'EBUSY' || e1.code === 'EPERM'
          ? `${file} is open on a PC and couldn't be replaced: the next run tries again` : e2.code === 'ENOENT' ? `Can't reach the folder ${s.folder}` : e2.message);
      }
    }
    const count = model.pages.reduce((t, pg) => t + pg.sections.reduce((u, x) => u + x.rows.length, 0), 0);
    const st = saveState(s.id, { ok: true, at, slot: slot || undefined, file, bytes: buf.length, rows: count, error: null });
    deps.log?.info(`Automatic plan “${s.name}”: ${file} (${count} rows)`);
    return st;
  } catch (err) {
    deps.log?.warn(`Automatic plan “${s.name}”: ${err.message}`);
    return saveState(s.id, { ok: false, at, slot: slot || undefined, error: err.message });
  } finally { running.delete(s.id); }
}

// every minute: the plans whose time has come (on one of their days, within the quarter of an hour after it)
async function tick(now = new Date()) {
  const key = localKey(now); const st = states();
  for (const s of list()) {
    if (!s.enabled || !s.days.includes(now.getDay())) continue;
    for (const t of s.times) {
      const slot = `${key.slice(0, 10)}T${t}`;
      const [h, m] = t.split(':').map(Number);
      const due = new Date(now); due.setHours(h, m, 0, 0);
      const late = (now - due) / 60000;
      if (late < 0 || late > LATE_WINDOW_MIN || (st[s.id]?.slot && st[s.id].slot >= slot)) continue;
      await run(s, { slot, now });
      break; // one run per plan per minute is plenty
    }
  }
}
function start() {
  const go = () => tick().catch((err) => deps?.log?.warn(`Automatic plans: ${err.message}`));
  setTimeout(go, 20 * 1000).unref();
  setInterval(go, 60 * 1000).unref();
}

// for the page: each plan with its last run and when it runs next
function overview(now = new Date()) {
  const st = states();
  return list().map((s) => ({ ...s, path: target(s), last: st[s.id] || null, next: s.enabled ? nextRun(s, now) : null }));
}
function nextRun(s, now = new Date()) {
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    if (!s.days.includes(d.getDay())) continue;
    for (const t of s.times) { const [h, m] = t.split(':').map(Number); const at = new Date(d); at.setHours(h, m, 0, 0); if (at > now) return localKey(at); }
  }
  return null;
}

module.exports = { list, save, run, tick, start, overview, useDeps, clean, nextRun, target };
