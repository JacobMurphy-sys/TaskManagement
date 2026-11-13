'use strict';
// 🔒 Who sees which tasks and projects, with accounts on (the shared server). By default an account sees only its
// own work; beyond that:
//  - a project: one it made, one it's invited to (🔒 Access › Invite), or one its person leads, sponsors or is on
//    the team of (being put on the team invites you). Seeing a project is seeing all of it: its tasks, notes, costs…
//  - a task: one it made or is invited to, a task of a project it sees, or a task its person owns that isn't a
//    subtask: each with all its subtasks. A subtask its person owns, it sees on its own (not the task it's under,
//    nor that task's other subtasks) unless invited to the task above.
//  - 👔 a department's manager (ticked in the contacts): also the open tasks owned by anyone in that department (or by
//    the department itself), each on its own; done ones drop off.
//  - quick notes and reminders: only its own (db.js's views, by created_by).
// Work made before there were accounts (no creator) counts as the first admin's.
// An admin with "All work" on (accounts.see_all) sees everything; so does a request with no account (accounts off,
// background jobs). db.js puts these sets in temporary tables that its views read.

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
// the names in an owner field: "Alex Kim, Sam Patel" (also ; / & and "and")
const namesIn = (s) => String(s || '').split(/\s*(?:[,;/&]|\band\b)\s*/i).map(norm).filter(Boolean);

// c: a node:sqlite connection (main tables read directly); viewer: { id, person }
function compute(c, viewer) {
  const acc = Number(viewer.id); const me = norm(viewer.person);
  const q = (sql, ...p) => { try { return c.prepare(sql).all(...p); } catch { return []; } };
  const firstAdmin = q("SELECT min(id) AS id FROM main.accounts WHERE role = 'admin'")[0]?.id ?? null;
  const madeByMe = (x) => (x ?? firstAdmin) === acc;
  const mine = (field) => !!me && namesIn(field).includes(me);
  const shared = { task: new Set(), project: new Set() };
  for (const r of q('SELECT kind, record_id FROM main.shares WHERE account_id = ?', acc)) shared[r.kind]?.add(r.record_id);

  const projects = new Set();
  const team = new Map(); for (const r of q('SELECT project_id, name FROM main.project_team')) { if (!team.has(r.project_id)) team.set(r.project_id, []); team.get(r.project_id).push(r.name); }
  for (const p of q('SELECT id, leader, sponsor, created_by FROM main.projects')) {
    if (madeByMe(p.created_by) || shared.project.has(p.id) || mine(p.leader) || mine(p.sponsor) || (team.get(p.id) || []).some((n) => norm(n) === me)) projects.add(p.id);
  }
  // 👔 a department's manager (ticked in the contacts): the open tasks of everyone in it, and of the department itself
  const managed = new Set(q('SELECT name, department FROM main.name_list_items WHERE manager = 1 AND department IS NOT NULL').filter((r) => norm(r.name) === me).map((r) => norm(r.department)));
  const deptOf = new Map();
  if (managed.size) for (const r of q('SELECT name, department FROM main.name_list_items WHERE department IS NOT NULL ORDER BY active DESC, sort_order')) if (!deptOf.has(norm(r.name))) deptOf.set(norm(r.name), norm(r.department));
  const inMyDept = (owner) => managed.size > 0 && namesIn(owner).some((n) => n !== me && (managed.has(deptOf.get(n)) || managed.has(n)));
  const rows = q('SELECT id, parent_id, project_id, owner, status, created_by FROM main.tasks');
  const kids = new Map(); for (const t of rows) if (t.parent_id) { if (!kids.has(t.parent_id)) kids.set(t.parent_id, []); kids.get(t.parent_id).push(t.id); }
  const full = new Set(); const visible = new Set();
  for (const t of rows) {
    if (madeByMe(t.created_by) || shared.task.has(t.id) || (t.project_id && projects.has(t.project_id)) || (!t.parent_id && mine(t.owner))) full.add(t.id);
    else if (mine(t.owner)) visible.add(t.id); // a subtask of theirs: on its own
    else if (t.status !== 'done' && inMyDept(t.owner)) visible.add(t.id); // 👔 open, and someone in a department they manage owns it
  }
  // a task seen in full brings all its subtasks, however deep
  const stack = [...full];
  while (stack.length) { const id = stack.pop(); for (const k of kids.get(id) || []) if (!full.has(k)) { full.add(k); stack.push(k); } }
  for (const id of full) visible.add(id);
  return { projects, tasks: visible, full };
}

// Work from before accounts (no creator): credited to the account of the person the history says added it, where
// that person has an account now. Run at start-up (only rows still without a creator; the rest stay the first admin's).
function backfill(c, before = null) {
  const accts = c.prepare('SELECT id, person FROM main.accounts WHERE active = 1 AND training = 0').all();
  if (!accts.length) return 0;
  const byName = new Map(accts.map((a) => [norm(a.person), a.id]));
  let n = 0;
  for (const t of ['tasks', 'projects', 'notes', 'reminders']) {
    const rows = c.prepare(`SELECT x.id, a.changed_by FROM main.${t} x JOIN main.audit_log a ON a.table_name = ? AND a.record_id = x.id AND a.action = 'INSERT'
      WHERE x.created_by IS NULL AND a.changed_by IS NOT NULL`).all(t);
    const todo = rows.map((r) => [byName.get(norm(r.changed_by)), r.id]).filter(([id]) => id);
    if (!todo.length) continue;
    if (!n && before) before(); // (the caller turns the triggers off: not a change anyone made)
    const set = c.prepare(`UPDATE main.${t} SET created_by = ? WHERE id = ? AND created_by IS NULL`);
    for (const [id, rid] of todo) { set.run(id, rid); n++; }
  }
  return n;
}

module.exports = { compute, backfill, namesIn, norm };
