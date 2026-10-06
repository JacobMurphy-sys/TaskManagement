// End-to-end smoke test. Starts the server on a spare port with a throw-away
// database in a temp folder, and exercises the API. Usage: npm test
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const PORT = 3999;
// The core of a project charter, required to create a project.
const CHARTER = { problem: 'Supplier costs rising', goals: 'Cut spend 5%', sponsor: 'J. Smith', leader: 'Sam Patel' };
const BASE = `http://127.0.0.1:${PORT}/api`;

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TaskManager' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/projects`); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('Server did not start');
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taskmgr-test-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), BACKUP_INTERVAL_HOURS: '0',
      DATA_DIR: tmp, DB_FILE: path.join(tmp, 'test.db'), BACKUP_DIR: path.join(tmp, 'backups'), LOG_DIR: path.join(tmp, 'logs'),
    },
    stdio: 'inherit',
  });
  try {
    await waitForServer();

    const p = await call('POST', '/projects', { ...CHARTER,
      name: `Smoke test ${new Date().toISOString()}`, priority: 3,
      due_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      baseline_tasks: ['First baseline task', 'Second baseline task', ''], initial_note: 'Kick-off',
    });
    let full = await call('GET', `/projects/${p.id}`);
    assert.equal(full.tasks.length, 2, 'baseline tasks created');
    assert.ok(full.baseline_set_at, 'baseline set on create');
    assert.ok(full.tasks.every((t) => t.is_baseline));

    const added = await call('POST', '/tasks', { project_id: p.id, title: 'Added later', due_at: new Date(Date.now() - 3600000).toISOString() });
    assert.equal(added.is_baseline, false, 'post-baseline task flagged as added');
    const sub = await call('POST', '/tasks', { parent_id: added.id, title: 'A subtask' });
    assert.equal(sub.project_id, p.id, 'subtask inherits project');

    // Completing the parent with cascade completes subtasks, stamping completed_at.
    const done = await call('PATCH', `/tasks/${added.id}`, { status: 'done', cascade: true });
    assert.ok(done.completed_at, 'completed_at stamped');
    const detail = await call('GET', `/tasks/${added.id}`);
    assert.equal(detail.subtasks[0].status, 'done', 'cascade completed subtask');
    assert.ok(detail.history.some((h) => /status: To do → Done/.test(h.text)), 'status change in history');
    const reopened = await call('PATCH', `/tasks/${added.id}`, { status: 'todo' });
    assert.equal(reopened.completed_at, null, 'completed_at cleared on reopen');

    await call('POST', '/notes', { project_id: p.id, body: 'Progress update' });
    await call('POST', '/notes', { task_id: added.id, body: 'Task-level note' });
    const timeline = await call('GET', `/projects/${p.id}/timeline`);
    assert.equal(timeline.filter((i) => i.type === 'note').length, 3, 'three notes in timeline');
    assert.ok(timeline.some((i) => i.type === 'event' && /Task created "Added later"/.test(i.text)));

    // Reminders: one due now, one in the future.
    const r1 = await call('POST', '/reminders', { task_id: added.id, remind_at: new Date(Date.now() - 1000).toISOString(), message: 'Chase it' });
    await call('POST', '/reminders', { project_id: p.id, remind_at: new Date(Date.now() + 86400000).toISOString() });
    let alerts = await call('GET', '/alerts');
    assert.ok(alerts.reminders.some((r) => r.id === r1.id), 'due reminder in alerts');
    assert.ok(alerts.due_tasks.some((t) => t.id === added.id), 'overdue task in alerts');
    await call('PATCH', `/reminders/${r1.id}`, { action: 'snooze', minutes: 10 });
    alerts = await call('GET', '/alerts');
    assert.ok(!alerts.reminders.some((r) => r.id === r1.id), 'snoozed reminder not yet due');
    await call('PATCH', `/reminders/${r1.id}`, { action: 'dismiss' });

    // Re-baseline absorbs the added task.
    await call('POST', `/projects/${p.id}/baseline`);
    full = await call('GET', `/projects/${p.id}`);
    assert.ok(full.tasks.every((t) => t.is_baseline), 're-baseline marks all tasks');
    assert.equal(full.baseline_snapshot.tasks.length, 4);

    const kanban = await call('GET', `/tasks?project_id=${p.id}&top_level=1`);
    assert.equal(kanban.length, 3, 'kanban top-level tasks');
    const dash = await call('GET', '/dashboard');
    assert.ok(dash.overdue.some((t) => t.id === added.id), 'dashboard overdue');
    const search = await call('GET', '/search?q=Progress%20update');
    assert.ok(search.notes.length >= 1, 'search finds note');

    const audit = await call('GET', `/audit?project_id=${p.id}`);
    assert.ok(audit.length > 5, 'audit log populated');

    await assert.rejects(call('POST', '/tasks', { project_id: p.id, title: '' }), /400/);
    await assert.rejects(call('PATCH', `/tasks/${added.id}`, { priority: 9 }), /400/);

    // Timestamps are canonical UTC ISO strings and completed_at is trigger-stamped.
    assert.match(full.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const later = await call('PATCH', `/tasks/${added.id}`, { title: 'Added later (renamed)' });
    assert.ok(later.updated_at >= reopened.updated_at, 'updated_at bumped');
    const doneOnCreate = await call('POST', '/tasks', { project_id: p.id, title: 'Already done', status: 'done' });
    assert.ok(doneOnCreate.completed_at, 'completed_at stamped on insert');

    // Due dates are whole days: a plain date is stored as the end of that local day.
    const dated = await call('POST', '/tasks', { project_id: p.id, title: 'Date only', due_at: '2026-10-01' });
    const d = new Date(dated.due_at);
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 9, 1, 23, 59], 'end of local day');
    await assert.rejects(call('PATCH', `/tasks/${dated.id}`, { due_at: '2026-02-30' }), /400/);
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await call('PATCH', `/tasks/${dated.id}`, { due_at: todayKey });
    const dash2 = await call('GET', '/dashboard');
    assert.ok(dash2.today.some((t) => t.id === dated.id), 'due today is not yet overdue');
    assert.ok(!dash2.overdue.some((t) => t.id === dated.id));
    await call('DELETE', `/tasks/${dated.id}`);

    // Search treats % and _ literally.
    assert.equal((await call('GET', '/search?q=%25')).tasks.length, 0);

    const b = await call('POST', '/backups');
    assert.ok(b.json.endsWith('.json') && fs.existsSync(b.json), 'JSON backup written');
    assert.ok(b.db.endsWith('.db') && fs.existsSync(b.db), 'database copy written');

    // ---- Ideation
    const areas = await call('GET', '/areas');
    assert.deepEqual(areas.map((a) => a.name), ['General'], 'default area seeded');
    const ops = await call('POST', '/areas', { name: 'Operations' });
    await assert.rejects(call('POST', '/areas', { name: 'operations' }), /already exists/);
    assert.equal((await call('GET', '/settings')).currency, '£');
    await call('PATCH', '/settings', { currency: '€' });

    const idea1 = await call('POST', '/ideas', {
      title: 'Automate supplier scoring', description: 'Use the spend data', submitted_by: 'Sam',
      area_id: ops.id, priority: 3, due_at: new Date(Date.now() + 5 * 86400000).toISOString(), cost: '1,250.50',
    });
    assert.equal(idea1.ref, 'IDEA-0001', 'first idea gets IDEA-0001');
    assert.equal(idea1.cost, 1250.5, 'cost parsed');
    assert.equal(idea1.area_name, 'Operations');
    const idea2 = await call('POST', '/ideas', { title: 'Second idea', submitted_by: 'Alex' });
    assert.equal(idea2.ref, 'IDEA-0002');
    await assert.rejects(call('POST', '/ideas', { title: 'x', cost: -5 }), /400/);
    await assert.rejects(call('POST', '/ideas', { title: '' }), /400/);
    await assert.rejects(call('DELETE', `/areas/${ops.id}`), /used by 1 idea/);

    await call('POST', `/ideas/${idea1.id}/notes`, { body: 'Discussed with finance' });
    await call('PATCH', `/ideas/${idea1.id}`, { status: 'approved' });
    let ideaDetail = await call('GET', `/ideas/${idea1.id}`);
    assert.equal(ideaDetail.notes.length, 1);
    assert.ok(ideaDetail.history.some((h) => /status: New → Approved/.test(h.text)), 'idea status change in history');
    assert.deepEqual(await call('GET', '/ideas/submitters'), ['Alex', 'Sam']);
    assert.equal((await call('GET', '/ideas?status=open')).length, 2);
    assert.equal((await call('GET', `/ideas?area_id=${ops.id}`)).length, 1);
    assert.equal((await call('GET', '/ideas?q=IDEA-0002')).length, 1);
    assert.ok((await call('GET', '/search?q=finance')).ideas.some((i) => i.id === idea1.id), 'search finds idea notes');

    const escalated = await call('POST', `/ideas/${idea1.id}/escalate`, { ...CHARTER, problem: undefined, baseline_tasks: ['Build model', 'Pilot'] });
    const ep = await call('GET', `/projects/${escalated.id}`);
    assert.equal(ep.name, 'Automate supplier scoring');
    assert.equal(ep.priority, 3);
    assert.equal(ep.tasks.length, 2);
    assert.equal(ep.escalated_from.ref, 'IDEA-0001', 'project links back to idea');
    const eTimeline = await call('GET', `/projects/${ep.id}/timeline`);
    assert.ok(eTimeline.some((t) => t.type === 'note' && /€1,250\.50/.test(t.body)), 'summary note with cost');
    assert.ok(eTimeline.some((t) => t.type === 'note' && t.body === '[IDEA-0001] Discussed with finance'), 'idea notes copied');
    ideaDetail = await call('GET', `/ideas/${idea1.id}`);
    assert.equal(ideaDetail.status, 'escalated');
    assert.equal(ideaDetail.project_id, ep.id);
    await assert.rejects(call('POST', `/ideas/${idea1.id}/escalate`, {}), /already been escalated/);
    await assert.rejects(call('PATCH', `/ideas/${idea1.id}`, { status: 'new' }), /already been escalated/);
    assert.equal((await call('GET', '/ideas?status=open')).length, 1, 'escalated idea no longer open');
    await call('DELETE', `/ideas/${idea2.id}`);

    // ---- Notes create tasks from "[ ]" lines
    const np = await call('POST', '/projects', { ...CHARTER, name: 'Features project', budget: '£2,000' });
    assert.equal(np.budget, 2000, 'budget parsed');
    const meeting = await call('POST', '/notes', { project_id: np.id,
      body: 'Kick-off meeting\n[ ] Chase finance for data !high @2026-10-20\n- [ ] Book room *weekly\n[x] already done\nplain line' });
    assert.equal(meeting.created_tasks.length, 2, 'two checklist lines became tasks');
    assert.match(meeting.body, /\[→ task\] Chase finance/, 'line marked as converted');
    const chase = meeting.created_tasks.find((t) => t.title === 'Chase finance for data');
    assert.equal(chase.priority, 3);
    assert.equal(new Date(chase.due_at).getDate(), 20);
    const room = meeting.created_tasks.find((t) => t.title === 'Book room');
    assert.equal(room.recurrence, 'weekly', '*weekly sets recurrence');
    const subNote = await call('POST', '/notes', { task_id: chase.id, body: '[ ] Get Sept export' });
    assert.equal(subNote.created_tasks[0].parent_id, chase.id, 'note on a task creates subtasks');

    // ---- Waiting on
    const w = await call('PATCH', `/tasks/${chase.id}`, { waiting_on: '  Finance ' });
    assert.equal(w.waiting_on, 'Finance');
    assert.ok(w.waiting_since, 'waiting_since stamped');
    const w2 = await call('PATCH', `/tasks/${chase.id}`, { title: 'Chase finance for Sept data' });
    assert.equal(w2.waiting_since, w.waiting_since, 'waiting_since kept while still waiting on the same person');
    assert.ok((await call('GET', '/dashboard')).waiting.some((t) => t.id === chase.id), 'dashboard waiting list');
    assert.deepEqual(await call('GET', '/tasks/waiting-names'), ['Finance']);
    await assert.rejects(call('PATCH', `/tasks/${chase.id}`, { start_date: '2026-10-25' }), /start date is after/);

    // ---- Recurring tasks
    await call('PATCH', `/tasks/${room.id}`, { due_at: '2026-10-05' });
    await call('POST', '/tasks', { parent_id: room.id, title: 'Send invite' });
    const doneRoom = await call('PATCH', `/tasks/${room.id}`, { status: 'done' });
    assert.ok(doneRoom.next_occurrence, 'next occurrence created');
    const nextDue = new Date(doneRoom.next_occurrence.due_at);
    assert.ok(nextDue > new Date(), 'next occurrence is in the future');
    assert.equal(nextDue.getDay(), new Date(2026, 9, 5).getDay(), 'weekly keeps the weekday');
    const nextDetail = await call('GET', `/tasks/${doneRoom.next_occurrence.id}`);
    assert.equal(nextDetail.subtasks.length, 1, 'subtasks copied to next occurrence');
    await call('PATCH', `/tasks/${room.id}`, { status: 'todo' });
    const again = await call('PATCH', `/tasks/${room.id}`, { status: 'done' });
    assert.equal(again.next_occurrence, null, 'ticking again does not create a duplicate');
    const { nextOccurrence } = require('../src/dates');
    const jan31 = new Date(2031, 0, 31, 23, 59).toISOString();
    assert.equal(nextOccurrence(jan31, 'monthly').due, '2031-02-28', 'monthly clamps to month end');
    const fri = new Date(2031, 0, 3, 23, 59).toISOString(); // a Friday
    assert.equal(nextOccurrence(fri, 'weekdays').due, '2031-01-06', 'weekdays skips the weekend');

    // ---- Dependencies
    const taskA = await call('POST', '/tasks', { project_id: np.id, title: 'A', start_date: '2026-11-02', due_at: '2026-11-04' });
    const taskB = await call('POST', '/tasks', { project_id: np.id, title: 'B' });
    const link = await call('POST', `/tasks/${taskB.id}/dependencies`, { depends_on_id: taskA.id });
    await assert.rejects(call('POST', `/tasks/${taskA.id}/dependencies`, { depends_on_id: taskB.id }), /loop/);
    await assert.rejects(call('POST', `/tasks/${taskA.id}/dependencies`, { depends_on_id: taskA.id }), /400/);
    assert.equal((await call('GET', `/tasks/${taskB.id}`)).depends_on[0].id, taskA.id);
    assert.equal((await call('GET', `/projects/${np.id}`)).links.length, 1);
    await call('DELETE', `/task-links/${link.id}`);

    // ---- Costs
    await call('POST', `/projects/${np.id}/costs`, { description: 'Room hire', amount: '350', spent_on: '2026-10-01' });
    await call('POST', `/projects/${np.id}/costs`, { description: 'Catering', amount: 120.5 });
    await assert.rejects(call('POST', `/projects/${np.id}/costs`, { description: 'x', amount: -1 }), /400/);
    const npd = await call('GET', `/projects/${np.id}`);
    assert.equal(npd.spent, 470.5);
    assert.equal(npd.costs.length, 2);

    // ---- Idea scores
    const scored = await call('POST', '/ideas', { title: 'Scored idea', impact: 5, effort: 1, cost: 300 });
    assert.equal(scored.impact, 5);
    await assert.rejects(call('PATCH', `/ideas/${scored.id}`, { effort: 7 }), /1 to 5/);
    await assert.rejects(call('POST', `/ideas/${scored.id}/escalate`, {}), /Problem definition is required/);
    const esc2 = await call('POST', `/ideas/${scored.id}/escalate`, CHARTER);
    assert.equal(esc2.budget, 300, 'escalated project takes the idea cost as budget');

    // ---- Report
    const rep = await call('GET', `/report?from=${todayKey}&to=${todayKey}`);
    const rp = rep.projects.find((x) => x.id === np.id);
    assert.ok(rp, 'active project in report');
    assert.ok(rp.added.length >= 4 && rp.notes.length === 2, 'report lists added tasks and notes');
    assert.ok(rp.completed.some((t) => t.id === room.id), 'report lists completed tasks');
    assert.ok(rp.waiting.some((t) => t.id === chase.id), 'report lists waiting items');
    assert.ok(rep.ideas.raised.some((i) => i.id === scored.id), 'report lists new ideas');
    await assert.rejects(call('GET', '/report?from=2026-10-10&to=2026-10-01'), /400/);

    // ---- Excel export
    for (const q of ['', `?scope=project&id=${np.id}`, '?scope=ideas']) {
      const r = await fetch(`${BASE}/export.xlsx${q}`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /spreadsheetml/);
      const buf = Buffer.from(await r.arrayBuffer());
      assert.equal(buf.readUInt32LE(0), 0x04034b50, 'xlsx is a zip');
      assert.ok(buf.includes('xl/worksheets/sheet1.xml'));
    }

    // ---- Opening a path is validated (and only works on Windows)
    await assert.rejects(call('POST', '/open-path', { path: 'relative\\path' }), /400/);

    // ---- Project charter
    await assert.rejects(call('POST', '/projects', { name: 'No charter' }), /Problem definition is required/);
    await assert.rejects(call('POST', '/projects', { ...CHARTER, name: 'x', leader: ' ' }), /Project leader is required/);
    const cp = await call('POST', '/projects', { ...CHARTER, name: 'Charter project', category: 'Cost', baseline_tasks: ['Phase 1'] });
    assert.match(cp.project_code, /^PRJ-\d{4}$/, 'default project ID');
    await assert.rejects(call('PATCH', `/projects/${cp.id}`, { goals: '' }), /Goals of the project is required/);
    await call('PATCH', `/projects/${cp.id}`, { project_code: 'CI-2026-07', in_scope: 'Tier 1' });
    const member = await call('POST', `/projects/${cp.id}/team`, { name: 'Alex', role: 'Analyst', capacity: '20%' });
    await call('PATCH', `/team/${member.id}`, { capacity: '30%' });
    await call('POST', `/projects/${cp.id}/kpis`, { name: 'Spend', unit: '£k', baseline: '2400', target: '2280' });
    let cpd = await call('GET', `/projects/${cp.id}`);
    assert.equal(cpd.charter.team[0].capacity, '30%');
    assert.equal(cpd.charter.kpis.length, 1);
    assert.ok(cpd.charter.completeness.pct > 50 && cpd.charter.completeness.pct < 100, 'partial charter');
    assert.ok(cpd.charter.completeness.missing.includes('Out of scope'));
    assert.ok((await call('GET', '/projects')).find((x) => x.id === cp.id).charter_pct > 0);
    // pick-lists: renaming an item updates projects using it
    const cat = await call('POST', '/lookups', { list: 'category', name: 'Cost' });
    await call('PATCH', `/lookups/${cat.id}`, { name: 'Cost reduction' });
    assert.equal((await call('GET', `/projects/${cp.id}`)).category, 'Cost reduction');
    assert.equal((await call('GET', '/lookups')).category[0].used, 1);

    // ---- Standalone tasks
    const st = await call('POST', '/tasks', { title: 'Renew parking permit', due_at: todayKey });
    assert.equal(st.project_id, null, 'task without a project');
    const stNote = await call('POST', '/notes', { task_id: st.id, body: 'Form is on the intranet\n[ ] Print form' });
    assert.equal(stNote.created_tasks[0].parent_id, st.id, 'subtask from a note on a standalone task');
    assert.ok((await call('GET', '/tasks?standalone=1')).some((t) => t.id === st.id));
    // Quick note that starts a new task: standalone, or inside a project.
    const nn = await call('POST', '/notes', { new_task: { title: 'Book van hire !high @tomorrow' }, body: 'Quote from Hertz\n[ ] Confirm dates' });
    assert.equal(nn.task.title, 'Book van hire');
    assert.equal(nn.task.priority, 3);
    assert.ok(nn.task.due_at, 'due date from quick syntax');
    assert.equal(nn.task.project_id, null, 'new task from a note needs no project');
    assert.equal(nn.task_id, nn.task.id, 'note sits on the new task');
    assert.equal(nn.created_tasks[0].parent_id, nn.task.id, '[ ] lines become its subtasks');
    assert.equal((await call('GET', `/tasks/${nn.task.id}`)).notes[0].body.split('\n')[0], 'Quote from Hertz');
    const np2 = await call('POST', '/notes', { new_task: { title: 'Ask IT for access', project_id: cp.id }, body: 'Ticket raised' });
    assert.equal(np2.task.project_id, cp.id);
    assert.equal(np2.project_id, cp.id);
    await assert.rejects(call('POST', '/notes', { new_task: { title: '  ' }, body: 'x' }), /needs a title/);
    await assert.rejects(call('POST', '/notes', { body: 'nowhere' }), /Choose a task/);
    assert.ok((await call('GET', '/dashboard')).recent_notes.some((n) => n.task_id === nn.task.id && n.project_id === null));
    await call('DELETE', `/tasks/${np2.task.id}`);
    assert.ok((await call('GET', '/dashboard')).today.some((t) => t.id === st.id), 'standalone tasks on the dashboard');
    assert.ok((await call('GET', `/report?from=${todayKey}&to=${todayKey}`)).standalone.added.some((t) => t.id === st.id));
    await assert.rejects(call('POST', `/tasks/${st.id}/dependencies`, { depends_on_id: taskA.id }), /tasks in projects/);
    // move into a project and back out
    await call('PATCH', `/tasks/${st.id}`, { project_id: cp.id });
    cpd = await call('GET', `/projects/${cp.id}`);
    assert.ok(cpd.tasks.some((t) => t.id === st.id && !t.is_baseline), 'moved in as new scope');
    assert.equal(cpd.tasks.find((t) => t.title === 'Print form').project_id, cp.id, 'subtasks move too');
    await call('PATCH', `/tasks/${st.id}`, { project_id: null });
    assert.ok((await call('GET', '/tasks?standalone=1')).some((t) => t.id === st.id), 'moved back out');
    // promote to a project: charter required, subtasks and notes move across
    await assert.rejects(call('POST', `/tasks/${st.id}/promote`, {}), /required/);
    const promoted = await call('POST', `/tasks/${st.id}/promote`, CHARTER);
    assert.equal(promoted.name, 'Renew parking permit');
    const pd = await call('GET', `/projects/${promoted.id}`);
    assert.deepEqual(pd.tasks.map((t) => t.title), ['Print form'], 'subtasks became project tasks');
    const ptl = await call('GET', `/projects/${promoted.id}/timeline`);
    assert.ok(ptl.some((i) => i.type === 'note' && /Promoted from the task/.test(i.body)));
    assert.ok(ptl.some((i) => i.type === 'note' && /Form is on the intranet/.test(i.body)), 'task notes moved');
    assert.equal((await fetch(`${BASE}/tasks/${st.id}`)).status, 404, 'the promoted task is gone');

    const { buildXlsx, readZip } = require('../src/xlsx');
    // ---- Project team: entered with the new project, contact details, Team sheet in the export
    const tp = await call('POST', '/projects', { name: 'Team test', ...CHARTER,
      team: 'Sam Patel, Quality engineer\nAlex Jones - Maintenance\n\nRiya' });
    let tdet = await call('GET', `/projects/${tp.id}`);
    assert.deepEqual(tdet.charter.team.map((m) => [m.name, m.role]),
      [['Sam Patel', 'Quality engineer'], ['Alex Jones', 'Maintenance'], ['Riya', null]], 'team lines parsed');
    await call('PATCH', `/team/${tdet.charter.team[0].id}`, { contact: 'sam@example.com', capacity: '20%' });
    await call('POST', '/tasks', { project_id: tp.id, title: 'Measure', owner: 'sam patel' });
    tdet = await call('GET', `/projects/${tp.id}`);
    assert.equal(tdet.charter.team[0].contact, 'sam@example.com');
    const txl = readZip(Buffer.from(await (await fetch(`${BASE}/export.xlsx?scope=project&id=${tp.id}`)).arrayBuffer()));
    assert.match(txl['xl/workbook.xml'].toString(), /name="Team"/, 'Team sheet in the export');
    const teamSheet = Object.entries(txl).find(([k, v]) => /worksheets\/sheet\d+\.xml$/.test(k) && v.toString().includes('sam@example.com'));
    assert.ok(teamSheet, 'contact in the Team sheet');
    assert.match(teamSheet[1].toString(), /<c r="G2"[^>]*><v>1<\/v>/, 'open tasks counted by owner name (any case)');
    assert.ok((await call('GET', `/tasks/owner-names?project_id=${tp.id}`)).slice(0, 3).includes('Riya'), 'team offered as owners');
    await call('DELETE', `/projects/${tp.id}`);

    // ---- Attachments on tasks and meetings
    const attTask = await call('POST', '/tasks', { title: 'With files' });
    const attUpload = (url, body, name) => fetch(`${BASE}${url}`, { method: 'POST', body,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(name) } });
    const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    let attUp = await attUpload(`/tasks/${attTask.id}/attachments`, pngBytes, 'Screenshot é 1.png');
    assert.equal(attUp.status, 201);
    const shot = await attUp.json();
    assert.deepEqual([shot.name, shot.mime, shot.size], ['Screenshot é 1.png', 'image/png', pngBytes.length]);
    attUp = await attUpload(`/tasks/${attTask.id}/attachments`, Buffer.from('<script>alert(1)</script>'), 'evil.html');
    const evil = await attUp.json();
    assert.equal((await attUpload(`/tasks/${attTask.id}/attachments`, Buffer.alloc(0), 'empty.txt')).status, 400, 'empty upload refused');
    let attGot = await fetch(`${BASE}/attachments/${shot.id}/file`);
    assert.equal(attGot.headers.get('content-type'), 'image/png');
    assert.match(attGot.headers.get('content-disposition'), /^inline/);
    assert.ok(Buffer.from(await attGot.arrayBuffer()).equals(pngBytes), 'same bytes back');
    attGot = await fetch(`${BASE}/attachments/${evil.id}/file`);
    assert.match(attGot.headers.get('content-disposition'), /^attachment/, 'html downloads instead of opening');
    assert.equal((await call('GET', `/tasks/${attTask.id}`)).attachments.length, 2);
    assert.equal((await call('GET', '/tasks?standalone=1')).find((x) => x.id === attTask.id).attachment_count, 2);
    assert.equal((await call('PATCH', `/attachments/${shot.id}`, { name: 'Panel.png' })).name, 'Panel.png');
    const attMeeting = await call('POST', '/meetings', { task_id: attTask.id, title: 'Review', held_at: new Date().toISOString() });
    attUp = await attUpload(`/meetings/${attMeeting.id}/attachments`, Buffer.from('a,b\n1,2'), 'data.csv');
    assert.equal(attUp.status, 201);
    assert.equal((await call('GET', `/meetings/${attMeeting.id}`)).attachments[0].name, 'data.csv');
    // backups copy the files; deleted ones are cleared from the live folder but stay in the backup copy
    await call('DELETE', `/attachments/${evil.id}`);
    await call('POST', '/backups');
    const attFiles = fs.readdirSync(path.join(tmp, 'attachments'));
    assert.equal(attFiles.length, 2, 'unused file removed from the live folder');
    assert.equal(fs.readdirSync(path.join(tmp, 'backups', 'files')).length, 3, 'all files copied to the backups folder');
    fs.rmSync(path.join(tmp, 'attachments', attFiles.find((f) => f.endsWith('Screenshot_1.png') || f.includes('Screenshot'))));
    assert.equal((await fetch(`${BASE}/attachments/${shot.id}/file`)).status, 200, 'served from the backup copy when missing');
    await call('DELETE', `/tasks/${attTask.id}`);
    assert.equal((await fetch(`${BASE}/attachments/${shot.id}/file`)).status, 404, 'attachments go with their task');

    // ---- Library: an Obsidian vault imported read-only
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const vault = [
      { path: 'Procedures/Lockout.md', text: '---\ntags: [safety]\naliases: [LOTO]\n---\n# Lockout\n> [!warning] Isolate first\n> Use [[Isolation points#Main valve|the valve]].\n\n- [x] Sign sheet\n![[diagram.png|200]]\n<script>alert(1)</script>' },
      { path: 'Reference/Isolation points.md', text: '## Main valve\nTurn **clockwise**. Back to [[LOTO]].' },
      { path: 'Old.md', text: 'to be removed' },
      { path: 'attachments/diagram.png', base64: png },
      { path: '.obsidian/app.json', base64: 'e30=' },
      { path: '../escape.png', base64: png },
      { path: 'tool.exe', base64: png },
    ];
    let lib = await call('POST', '/library/import', { source: 'Work vault' });
    const sent = await call('POST', `/library/import/${lib.id}/files`, { files: vault });
    assert.deepEqual([sent.notes, sent.files, sent.skipped], [3, 1, 3], 'hidden, unsafe and unknown files skipped');
    let res = await call('POST', `/library/import/${lib.id}/finish`);
    assert.deepEqual([res.added, res.removed], [3, 0]);
    let index = await call('GET', '/library');
    assert.equal(index.source, 'Work vault');
    const lock = index.docs.find((d) => d.title === 'Lockout');
    const iso = index.docs.find((d) => d.title === 'Isolation points');
    assert.equal(lock.tags, 'safety');
    const page = await call('GET', `/library/docs/${lock.id}`);
    assert.match(page.html, /class="callout callout-warning"/, 'callout');
    assert.match(page.html, new RegExp(`href="#/library/${iso.id}/main-valve"[^>]*>the valve<`), 'wikilink to a heading, with alias');
    assert.match(page.html, /<img class="md-img" src="\/api\/library\/file\?p=attachments%2Fdiagram\.png"[^>]*width="200"/, 'embedded image by name');
    assert.match(page.html, /<input type="checkbox" disabled checked>/, 'read-only checklist');
    assert.ok(!page.html.includes('<script'), 'raw script escaped');
    assert.deepEqual(page.backlinks.map((b) => b.title), ['Isolation points'], 'backlink via alias');
    const img = await fetch(`${BASE}/library/file?p=${encodeURIComponent('attachments/diagram.png')}`);
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${BASE}/library/file?p=..%2F..%2Ftest.db`)).status, 404, 'no way out of the library folder');
    assert.equal((await call('GET', '/library/resolve?t=loto%23Main%20valve')).id, lock.id, 'resolve by alias');
    assert.equal((await call('GET', '/library/search?q=clockwise'))[0].id, iso.id);
    assert.ok((await call('GET', '/search?q=isolate')).library.some((d) => d.id === lock.id), 'library in the global search');
    // a task linking a procedure shows up on the note
    const libTask = await call('POST', '/tasks', { title: 'Service pump', description: 'Follow [[Lockout]] first' });
    assert.equal((await call('GET', `/library/docs/${lock.id}`)).linked_tasks[0].id, libTask.id, 'used in tasks');
    await call('DELETE', `/tasks/${libTask.id}`);
    // column widths set by dragging: saved per table, kept across re-imports, reset with null
    assert.deepEqual(page.col_widths, {});
    await assert.rejects(call('PATCH', `/library/docs/${lock.id}/widths`, { table: 0, widths: [5, 100] }), /20–4000/);
    await call('PATCH', `/library/docs/${lock.id}/widths`, { table: 1, widths: [120.4, 300] });
    assert.deepEqual((await call('GET', `/library/docs/${lock.id}`)).col_widths, { 1: { cols: 2, widths: [120, 300] } });
    // re-import: changed, unchanged, removed; ids kept
    lib = await call('POST', '/library/import', { source: 'Work vault' });
    await call('POST', `/library/import/${lib.id}/files`, { files: [{ ...vault[0], text: `${vault[0].text}\nNew line` }, vault[1]] });
    res = await call('POST', `/library/import/${lib.id}/finish`);
    assert.deepEqual([res.added, res.updated, res.unchanged, res.removed], [0, 1, 1, 1]);
    index = await call('GET', '/library');
    assert.equal(index.docs.find((d) => d.title === 'Lockout').id, lock.id, 'same note keeps its id');
    assert.deepEqual((await call('GET', `/library/docs/${lock.id}`)).col_widths[1].widths, [120, 300], 'widths kept after re-import');
    assert.deepEqual(await call('PATCH', `/library/docs/${lock.id}/widths`, { table: 1, widths: null }), {}, 'reset');
    assert.equal(index.files, 0, 'attachments replaced by the new import');
    // removing a note or folder keeps it out of later imports until included again
    const vault2 = [vault[0], vault[1], { path: 'Reference/Sub/Deep.md', text: 'deep' }, { path: 'Reference/pic.png', base64: png }];
    const importAll = async (files) => {
      const imp = await call('POST', '/library/import', { source: 'Work vault' });
      await call('POST', `/library/import/${imp.id}/files`, { files });
      return call('POST', `/library/import/${imp.id}/finish`);
    };
    await importAll(vault2);
    index = await call('GET', '/library');
    await call('DELETE', `/library/docs/${index.docs.find((d) => d.title === 'Lockout').id}`);
    const delFolder = await call('DELETE', '/library/folder?path=Reference');
    assert.equal(delFolder.removed, 2, 'folder removal includes sub-folders');
    index = await call('GET', '/library');
    assert.equal(index.docs.length, 0);
    assert.deepEqual(index.excluded, ['Procedures/Lockout.md', 'Reference/']);
    res = await importAll(vault2);
    assert.deepEqual([res.notes, res.left_out], [0, 4], 'removed note and folder left out of the update');
    await call('POST', '/library/excluded/remove', { path: 'Reference/' });
    res = await importAll(vault2);
    assert.deepEqual([res.notes, res.left_out], [2, 1], 'included again');
    await assert.rejects(call('DELETE', '/library/folder?path=..'), /Which folder/);
    lib = await call('POST', '/library/import', {});
    await assert.rejects(call('POST', `/library/import/${lib.id}/finish`), /No notes/);
    await call('DELETE', '/library');
    assert.equal((await call('GET', '/library')).docs.length, 0);

    // Sheets Extended tables: merges, vertical headers, ~ styles, ```sheet blocks
    const { renderMarkdown } = require('../src/markdown');
    const sx = (src) => renderMarkdown(src).html;
    let t = sx('| A | B | C |\n|---|---|---|\n| x | < | y |\n| z | w | ^ |\n| p | < | < |\n| ^ | < | < |');
    assert.match(t, /<td colspan="2">x<\/td><td rowspan="2">y<\/td>/, 'merge left and up');
    assert.match(t, /<tr><td>z<\/td><td>w<\/td><\/tr>/, 'merged cells are not drawn');
    assert.match(t, /<td colspan="3" rowspan="2">p<\/td><\/tr><tr><\/tr>/, 'merges stack into a rectangle');
    t = sx('| I | - | h |\n|---|---|---|\n| r1 | - | 1 |');
    assert.match(t, /<th class="sx-row-head">r1<\/th><td>1<\/td>/, 'all-dash column makes row headers and is hidden');
    t = sx('| a | b |\n|---|---|\n| x ~ { "text-align": "right" } | ~~s~~ \\~ y |\n| q ~ { background: "url(e)" } | <script> |');
    assert.match(t, /<td style="text-align: right">x<\/td><td><del>s<\/del> ~ y<\/td>/, 'inline style; strike and \\~ kept');
    assert.match(t, /<td>q<\/td><td>&lt;script&gt;<\/td>/, 'unsafe css dropped, html escaped');
    t = sx("```sheet\n{ classes: { hot: { backgroundColor: 'orange' } } }\n--- ~ { color: 'red' }\n| H | x |\n| - | -: ~ .hot |\n| a | b |\n```");
    assert.match(t, /<td style="color: red; text-align: right; background-color: orange">b<\/td>/, 'sheet block: table, column and class styles');
    assert.match(sx('```sheet\n{ bad\n---\n| a |\n```'), /md-sheet-error/, 'bad metadata reported');
    assert.match(sx('---\ndisable-sheet: true\n---\n| a | b |\n|---|---|\n| x | < |'), /<td>&lt;<\/td>/, 'disable-sheet respected');

    // ---- Several owners per task; People & departments lists
    const ownP = await call('POST', '/projects', { name: 'Owners test', ...CHARTER, team: 'Sam Patel, QA' });
    const ot = await call('POST', '/tasks', { project_id: ownP.id, title: 'Shared job', owner: ' Sam Patel ;Maintenance, sam patel,, ' });
    assert.equal(ot.owner, 'Sam Patel, Maintenance', 'owners trimmed, split and de-duplicated');
    assert.equal((await call('PATCH', `/tasks/${ot.id}`, { owner: ['Alex', 'Maintenance'] })).owner, 'Alex, Maintenance', 'owners as a list');
    assert.equal((await call('PATCH', `/tasks/${ot.id}`, { owner: '' })).owner, null);
    await call('PATCH', `/tasks/${ot.id}`, { owner: 'Sam Patel, Maintenance' });
    const lists = await call('GET', '/name-lists');
    assert.deepEqual(lists.map((l) => l.name), ['People', 'Departments'], 'starting lists');
    const depts = lists[1];
    await call('POST', `/name-lists/${depts.id}/items`, { name: 'Maintenance', detail: 'Ext 2201' });
    const bulk = await call('POST', `/name-lists/${depts.id}/items`, { names: 'Quality\nmaintenance\n\nLogistics; Stores' });
    assert.deepEqual([bulk.added, bulk.skipped], [2, 1], 'bulk add skips names already there (any case)');
    await assert.rejects(call('POST', `/name-lists/${depts.id}/items`, { name: 'quality' }), /already in this list/);
    await assert.rejects(call('POST', '/name-lists', { name: 'people' }), /already a list/);
    let dl = (await call('GET', '/name-lists')).find((l) => l.id === depts.id);
    assert.deepEqual(dl.items.map((i) => i.name), ['Maintenance', 'Quality', 'Logistics Stores']);
    assert.equal(dl.items[0].open_tasks, 1, 'open tasks counted for a name among several owners');
    const opts = await call('GET', `/owner-options?project_id=${ownP.id}`);
    assert.deepEqual([opts[0].label, opts[0].names], ['Project team', ['Sam Patel', 'J. Smith']]);
    assert.equal(opts[0].details['J. Smith'], 'Management sponsor', 'details shown in the contacts book');
    const teamsBook = await call('GET', '/contacts/teams');
    assert.ok(teamsBook.some((x) => x.name === 'Sam Patel' && x.projects.some((pr) => pr.id === ownP.id)), 'who is on which project team');
    assert.ok(opts.some((g) => g.label === 'Departments' && g.names.includes('Quality')), 'lists offered as owners');
    assert.ok(!opts.some((g) => g.label === 'People'), 'empty lists left out');
    assert.ok(!(opts.find((g) => g.label === 'Used before')?.names || []).some((n) => /maintenance|sam patel/i.test(n)), 'no repeats in Used before');
    // rename on open tasks, deactivate, delete
    const doneOt = await call('POST', '/tasks', { project_id: ownP.id, title: 'Old job', owner: 'Maintenance', status: 'done' });
    const renM = await call('POST', '/meetings', { project_id: ownP.id, title: 'Rename', held_at: new Date().toISOString(), attendees: 'Sam Patel, Maintenance' });
    const ren = await call('PATCH', `/name-list-items/${dl.items[0].id}`, { name: 'Engineering' });
    assert.equal(ren.renamed_tasks, 2, 'a rename always reaches every task, done ones too');
    assert.equal((await call('GET', `/tasks/${doneOt.id}`)).owner, 'Engineering');
    assert.equal((await call('GET', `/meetings/${renM.id}`)).attendees, 'Sam Patel, Engineering', 'and meeting attendees');
    assert.equal((await call('GET', `/tasks/${ot.id}`)).owner, 'Sam Patel, Engineering', 'renamed on the task');
    // departments for people
    const peopleL = lists[0];
    await call('POST', `/name-lists/${peopleL.id}/items`, { name: 'Sam Patel', detail: 'Fitter', department: ' Engineering ' });
    await call('POST', `/name-lists/${peopleL.id}/items`, { name: 'Jo Bloggs' });
    let nl = await call('GET', '/name-lists');
    const jo = nl[0].items.find((i) => i.name === 'Jo Bloggs');
    assert.equal((await call('PATCH', `/name-list-items/${jo.id}`, { department: 'engineering' })).department, 'engineering');
    await call('POST', '/tasks', { project_id: ownP.id, title: 'Jo job', owner: 'Jo Bloggs' });
    await call('POST', '/tasks', { project_id: ownP.id, title: 'Done job', owner: 'Jo Bloggs', status: 'done' });
    nl = await call('GET', '/name-lists');
    assert.deepEqual(nl.map((l) => l.departments), [false, true], 'the Departments list is recognised');
    const eng = nl[1].items.find((i) => i.name === 'Engineering');
    assert.deepEqual([eng.members, eng.open_tasks, eng.dept_open_tasks], [['Sam Patel', 'Jo Bloggs'], 1, 2], 'department rolls up its people\'s open tasks');
    const dOpts = await call('GET', `/owner-options?project_id=${ownP.id}`);
    assert.equal(dOpts.find((g) => g.label === 'People').departments['Sam Patel'], 'Engineering', 'department alongside a person');
    assert.equal(dOpts.find((g) => g.label === 'People').details['Sam Patel'], 'Fitter', 'details kept separate');
    assert.equal(dOpts[0].departments['Sam Patel'], 'Engineering', 'project team picks up the department by name');
    assert.deepEqual(dOpts.find((g) => g.label === 'Departments').members.Engineering, ['Jo Bloggs', 'Sam Patel'], 'who is in each department');
    const moved = await call('PATCH', `/name-list-items/${eng.id}`, { name: 'Maint Eng' });
    assert.equal(moved.moved_people, 2, 'renaming a department moves its people');
    assert.deepEqual((await call('GET', '/name-lists'))[0].items.map((i) => i.department), ['Maint Eng', 'Maint Eng']);
    assert.equal((await call('GET', `/projects/${ownP.id}`)).charter.team[0].department, 'Maint Eng', 'team member shows the department');
    assert.equal((await call('GET', '/contacts/teams')).find((x) => x.name === 'Sam Patel').department, 'Maint Eng');
    await assert.rejects(call('DELETE', `/name-list-items/${eng.id}`), /2 people are in Maint Eng/, 'a department with people stays');
    await assert.rejects(call('PATCH', `/name-lists/${depts.id}`, { name: 'Teams' }), /can't be renamed/);
    await assert.rejects(call('PATCH', `/name-lists/${peopleL.id}`, { name: 'Staff' }), /built in/, 'People keeps its name');
    await assert.rejects(call('DELETE', `/name-lists/${peopleL.id}`), /built in/);
    assert.deepEqual((await call('GET', '/name-lists')).map((l) => l.fixed), [true, true]);
    // renaming a person carries through to the project team, leader and sponsor
    const samItem = (await call('GET', '/name-lists'))[0].items.find((i) => i.name === 'Sam Patel');
    await call('PATCH', `/projects/${ownP.id}`, { sponsor: 'sam patel' });
    await call('PATCH', `/tasks/${ot.id}`, { waiting_on: 'Sam Patel, Purchasing' });
    await call('PATCH', `/name-list-items/${samItem.id}`, { name: 'Samuel Patel' });
    assert.equal((await call('GET', `/tasks/${ot.id}`)).waiting_on, 'Samuel Patel, Purchasing', 'and the people a task is waiting on');
    await call('PATCH', `/tasks/${ot.id}`, { waiting_on: null });
    const renP = await call('GET', `/projects/${ownP.id}`);
    assert.deepEqual([renP.charter.team[0].name, renP.sponsor], ['Samuel Patel', 'Samuel Patel'], 'team and sponsor renamed');
    assert.equal((await call('GET', `/tasks/${ot.id}`)).owner, 'Samuel Patel, Maint Eng');
    await call('PATCH', `/name-list-items/${samItem.id}`, { name: 'Sam Patel' });
    await call('PATCH', `/projects/${ownP.id}`, { sponsor: 'J. Smith' });
    await call('PATCH', `/name-list-items/${jo.id}`, { department: '' });
    assert.equal((await call('GET', '/name-lists'))[0].items[1].department, null, 'department cleared');
    await call('PATCH', `/name-list-items/${dl.items[1].id}`, { active: false });
    assert.ok(!(await call('GET', '/owner-options')).some((g) => g.names.includes('Quality')), 'inactive names not offered');
    await assert.rejects(call('DELETE', `/name-lists/${depts.id}`), /can't be renamed or deleted/, 'the Departments list stays');
    const sup = await call('POST', '/name-lists', { name: 'Suppliers' });
    await call('POST', `/name-lists/${sup.id}/items`, { name: 'Engineering' });
    await assert.rejects(call('PATCH', `/name-lists/${sup.id}`, { name: 'people' }), /already a list called/);
    assert.equal((await call('PATCH', `/name-lists/${sup.id}`, { name: 'Vendors' })).name, 'Vendors', 'own lists can be renamed');
    await call('DELETE', `/name-lists/${sup.id}`);
    assert.equal((await call('GET', '/name-lists')).length, 2);
    assert.equal((await call('GET', `/tasks/${ot.id}`)).owner, 'Sam Patel, Maint Eng', 'deleting a list leaves task owners alone');
    // meeting actions and the export's team counts handle several owners
    const om = await call('POST', '/meetings', { project_id: ownP.id, title: 'Owners', held_at: new Date().toISOString() });
    assert.equal((await call('POST', `/meetings/${om.id}/actions`, { title: 'Both of you', owner: 'Sam Patel; Alex' })).owner, 'Sam Patel, Alex');
    const oxl = readZip(Buffer.from(await (await fetch(`${BASE}/export.xlsx?scope=project&id=${ownP.id}`)).arrayBuffer()));
    const oTeam = Object.entries(oxl).find(([k, v]) => /worksheets\/sheet\d+\.xml$/.test(k) && v.toString().includes('>QA<'));
    assert.match(oTeam[1].toString(), /<c r="G2"[^>]*><v>2<\/v>/, 'team member counted on tasks shared with others');
    assert.match(oTeam[1].toString(), /<c r="D2"[^>]*><is><t[^>]*>Maint Eng</, 'Team sheet has the department');
    await call('DELETE', `/projects/${ownP.id}`);

    // ---- Reordering: within one list only, keeping the places of tasks not shown
    const ordP = await call('POST', '/projects', { name: 'Reorder test', ...CHARTER });
    const ordT = [];
    for (const title of ['A', 'B', 'C', 'D']) ordT.push(await call('POST', '/tasks', { project_id: ordP.id, title }));
    const titles = async () => (await call('GET', `/projects/${ordP.id}`)).tasks.filter((t) => !t.parent_id)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map((t) => t.title).join('');
    await call('POST', '/tasks/reorder', { ids: [ordT[3].id, ordT[0].id] });
    assert.equal(await titles(), 'DBCA', 'D and A swap places; B and C stay put');
    await call('POST', '/tasks/reorder', { ids: [ordT[2].id, ordT[1].id, ordT[3].id, ordT[0].id] });
    assert.equal(await titles(), 'CBDA');
    const ordS = [];
    for (const title of ['x', 'y', 'z']) ordS.push(await call('POST', '/tasks', { parent_id: ordT[0].id, title }));
    await call('POST', '/tasks/reorder', { ids: [ordS[2].id, ordS[0].id, ordS[1].id] });
    assert.deepEqual((await call('GET', `/tasks/${ordT[0].id}`)).subtasks.map((t) => t.title), ['z', 'x', 'y'], 'subtasks reordered');
    await assert.rejects(call('POST', '/tasks/reorder', { ids: [ordS[0].id, ordT[1].id] }), /same list/);
    await assert.rejects(call('POST', '/tasks/reorder', { ids: [ordT[1].id, ordT[1].id] }), /once/);
    await assert.rejects(call('POST', '/tasks/reorder', { ids: [999999] }), /not found/i);
    const ordLone = await call('POST', '/tasks', { title: 'Standalone one' });
    await assert.rejects(call('POST', '/tasks/reorder', { ids: [ordT[1].id, ordLone.id] }), /same list/, 'project and standalone lists are separate');
    await call('DELETE', `/tasks/${ordLone.id}`);
    assert.ok(!(await call('GET', `/projects/${ordP.id}/timeline`)).some((i) => /sort/i.test(i.text || '')), 'reordering is not timeline noise');
    await call('DELETE', `/projects/${ordP.id}`);

    // ---- Meetings: on a project or a task, formatted notes, actions that become tasks
    const { sanitizeHtml, htmlToText } = require('../src/richtext');
    assert.equal(sanitizeHtml('<b>Bold</b> <u>u</u> <i>i</i> <span style="background-color: rgb(255, 241, 118);">hi</span>'),
      '<b>Bold</b> <u>u</u> <i>i</i> <mark>hi</mark>', 'supported formats kept; highlight becomes <mark>');
    assert.equal(sanitizeHtml('<p onclick="x()">a<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:x">link</a></p>'),
      '<p>alink</p>', 'scripts, attributes, images and links removed');
    assert.equal(sanitizeHtml('<ul><li>one<li>two</ul><b>unclosed'), '<ul><li>one<li>two</li></li></ul><b>unclosed</b>', 'tags balanced');
    assert.equal(sanitizeHtml('x < y & "z"'), 'x &lt; y &amp; &quot;z&quot;');
    assert.equal(sanitizeHtml('<div><br></div>'), '', 'an empty editor saves as empty');
    assert.equal(sanitizeHtml('<span style="background-color: transparent">plain</span>'), 'plain', 'cleared highlight');
    assert.equal(htmlToText('<b>Agenda</b><ul><li>Costs</li><li>Plan &amp; dates</li></ul><ol><li>a</li><li>b</li></ol>'),
      'Agenda\n• Costs\n• Plan & dates\n\n1. a\n2. b');
    const mp = await call('POST', '/projects', { name: 'Meeting test', ...CHARTER });
    // Calendar: meetings without a project, durations, a date range
    const calLone = await call('POST', '/meetings', { title: 'Team catch-up', held_at: '2026-10-05T08:00:00Z', duration_min: 30 });
    assert.deepEqual([calLone.project_id, calLone.task_id, calLone.duration_min], [null, null, 30], 'meeting of its own');
    assert.equal((await call('POST', '/meetings', { title: 'Default', held_at: '2026-10-06T08:00:00Z' })).duration_min, 60);
    await assert.rejects(call('PATCH', `/meetings/${calLone.id}`, { duration_min: 2 }), /between 5 minutes/);
    assert.equal((await call('POST', `/meetings/${calLone.id}/actions`, { title: 'Book room' })).project_id, null, 'its actions are standalone tasks');
    const week = await call('GET', '/meetings?from=2026-10-05T00:00:00Z&to=2026-10-06T00:00:00Z');
    assert.deepEqual(week.map((m) => m.title), ['Team catch-up'], 'range query');
    for (const m of await call('GET', '/meetings?from=2026-10-05T00:00:00Z&to=2026-10-07T00:00:00Z')) await call('DELETE', `/meetings/${m.id}`);
    await assert.rejects(call('POST', '/meetings', { project_id: mp.id, title: 'x' }), /date and time/);
    await assert.rejects(call('POST', '/meetings', { project_id: mp.id, title: 'x', held_at: 'soon' }), /Invalid meeting date/);
    const mt = await call('POST', '/meetings', { project_id: mp.id, title: 'Kick-off', held_at: '2026-09-29T09:00:00Z',
      attendees: 'Sam, Alex', notes: '<b>Scope</b> agreed<script>x</script>' });
    assert.equal(mt.notes, '<b>Scope</b> agreed', 'notes cleaned on save');
    const act = await call('POST', `/meetings/${mt.id}/actions`, { title: 'Send quote !high', owner: 'Sam', due_at: '2026-10-09' });
    assert.equal(act.project_id, mp.id); assert.equal(act.meeting_id, mt.id); assert.equal(act.priority, 3);
    assert.equal(act.owner, 'Sam'); assert.match(act.due_at, /^2026-10-09T/);
    assert.match(act.description, /Agreed at the meeting "Kick-off"/);
    await assert.rejects(call('POST', `/meetings/${mt.id}/actions`, { title: ' ' }), /Action text/);
    // a meeting on a task: actions become its subtasks, and it shows on the project too
    const mtask = await call('POST', '/tasks', { project_id: mp.id, title: 'Supplier review' });
    const tm = await call('POST', '/meetings', { task_id: mtask.id, title: 'Supplier call', held_at: '2026-09-30T14:00:00Z' });
    assert.equal(tm.project_id, mp.id, 'task meeting carries the project');
    const tmAct = await call('POST', `/meetings/${tm.id}/actions`, { title: 'Chase samples' });
    assert.equal(tmAct.parent_id, mtask.id, 'task meeting actions are subtasks');
    const tdetail = await call('GET', `/tasks/${mtask.id}`);
    assert.equal(tdetail.meetings[0].title, 'Supplier call');
    assert.equal((await call('GET', `/tasks/${act.id}`)).meeting.title, 'Kick-off', 'action links back to its meeting');
    await call('PATCH', `/tasks/${act.id}`, { status: 'done' });
    const mlist = await call('GET', `/meetings?project_id=${mp.id}`);
    assert.deepEqual(mlist.map((m) => [m.title, m.action_count, m.actions_done]), [['Supplier call', 1, 0], ['Kick-off', 1, 1]]);
    const upd = await call('PATCH', `/meetings/${mt.id}`, { notes: '<ul><li>Budget</li></ul>', location: 'Room 2' });
    assert.equal(upd.notes, '<ul><li>Budget</li></ul>'); assert.equal(upd.actions.length, 1);
    const mtl = await call('GET', `/projects/${mp.id}/timeline`);
    assert.ok(mtl.some((i) => i.type === 'meeting' && i.title === 'Kick-off'), 'meetings in the project timeline');
    assert.ok(!mtl.some((i) => /Meeting created/.test(i.text || '')), 'no duplicate audit line');
    assert.equal((await call('GET', '/search?q=budget')).meetings[0].id, mt.id, 'search finds note text');
    assert.equal((await call('GET', '/search?q=ul')).meetings.length, 0, 'search ignores the HTML');
    const mrep = await call('GET', `/report?project_id=${mp.id}&from=2026-09-28&to=2026-09-30`);
    assert.equal(mrep.projects[0].meetings.length, 2, 'meetings in the status report');
    const mxl = readZip(Buffer.from(await (await fetch(`${BASE}/export.xlsx?scope=project&id=${mp.id}`)).arrayBuffer()));
    assert.match(mxl['xl/workbook.xml'].toString(), /name="Meetings"/, 'Meetings sheet in the export');
    // deleting a meeting keeps its actions; deleting a project task keeps its meeting on the project
    await call('DELETE', `/meetings/${mt.id}`);
    assert.equal((await call('GET', `/tasks/${act.id}`)).meeting_id, null, 'action kept as a task');
    await call('DELETE', `/tasks/${mtask.id}`);
    assert.equal((await call('GET', `/meetings/${tm.id}`)).task_id, null, 'meeting stays on the project');
    // a standalone task's meeting goes with the task
    const lone = await call('POST', '/tasks', { title: 'Lone task' });
    const lm = await call('POST', '/meetings', { task_id: lone.id, title: '1:1', held_at: new Date().toISOString() });
    assert.equal(lm.project_id, null);
    await call('DELETE', `/tasks/${lone.id}`);
    await assert.rejects(call('GET', `/meetings/${lm.id}`), /not found/i);
    await call('DELETE', `/projects/${mp.id}`);

    // ---- Phases: a project split into milestones
    const pp = await call('POST', '/projects', { name: 'Line upgrade', ...CHARTER });
    const ph1 = await call('POST', `/projects/${pp.id}/phases`, { name: 'Pilot', start_date: '2026-10-01', due_at: '2026-11-30' });
    const ph2 = await call('POST', `/projects/${pp.id}/phases`, { name: 'Roll-out', due_at: '2027-02-28' });
    assert.equal(ph1.sort_order, 0); assert.equal(ph2.sort_order, 1);
    assert.match(ph1.due_at, /^2026-11-30T/, 'phase end stored like a due date');
    await assert.rejects(call('POST', `/projects/${pp.id}/phases`, { name: ' ' }), /name is required/);
    await assert.rejects(call('POST', `/projects/${pp.id}/phases`, { name: 'Bad', start_date: '2026-12-01', due_at: '2026-11-01' }), /starts after/);
    const pt1 = await call('POST', '/tasks', { project_id: pp.id, title: 'Trial run', phase_id: ph1.id });
    const pt2 = await call('POST', '/tasks', { project_id: pp.id, title: 'Train operators' });
    const psub = await call('POST', '/tasks', { parent_id: pt1.id, title: 'Book the line' });
    assert.equal(psub.phase_id, ph1.id, 'subtasks follow their parent\'s phase');
    await assert.rejects(call('PATCH', `/tasks/${psub.id}`, { phase_id: ph2.id }), /follow their parent/);
    await assert.rejects(call('POST', '/tasks', { project_id: cp.id, title: 'x', phase_id: ph1.id }), /different project/);
    await assert.rejects(call('POST', '/tasks', { title: 'x', phase_id: ph1.id }), /different project/);
    await call('PATCH', `/tasks/${pt1.id}`, { phase_id: ph2.id });
    assert.equal((await call('GET', `/tasks/${psub.id}`)).phase_id, ph2.id, 'subtree moves with its task');
    assert.equal((await call('GET', `/tasks/${psub.id}`)).phase_name, 'Roll-out');
    await call('PATCH', `/tasks/${pt1.id}`, { phase_id: ph1.id });
    // a new phase can take over tasks without a phase
    const ph3 = await call('POST', `/projects/${pp.id}/phases`, { name: 'Handover', task_ids: [pt2.id, psub.id] });
    assert.equal(ph3.task_count, 1, 'only top-level tasks are taken over');
    assert.equal((await call('GET', `/tasks/${pt2.id}`)).phase_id, ph3.id);
    await call('POST', `/projects/${pp.id}/phases/order`, { ids: [ph1.id, ph3.id, ph2.id] });
    await assert.rejects(call('POST', `/projects/${pp.id}/phases/order`, { ids: [ph1.id] }), /every phase/);
    let pdet = await call('GET', `/projects/${pp.id}`);
    assert.deepEqual(pdet.charter.phases.map((x) => x.name), ['Pilot', 'Handover', 'Roll-out'], 'reordered');
    assert.equal(pdet.charter.phases[0].task_count, 2, 'phase counts include subtasks');
    // baseline records each phase's end; progress and completion
    await call('POST', `/projects/${pp.id}/baseline`);
    await call('PATCH', `/phases/${ph1.id}`, { due_at: '2026-12-15' });
    pdet = await call('GET', `/projects/${pp.id}`);
    assert.match(pdet.charter.phases[0].baseline_due_at, /^2026-11-30T/, 'baseline end kept when the phase moves');
    assert.equal(pdet.baseline_snapshot.phases.length, 3);
    await call('PATCH', `/tasks/${pt1.id}`, { status: 'done', cascade: true });
    const closed = await call('PATCH', `/phases/${ph1.id}`, { status: 'done' });
    assert.ok(closed.completed_at, 'completion stamped');
    assert.equal(closed.done_count, 2);
    await assert.rejects(call('PATCH', `/phases/${ph1.id}`, { status: 'finished' }), /Invalid phase status/);
    const plist = (await call('GET', '/projects')).find((x) => x.id === pp.id);
    assert.equal(plist.phase_count, 3); assert.equal(plist.phases_done, 1);
    assert.equal(plist.current_phase.name, 'Handover'); assert.equal(plist.current_phase.position, 2);
    const phTimeline = await call('GET', `/projects/${pp.id}/timeline`);
    assert.ok(phTimeline.some((i) => i.text === 'Phase "Pilot" completed ✓'), 'phase completion in the timeline');
    const prep = await call('GET', `/report?project_id=${pp.id}`);
    assert.equal(prep.projects[0].phases.length, 3, 'report includes phases');
    assert.ok(prep.projects[0].due_changes.some((m) => /Phase "Pilot"/.test(m.what)), 'phase date change reported');
    // charter: phases become the sub projects, tasks the actions
    const pwb = readZip(Buffer.from(await (await fetch(`${BASE}/projects/${pp.id}/charter.xlsx`)).arrayBuffer()));
    assert.match(pwb['xl/worksheets/sheet2.xml'].toString(), /Pilot[\s\S]*Handover[\s\S]*Roll-out/, 'phases as sub projects');
    assert.match(pwb['xl/worksheets/sheet3.xml'].toString(), /Train operators/, 'tasks as actions');
    const pxl = readZip(Buffer.from(await (await fetch(`${BASE}/export.xlsx?scope=project&id=${pp.id}`)).arrayBuffer()));
    assert.match(pxl['xl/workbook.xml'].toString(), /name="Phases"/, 'Phases sheet in the export');
    // moving a task to another project drops its phase; deleting a phase keeps its tasks
    await call('PATCH', `/tasks/${pt2.id}`, { project_id: cp.id });
    assert.equal((await call('GET', `/tasks/${pt2.id}`)).phase_id, null, 'phase cleared on move');
    await call('DELETE', `/phases/${ph2.id}`);
    assert.equal((await call('GET', `/tasks/${psub.id}`)).phase_id, ph1.id, 'other phases untouched');
    await call('DELETE', `/phases/${ph1.id}`);
    assert.equal((await call('GET', `/tasks/${pt1.id}`)).phase_id, null, 'tasks kept without a phase');
    await call('DELETE', `/tasks/${pt2.id}`);
    await call('DELETE', `/projects/${pp.id}`);
    assert.equal((await call('GET', `/projects/${cp.id}/phases`)).length, 0);

    // ---- Charter Excel: plain workbook without a template, filled template with one
    let cx = await fetch(`${BASE}/projects/${cp.id}/charter.xlsx`);
    assert.equal(cx.status, 200);
    const plain = readZip(Buffer.from(await cx.arrayBuffer()));
    assert.match(plain['xl/workbook.xml'].toString(), /name="Charter"/, 'plain charter workbook');
    assert.match(plain['xl/worksheets/sheet1.xml'].toString(), /Supplier costs rising/);
    const tpl = buildXlsx([{ name: 'Form', columns: [{ header: 'Problem definition:' }, { header: 'Management Sponsor:' }, { header: 'Project ID' }], rows: [] },
      { name: 'Risk analysis', columns: [{ header: 'Risk' }, { header: 'Likelihood' }], rows: [['Late delivery', 3]] },
      { name: 'Final report', columns: [{ header: 'Lessons learned' }], rows: [['tbd']] }]);
    const up = await fetch(`${BASE}/charter-template`, { method: 'POST', body: tpl,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': 'form.xlsx' } });
    const info = await up.json();
    assert.equal(up.status, 201, JSON.stringify(info));
    assert.equal(info.mapping.problem.cell, 'A2', 'value goes under its label');
    assert.equal(info.mapping.project_code.cell, 'C2');
    assert.deepEqual(info.output_sheets, ['Form'], 'only the charter sheet is downloaded');
    assert.deepEqual(info.dropped_sheets, ['Risk analysis', 'Final report']);
    await assert.rejects(call('PATCH', '/charter-template', { mapping: { problem: { sheet: 'Form', cell: 'nope' } } }), /cell reference/);
    await call('PATCH', '/charter-template', { mapping: { ...info.mapping, sponsor: { sheet: 'Form', cell: 'B5', mode: 'replace' } } });
    cx = await fetch(`${BASE}/projects/${cp.id}/charter.xlsx`);
    const filled = readZip(Buffer.from(await cx.arrayBuffer()));
    const sheet = filled['xl/worksheets/sheet1.xml'].toString();
    assert.deepEqual([...filled['xl/workbook.xml'].toString().matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((m) => m[1]), ['Form'], 'other sheets left out');
    assert.ok(!filled['xl/worksheets/sheet2.xml'] && !filled['xl/worksheets/sheet3.xml'], 'dropped sheet parts removed');
    assert.doesNotMatch(filled['[Content_Types].xml'].toString(), /sheet[23]\.xml/);
    assert.doesNotMatch(filled['xl/_rels/workbook.xml.rels'].toString(), /sheet[23]\.xml/);
    assert.match(sheet, /<c r="A2"[^>]*><is><t[^>]*>Supplier costs rising</, 'problem filled in');
    assert.match(sheet, /<c r="B5"[^>]*><is><t[^>]*>J\. Smith</, 'remapped sponsor cell used');
    assert.match(sheet, /CI-2026-07/);
    await assert.rejects(fetch(`${BASE}/charter-template`, { method: 'POST', body: 'not excel',
      headers: { 'X-Requested-With': 'TaskManager', 'Content-Type': 'application/octet-stream' } }).then((r) => { if (!r.ok) throw new Error(String(r.status)); }), /400/);
    await call('DELETE', '/charter-template');

    // Timeline grid: "Sub projects" rows with Owner, Planned Complete Date and month columns.
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'];
    const gridTpl = buildXlsx([{ name: 'Plan', rows: [[1], [2], [3]],
      columns: [{ header: '#' }, { header: 'Sub projects' }, { header: 'Owner' }, { header: 'Planned Complete Date' },
        ...months.map((m) => ({ header: m })), { header: 'Status' }] }]);
    await fetch(`${BASE}/charter-template`, { method: 'POST', body: gridTpl,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager' } });
    const tinfo = await call('GET', '/charter-template');
    assert.equal(tinfo.timelines[0].rows, 3, 'grid rows detected');
    const phase = await call('POST', '/tasks', { project_id: cp.id, title: 'Phase with owner', owner: 'Alex',
      start_date: `${new Date().getFullYear()}-01-10`, due_at: `${new Date().getFullYear()}-03-20` });
    assert.equal(phase.owner, 'Alex');
    assert.ok((await call('GET', `/tasks/owner-names?project_id=${cp.id}`)).includes('Alex'), 'owner suggestions include the team');
    cx = await fetch(`${BASE}/projects/${cp.id}/charter.xlsx`);
    const grid = readZip(Buffer.from(await cx.arrayBuffer()))['xl/worksheets/sheet1.xml'].toString();
    assert.match(grid, /<c r="B2"[^>]*><is><t[^>]*>Phase 1</, 'first top-level task in the grid');
    assert.match(grid, /<c r="B3"[^>]*><is><t[^>]*>Phase with owner</);
    assert.match(grid, /<c r="C3"[^>]*><is><t[^>]*>Alex</, 'owner column');
    assert.match(grid, /<c r="D3"[^>]*><v>\d+<\/v>/, 'planned complete date is a real date');
    assert.match(grid, /<c r="E3" s="\d+"\/>/, 'January shaded as planned');
    assert.match(grid, /<c r="Q3"[^>]*><is><t[^>]*>(Green|Yellow|Red)</, 'status column');
    await call('DELETE', '/charter-template');

    // Change requests without the app's header are refused (blocks other websites).
    const bare = await fetch(`${BASE}/backups`, { method: 'POST' });
    assert.equal(bare.status, 403, 'request without X-Requested-With refused');
    assert.equal((await call('GET', '/health')).app, 'taskmanager');

    // Deleting a project cascades and is audited.
    await call('DELETE', `/projects/${p.id}`);
    const log = await call('GET', `/audit?project_id=${p.id}`);
    assert.ok(log.some((e) => e.action === 'DELETE' && e.table_name === 'projects'), 'project delete audited');
    assert.equal((await call('GET', `/tasks?project_id=${p.id}`)).length, 0, 'tasks cascaded');

    // ---- Restore from the Backups page: a listed backup, and an uploaded file.
    const before = (await call('GET', '/backups')).length;
    const listedUrl = `/backups/db/${encodeURIComponent(path.basename(b.db))}/restore`;
    const peek = await call('POST', `${listedUrl}?check=1`);
    assert.ok(peek.counts.projects >= 1 && peek.counts.tasks >= 1, 'check reports what the backup holds');
    assert.equal((await call('GET', `/projects/${p.id}`).catch(() => null)), null, 'check alone changes nothing');
    const restored = await call('POST', listedUrl);
    assert.ok(fs.existsSync(restored.safety), 'safety backup taken before restoring');
    assert.equal((await call('GET', `/projects/${p.id}`)).name, p.name, 'deleted project is back');
    assert.ok((await call('GET', '/backups')).length > before);
    const afterRestore = await call('POST', '/tasks', { title: 'After restore' });
    assert.ok((await call('GET', '/audit')).some((e) => e.table_name === 'tasks' && e.record_id === afterRestore.id), 'audit triggers back after restore');
    await assert.rejects(call('POST', '/backups/db/nope.db/restore'), /not found/i);
    const upload = (body, name, q = '') => fetch(`${BASE}/backups/restore${q}`, { method: 'POST', body,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(name) } });
    let up2 = await upload(fs.readFileSync(b.json), 'copy é.json', '?check=1');
    assert.equal(up2.status, 200);
    assert.equal((await up2.json()).counts.projects, peek.counts.projects, 'JSON and .db backups agree');
    up2 = await upload(fs.readFileSync(b.json), 'copy é.json');
    assert.equal(up2.status, 200, 'uploaded JSON backup restored');
    assert.equal((await call('GET', `/tasks/${afterRestore.id}`).catch(() => null)), null, 'data since the backup replaced');
    up2 = await upload(Buffer.from('hello'), 'notes.txt', '?check=1');
    assert.equal(up2.status, 400, 'a non-backup file is refused');
    assert.match((await up2.json()).error, /not a CI Manager backup/);

    // ---- Weekly KPIs: a small workbook like the CI one (A3 + Database, a cross-sheet
    // conditional format, a chart), loaded, viewed and exported as a disconnected A3
    {
      const { zip: mkZip, readZip: rz } = require('../src/xlsx');
      const { formatValue } = require('../src/numfmt');
      const { evaluate } = require('../src/xlformula');
      assert.equal(formatValue(0.6654, '0.0%').text, '66.5%');
      assert.equal(formatValue(-1234.5, '#,##0.0').text, '-1,234.5');
      assert.equal(formatValue(-0.4, '#,##0.0\\K;\\-#,##0.0\\K').text, '-0.4K');
      assert.equal(formatValue(46297, 'mmm-yy').text, 'Oct-26');
      assert.deepEqual(formatValue(-2, '0;[Red]-0'), { text: '-2', color: 'FF0000' });
      const cells = { A1: -3, B1: 'up ▲' };
      const ectx = { sheet: 'S', cell: (sh, r, c) => cells[String.fromCharCode(64 + c) + r] ?? null };
      assert.equal(evaluate('AND(A1>-10,A1<0)', ectx), true);
      assert.equal(evaluate('NOT(ISERROR(SEARCH("▲",B1)))', ectx), true);
      assert.equal(evaluate('C1=0', ectx), true, 'a blank cell equals 0');
      assert.equal(evaluate('1/0', ectx).error, '#DIV/0!');

      const x = (s) => Buffer.from(s, 'utf8');
      const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
      const book = {
        '[Content_Types].xml': x('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>'),
        '_rels/.rels': x('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
        'xl/workbook.xml': x(`<?xml version="1.0"?><workbook ${ns}><sheets><sheet name="Database" sheetId="1" r:id="rId1"/><sheet name="A3 Weekly Report" sheetId="2" r:id="rId2"/></sheets><externalReferences><externalReference r:id="rId9"/></externalReferences></workbook>`),
        'xl/_rels/workbook.xml.rels': x('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
        'xl/styles.xml': x('<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><dxfs count="1"><dxf><font><b/><color rgb="FFFF0000"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs></styleSheet>'),
        'xl/worksheets/sheet1.xml': x(`<?xml version="1.0"?><worksheet ${ns}><sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>Sept</t></is></c><c r="B2" t="inlineStr"><is><t>W2639</t></is></c></row><row r="9"><c r="B9"><v>0.998</v></c></row><row r="63"><c r="A63" t="inlineStr"><is><t>Mar</t></is></c><c r="B63" t="inlineStr"><is><t>W2614_1</t></is></c><c r="D63"><v>1</v></c><c r="H63"><v>3</v></c><c r="O63"><v>100</v></c><c r="P63"><v>41</v></c></row></sheetData></worksheet>`),
        'xl/worksheets/sheet2.xml': x(`<?xml version="1.0"?><worksheet ${ns}><cols><col min="1" max="3" width="15" customWidth="1"/></cols><sheetData>`
          + '<row r="1" ht="30" customHeight="1"><c r="A1" t="str"><f>Database!B2</f><v>W2639</v></c><c r="B1" s="1"><f>[1]Other!A1/2</f><v>0.665</v></c><c r="C1" t="str"><f>"▼"</f><v>▼</v></c></row>'
          + '<row r="2"><c r="A2"><f>SUM(1,2)</f><v>3</v></c><c r="B2" s="1"><v>0.999</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A3:C3"/></mergeCells>'
          + '<conditionalFormatting sqref="C1"><cfRule type="containsText" dxfId="0" priority="1" operator="containsText" text="▼"><formula>NOT(ISERROR(SEARCH("▼",C1)))</formula></cfRule></conditionalFormatting>'
          + '<dataValidations count="1"><dataValidation type="list" sqref="A2"><formula1>"1,2"</formula1></dataValidation></dataValidations>'
          + '<drawing r:id="rId1"/><extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">'
          + '<x14:cfRule type="expression" priority="2" id="{1}"><xm:f>B1&lt;Database!$B$9</xm:f><x14:dxf><font><color rgb="FFFF0000"/></font></x14:dxf></x14:cfRule>'
          + '<x14:cfRule type="expression" priority="3" id="{2}"><xm:f>B1&gt;=Database!$B$9</xm:f><x14:dxf><font><color rgb="FF00B050"/></font></x14:dxf></x14:cfRule><xm:sqref>B1:B2</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst></worksheet>'),
        'xl/worksheets/_rels/sheet2.xml.rels': x('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>'),
        'xl/drawings/drawing1.xml': x('<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>'),
        'xl/drawings/_rels/drawing1.xml.rels': x('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>'),
        'xl/charts/chart1.xml': x('<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Database!$D$43</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>OTD SC</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:ln w="38100"><a:solidFill><a:srgbClr val="430099"/></a:solidFill></a:ln></c:spPr><c:cat><c:strRef><c:f>x</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>W2638</c:v></c:pt><c:pt idx="1"><c:v>W2639</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>y</c:f><c:numCache><c:formatCode>0%</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>0.665</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:lineChart><c:catAx><c:axId val="1"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:max val="1"/><c:min val="0.3"/></c:scaling><c:axPos val="l"/><c:numFmt formatCode="0.0%" sourceLinked="0"/><c:crossAx val="1"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>'),
        'xl/vbaProject.bin': x('not really vba'),
      };
      const wbFile = mkZip(book);
      const loadKpi = (buf, name) => fetch(`${BASE}/kpi/load`, { method: 'POST', body: buf,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(name) } });
      let lr = await loadKpi(wbFile, 'CI Hub.xlsm');
      assert.equal(lr.status, 201);
      const wk = await lr.json();
      assert.deepEqual([wk.week, wk.year, wk.month, wk.replaced], ['W2639', 2026, 'Sept', false], 'the week the workbook shows');
      assert.equal((await (await loadKpi(wbFile, 'CI Hub.xlsm')).json()).replaced, true, 'loading the same week again replaces it');
      assert.equal((await loadKpi(Buffer.from('nope'), 'notes.txt')).status, 400, 'only workbooks');
      assert.match((await (await loadKpi(mkZip({ ...book, 'xl/workbook.xml': x(`<workbook ${ns}><sheets><sheet name="Other" sheetId="1" r:id="rId1"/></sheets></workbook>`) }), 'x.xlsx')).json()).error, /no sheet called "A3 Weekly Report"/);
      const snap = await call('GET', `/kpi/snapshots/${wk.id}`);
      const cellAt = (v, row, col) => v.cells.find((c) => c[0] === row && c[1] === col);
      const a3v = snap.views.a3;
      assert.equal(cellAt(a3v, 1, 2)[2], '66.5%', 'cached value in its number format');
      assert.match(a3v.styles[cellAt(a3v, 1, 2)[3]], /color:#FF0000/, 'cross-sheet rule against the target (x14) → red');
      assert.match(a3v.styles[cellAt(a3v, 2, 2)[3]], /color:#00B050/, 'at or above target → green');
      assert.match(a3v.styles[cellAt(a3v, 1, 3)[3]], /color:#FF0000;background:#FFC7CE/, 'contains ▼ → red on pink');
      assert.equal(a3v.cols[0], 105, 'column width in pixels as Excel draws it');
      assert.equal(a3v.rows[0], 40, 'row height 30pt = 40px');
      assert.equal(a3v.charts.length, 1);
      const ax = Object.values(a3v.charts[0].spec.axes).find((a) => a.kind === 'valAx');
      assert.deepEqual(ax.ticks.map((t) => t.text), ['30.0%', '40.0%', '50.0%', '60.0%', '70.0%', '80.0%', '90.0%', '100.0%'], 'axis ticks as Excel spaces them');
      assert.deepEqual(a3v.charts[0].spec.groups[0].series[0].vals, [1, 0.665], 'chart drawn from its stored values');
      assert.ok(snap.views.database.cells.some((c) => c[2] === 'W2639'), 'Database sheet view');
      assert.equal((await call('GET', '/kpi/snapshots')).length, 1);
      // the disconnected A3
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const expRes = await fetch(`${BASE}/kpi/snapshots/${wk.id}/export`, { method: 'POST', body: JSON.stringify({ charts: { 0: png } }), headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TaskManager' } });
      assert.equal(expRes.status, 200);
      assert.match(expRes.headers.get('content-disposition'), /A3 2026 WK39\.xlsx/);
      const out = rz(Buffer.from(await expRes.arrayBuffer()));
      const sheetXml = out['xl/worksheets/sheet1.xml'].toString();
      assert.ok(!/<f[ >]/.test(sheetXml), 'no formulas');
      assert.ok(!/conditionalFormatting|dataValidation|extLst/.test(sheetXml), 'no rules or validations left');
      assert.ok(!out['xl/vbaProject.bin'] && !Object.keys(out).some((k) => /externalLink|connections|charts\//.test(k)), 'no macros, links, queries or live charts');
      assert.match(out['[Content_Types].xml'].toString(), /spreadsheetml\.sheet\.main\+xml/, 'a plain .xlsx');
      assert.match(sheetXml, /<c r="A1"[^>]*t="inlineStr"><is><t xml:space="preserve">W2639<\/t>/, 'values kept');
      assert.match(sheetXml, /<mergeCell ref="A3:C3"\/>/, 'layout kept');
      const red = sheetXml.match(/<c r="B1" s="(\d+)"/)[1];
      const xfs = [...out['xl/styles.xml'].toString().match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)[1].matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((m) => m[0]);
      const fonts = [...out['xl/styles.xml'].toString().match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/)[1].matchAll(/<font\b[\s\S]*?<\/font>/g)].map((m) => m[0]);
      assert.match(fonts[Number(xfs[red].match(/fontId="(\d+)"/)[1])], /FFFF0000/, 'the red written into the cell\'s own format');
      assert.match(xfs[red], /numFmtId="164"/, 'number format kept');
      assert.ok(out['xl/media/chart0.png'] && /<xdr:pic>[\s\S]*r:embed="rIdChart0"/.test(out['xl/drawings/drawing1.xml'].toString()), 'chart replaced by its picture, same place');
      assert.ok(!/graphicFrame|CIM-CHART/.test(out['xl/drawings/drawing1.xml'].toString()));
      // changes made by hand: typed text and KPI colours
      assert.deepEqual(snap.views.a3.edit, { B1: 'f', C1: 'fs', B2: 'tf' }, 'what can be changed: typed cells, figures with conditional colours, trend symbols');
      {
        const sym = new Map([['A1', { r: 'A1', v: '▬' }], ['A2', { r: 'A2', v: '▼' }], ['A3', { r: 'A3', v: '▲ ' }], ['A4', { r: 'A4', v: 'x' }]]);
        const cfs = require('../src/kpi').symbolColours({ cells: sym }, new Map([['A2', { font: { color: 'FFCC00', b: true }, fill: { color: 'FFC7CE' } }]]));
        assert.deepEqual(Object.fromEntries(cfs), { A1: { font: { color: 'FFC000' } }, A2: { font: { color: 'FF0000', b: true }, fill: { color: 'FFC7CE' } }, A3: { font: { color: '00B050' } } },
          'a trend symbol shows in its own colour, whatever its cell or the rules give');
      }
      let ed = await call('PUT', '/kpi/edits/W2639', { ref: 'b2', text: '0.5' });
      ed = await call('PUT', '/kpi/edits/W2639', { ref: 'B1', color: 'orange' });
      ed = await call('PUT', '/kpi/edits/W2639', { ref: 'C1', text: '▲', color: 'green' });
      assert.deepEqual(ed, { B1: { text: null, color: 'FFC000' }, B2: { text: '0.5', color: null }, C1: { text: '▲', color: '00B050' } });
      await assert.rejects(call('PUT', '/kpi/edits/W2639', { ref: 'B1', color: 'purple' }), /green, yellow or red/);
      await assert.rejects(call('PUT', '/kpi/edits/W2639', { ref: 'nope', text: 'x' }), /cell reference/);
      await assert.rejects(call('PUT', '/kpi/edits/W2601', { ref: 'B1', text: 'x' }), /not found/i);
      assert.deepEqual((await call('GET', `/kpi/snapshots/${wk.id}`)).edits.B1, { text: null, color: 'FFC000' });
      const edX = rz(Buffer.from(await (await fetch(`${BASE}/kpi/snapshots/${wk.id}/export`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TaskManager' } })).arrayBuffer()));
      const edXml = edX['xl/worksheets/sheet1.xml'].toString(); const edSt = edX['xl/styles.xml'].toString();
      const edXfs = [...edSt.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)[1].matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((m) => m[0]);
      const edFonts = [...edSt.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/)[1].matchAll(/<font\b[\s\S]*?<\/font>/g)].map((m) => m[0]);
      const fontOf = (ref) => edFonts[Number(edXfs[Number(edXml.match(new RegExp(`<c r="${ref}" s="(\\d+)"`))[1])].match(/fontId="(\d+)"/)[1])];
      assert.match(edXml, /<c r="B2" s="\d+"><v>0.5<\/v><\/c>/, 'a typed number stays a number');
      assert.match(fontOf('B1'), /FFFFC000/, 'the chosen colour in the file');
      assert.match(fontOf('C1'), /FF00B050/);
      assert.match(edXml, /<c r="C1" s="\d+" t="inlineStr"><is><t xml:space="preserve">▲<\/t>/, 'a symbol chosen with its colour');
      await call('PUT', '/kpi/edits/W2639', { ref: 'B1', color: null });
      assert.deepEqual(Object.keys((await call('GET', `/kpi/snapshots/${wk.id}`)).edits), ['B2', 'C1'], 'back to automatic');
      assert.ok((await call('GET', '/audit')).some((e) => e.table_name === 'kpi_edits'), 'changes are audited (and backed up)');
      await call('DELETE', '/kpi/edits/W2639');
      // notes kept with the week
      assert.equal((await call('GET', `/kpi/snapshots/${wk.id}`)).notes, null);
      const nt = await call('PUT', '/kpi/notes/w2639', { text: 'Follow up ING capacity\r\nAsk about DUGX' });
      assert.equal(nt.text, 'Follow up ING capacity\nAsk about DUGX');
      assert.equal((await call('GET', `/kpi/snapshots/${wk.id}`)).notes.text, nt.text);
      assert.ok((await call('GET', '/audit')).some((e) => e.table_name === 'kpi_notes'), 'notes are audited (and backed up)');
      assert.equal(await call('PUT', '/kpi/notes/W2639', { text: '  ' }), null, 'emptied → removed');
      assert.equal((await call('GET', `/kpi/snapshots/${wk.id}`)).notes, null);
      await assert.rejects(call('PUT', '/kpi/notes/nope', { text: 'x' }), /Not a week code/);
      assert.deepEqual((await call('GET', `/kpi/snapshots/${wk.id}`)).edits, {}, 'undo all');
      // saved into the week's folder
      await assert.rejects(call('POST', `/kpi/snapshots/${wk.id}/export`, { save: true }), /Set the folder/);
      await call('PATCH', '/settings', { kpi_export_dir: path.join(tmp, 'OPS', '{year}', 'Weekly', 'WK{wk}'), kpi_export_name: 'SC {year} WK{wk}.xlsx' });
      const saved = await fetch(`${BASE}/kpi/snapshots/${wk.id}/export`, { method: 'POST', body: JSON.stringify({ save: true }), headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TaskManager' } });
      assert.equal(saved.status, 200);
      const savedPath = path.join(tmp, 'OPS', '2026', 'Weekly', 'WK39', 'SC 2026 WK39.xlsx');
      assert.ok(fs.existsSync(savedPath), 'written to the WK folder (created)');
      assert.ok(!/<xdr:pic>/.test(rz(fs.readFileSync(savedPath))['xl/drawings/drawing1.xml'].toString()), 'a chart without a picture is left out');
      assert.equal((await call('GET', `/kpi/snapshots/${wk.id}`)).exported_to, savedPath);
      // the A3 folder holding the week folders: WK04, WK39, WK14_1 / WK14_2
      await call('PATCH', '/settings', { kpi_export_dir: path.join(tmp, 'OPS2', '{year}', 'Weekly'), kpi_export_name: 'SC Site {year} WK{wk}.xlsx' });
      const pv = await call('GET', '/kpi/export-preview');
      assert.deepEqual(pv.map((x) => [x.week, x.path]), [['W2639', path.join(tmp, 'OPS2', '2026', 'Weekly', 'WK39', 'SC Site 2026 WK39.xlsx')],
        ['W2604', path.join(tmp, 'OPS2', '2026', 'Weekly', 'WK04', 'SC Site 2026 WK04.xlsx')], ['W2614_1', path.join(tmp, 'OPS2', '2026', 'Weekly', 'WK14_1', 'SC Site 2026 WK14_1.xlsx')]],
        'week folders and names as they are: two digits, a split week with its part');
      const { exportTarget } = require('../src/kpi');
      assert.equal(exportTarget({ kpi_export_dir: 'X', kpi_export_sub: '', kpi_export_name: 'A {num} {wk}.xlsx' }, 'W2614_2').path, path.join('X', 'A 14 14_2.xlsx'), 'no week folder; {num} the number alone');
      await fetch(`${BASE}/kpi/snapshots/${wk.id}/export`, { method: 'POST', body: JSON.stringify({ save: true }), headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TaskManager' } });
      assert.ok(fs.existsSync(pv[0].path), 'saved there');
      // from where the workbook is saved
      const onDisk = path.join(tmp, 'CI Hub.xlsm');
      fs.writeFileSync(onDisk, wbFile);
      await assert.rejects(call('POST', '/kpi/load-path', {}), /Set where the workbook is saved/);
      await call('PATCH', '/settings', { kpi_workbook_path: onDisk });
      assert.equal((await call('POST', '/kpi/load-path', {})).source_name, 'CI Hub.xlsm');
      await assert.rejects(call('POST', '/kpi/load-path', { path: path.join(tmp, 'missing.xlsm') }), /Can't find/);
      // ---- KPIs worked out from the source files (first pass: volumes)
      const kd = require('../src/kpidata');
      assert.equal(kd.weekCode('2026-01-01'), 'W2601_2', 'week codes as the workbook calendar');
      assert.deepEqual(['2026-03-29', '2026-03-30', '2026-04-01', '2026-04-04', '2026-04-05', '2026-12-31'].map((d) => kd.weekCode(d)),
        ['W2614', 'W2614_1', 'W2614_2', 'W2614', 'W2615', 'W2653_1'], 'Sunday–Saturday weeks; weekdays split at a month end');
      assert.deepEqual(['2026-03-29', '2026-04-04'].map((d) => kd.weekCode(d, { splitWeekends: true })), ['W2614_1', 'W2614_2'], 'weekends to their month\'s part');
      assert.equal(kd.weeksOf(2026).length, 59, 'reporting weeks of a year');
      assert.deepEqual([kd.dayOf(46111), kd.dayOf('2026-03-31'), kd.dayOf('31/03/2026'), kd.dayOf('')], ['2026-03-30', '2026-03-31', '2026-03-31', null]);
      const src = (name, cols, rows) => { const f = path.join(tmp, name); fs.writeFileSync(f, buildXlsx([{ name: name.replace('.xlsx', ''), columns: cols.map((c) => ({ header: c[0], type: c[1] })), rows }])); return f; };
      const persoF = src('KPI_persoed_CI.xlsx', [['Customer'], ['Type'], ['duedate', 'date'], ['Perso Date', 'date'], ['Scrap', 'number'], ['Qty Persoed', 'number']], [
        ['Bank A', 'Card', '2026-03-30', '2026-03-30', 0, 1000], ['Techniker Krankenkasse', 'Card', '2026-04-01', '2026-04-01', 0, 500],
        ['Bank A', 'PIN', '2026-04-02', '2026-04-02', 0, 200], ['Bank A', 'Card', '2026-03-29', '2026-03-29', 0, 300], ['Bank A', 'Card', '2026-04-04', '2026-04-04', 0, 50]]);
      const shipF = src('KPI_shipped_CI.xlsx', [['Customer'], ['Type'], ['duedate', 'date'], ['shipping Date', 'date'], ['QtyShipped', 'number']], [['Bank A', 'Card', '2026-04-01', '2026-04-02', 800]]);
      const remF = src('KPI_2_remakes.xlsx', [['Customer'], ['Type'], ['Mode'], ['Perso Date', 'date'], ['PersoWO'], ['#remakes', 'number'], ['Machine'], ['Date'], ['Time'], ['VaultWO']], [
        ['Bank A', 'Card', 'Live', '2026-03-31', 'WO1', 1, 'MX#3', '2026-03-31', '09:00:00', 'V1'], ['Bank A', 'Card', 'Live', '2026-03-31', 'WO2', 1, 'MX#3', '2026-03-31', '10:00:00', 'V2'],
        ['Bank A', 'Card', 'Live', null, null, null, null, null, null, null]]);
      await call('PATCH', '/settings', { kpi_src_perso: persoF, kpi_src_shipped: shipF, kpi_src_remakes: remF });
      let imp = await call('POST', '/kpi/calc/import', {});
      assert.deepEqual(imp.slice(0, 3).map((r) => [r.source, r.status, r.from, r.rows]), [['perso', 'imported', 'file', 5], ['shipped', 'imported', 'file', 1], ['remakes', 'imported', 'file', 2]]);
      assert.equal(imp[2].skipped, 1, 'rows without a date are counted, not used');
      assert.deepEqual((await call('POST', '/kpi/calc/import', {})).slice(0, 3).map((r) => r.status), ['unchanged', 'unchanged', 'unchanged'], 'unchanged files aren\'t read again');
      assert.equal((await call('POST', '/kpi/calc/import', { force: true }))[0].status, 'imported');
      let calc = await call('GET', '/kpi/calc?year=2026');
      const wkOf = (code) => calc.weeks.find((w) => w.week === code);
      assert.deepEqual([wkOf('W2614_1').perso_ps, wkOf('W2614_1').scrap], [1, 2], 'PS cards in kU; scrap in units');
      assert.deepEqual([wkOf('W2614_2').perso_isi, wkOf('W2614_2').perso_pin, wkOf('W2614_2').perso_total, wkOf('W2614_2').shipped_ps], [0.5, 0.2, 0.5, 0.8],
        'the German health card is ISI; PIN mailers apart; total = PS + ISI; shipped by shipping date');
      assert.deepEqual(calc.unlisted.map((u) => [u.source, u.week, u.qty]), [['perso', 'W2614', 350]], 'weekend work in a split week, as Excel leaves it out');
      assert.deepEqual([calc.excel.weeks.W2614_1.perso_ps, calc.excel.weeks.W2614_1.scrap], [1, 3], 'Excel\'s figures from the loaded week to compare with');
      await call('POST', '/kpi/calc/weekends', { split: true });
      calc = await call('GET', '/kpi/calc?year=2026');
      assert.deepEqual([wkOf('W2614_1').perso_ps, wkOf('W2614_2').perso_ps, calc.unlisted.length, calc.split_weekends], [1.3, 0.05, 0, true], 'weekends counted in their month\'s part');
      await call('POST', '/kpi/calc/weekends', { split: false });
      // OTD from Production's report: typed weeks (dates often missing or day/month swapped)
      const otdF = src('OTD Report.xlsx', [['Customer'], ['Quantity', 'number'], ['Type'], ['Date', 'date'], ['Week'], ['Month'], ['Reason']], [
        ['ADY', 50, 'Internal', '2026-03-30', 'W2614_1', 'Mar', 'Card stock out'], ['BEL', 400, 'Internal', '2026-02-04', 'W2614_2', 'Apr', 'Machine Issues'],
        ['ICA', 100, 'External', null, 'W2614_2', 'Apr', 'customer change request'], ['X', 5, 'Internal', null, null, null, 'no week, no date']]);
      await call('PATCH', '/settings', { kpi_src_otd: otdF });
      imp = await call('POST', '/kpi/calc/import', {});
      assert.deepEqual([imp[3].source, imp[3].status, imp[3].rows, imp[3].skipped], ['otd', 'imported', 4, 0]);
      calc = await call('GET', '/kpi/calc?year=2026');
      assert.deepEqual([wkOf('W2614_1').otd_internal, wkOf('W2614_1').otd_sc], [0.05, null], 'no OTD % without cards shipped');
      assert.deepEqual([wkOf('W2614_2').otd_internal, wkOf('W2614_2').otd_external, wkOf('W2614_2').otd_sc, wkOf('W2614_2').otd_global], [0.4, 0.1, 0.5, 0.375],
        'OTD SC = 1 − internal ÷ shipped; Global includes external; the typed week wins over the date');
      assert.deepEqual(calc.otd_checks.map((c) => [c.customer, c.date, c.typed_week, c.date_week, c.swapped]), [['BEL', '2026-02-04', 'W2614_2', 'W2606', true]], 'day/month swap spotted');
      assert.deepEqual(calc.otd_uncounted.map((c) => [c.customer, c.qty, c.why]), [['X', 5, 'no week typed']], 'a row without a week isn\'t counted (as in Excel), but listed');
      assert.deepEqual((await call('GET', '/kpi/calc/otd?week=W2614_2')).map((r) => [r.customer, r.qty, r.date_week]), [['ICA', 100, null], ['BEL', 400, 'W2606']], 'the rows behind a week');
      // week numbers typed other ways; a date never decides the week
      const otd2 = src('OTD Report 2.xlsx', [['Customer'], ['Quantity', 'number'], ['Type'], ['Date', 'date'], ['Week'], ['Month'], ['Reason']], [
        ['A', 1000, 'Internal', '2026-10-09', '37', 'Sept', 'swapped date, week typed as a number'], ['B', 2000, 'Internal', null, 'Wk 14', 'Mar', 'split week: part from the month'],
        ['C', 3000, 'Internal', '2026-11-09', null, 'Sept', 'no week: not counted, even though the date reads as November'], ['D', 4000, 'External', null, 'W2614', 'Apr', 'plain code for a split week']]);
      await call('PATCH', '/settings', { kpi_src_otd: otd2 });
      await call('POST', '/kpi/calc/import', {});
      calc = await call('GET', '/kpi/calc?year=2026');
      assert.deepEqual([wkOf('W2637').otd_internal, wkOf('W2614_1').otd_internal, wkOf('W2645').otd_internal, wkOf('W2646').otd_internal], [1, 2, 0, 0], 'no delays in future weeks from misread dates');
      assert.deepEqual(calc.otd_uncounted.map((c) => [c.customer, c.why]), [['C', 'no week typed'], ['D', 'split week — which part?']]);
      assert.deepEqual(['W2639', '2639', '39', 39, 'Week 39', '39.0'].map((v) => kd.typedWeekCode(v, { year: 2026 })), Array(6).fill('W2639'));
      assert.deepEqual([kd.typedWeekCode('40', { year: 2026, month: 'Sept' }), kd.typedWeekCode('40', { year: 2026, month: 10 }), kd.typedWeekCode('x', { year: 2026 })], ['W2640_1', 'W2640_2', null]);
      // the report's Table1 only: a helper "Week" column beside it (O) is never read
      const tblSheet = (rows) => `<?xml version="1.0"?><worksheet ${ns}><sheetData>${rows.map((cells, i) => `<row r="${i + 1}">${cells.map(([ref, v]) => (typeof v === 'number'
        ? `<c r="${ref}${i + 1}"><v>${v}</v></c>` : `<c r="${ref}${i + 1}" t="inlineStr"><is><t>${v}</t></is></c>`)).join('')}</row>`).join('')}</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`;
      const head = [['A', 'Customer'], ['B', 'Quantity'], ['C', 'Type'], ['E', 'Week'], ['F', 'Month'], ['G', 'Reason'], ['O', 'Week']];
      const tableBook = mkZip({
        '[Content_Types].xml': book['[Content_Types].xml'], '_rels/.rels': book['_rels/.rels'],
        'xl/workbook.xml': x(`<?xml version="1.0"?><workbook ${ns}><sheets><sheet name="Delays" sheetId="1" r:id="rId1"/></sheets></workbook>`),
        'xl/_rels/workbook.xml.rels': x('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
        'xl/worksheets/sheet1.xml': x(tblSheet([head, [['A', 'KBC'], ['B', 7000], ['C', 'Internal'], ['E', 'W2620'], ['F', 'May'], ['O', 'W2652']],
          [['A', 'ING'], ['B', 3000], ['C', 'Internal'], ['E', 'W2621'], ['O', 'W2653_1']], [['O', 'W2601']], [['A', 'below the table'], ['B', 99], ['C', 'Internal'], ['E', 'W2622']]])),
        'xl/worksheets/_rels/sheet1.xml.rels': x('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>'),
        'xl/tables/table1.xml': x('<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Table1" ref="A1:G3"><tableColumns count="7"/></table>'),
      });
      const otd3 = path.join(tmp, 'OTD Report 3.xlsx');
      fs.writeFileSync(otd3, tableBook);
      await call('PATCH', '/settings', { kpi_src_otd: otd3 });
      await call('POST', '/kpi/calc/import', {});
      calc = await call('GET', '/kpi/calc?year=2026');
      assert.deepEqual([wkOf('W2620').otd_internal, wkOf('W2621').otd_internal, wkOf('W2622').otd_internal, wkOf('W2652').otd_internal, wkOf('W2653_1').otd_internal],
        [7, 3, 0, 0, 0], 'only Table1 is read: not the helper Week column O, nor rows below the table');
      // no table: the left-most of two "Week" headings
      const noTable = mkZip({ ...Object.fromEntries(Object.entries(rz(tableBook)).filter(([k]) => !/table|sheet1\.xml\.rels/.test(k))),
        'xl/worksheets/sheet1.xml': x(tblSheet([head, [['A', 'KBC'], ['B', 7000], ['C', 'Internal'], ['E', 'W2620'], ['O', 'W2652']]]).replace(/<tableParts[\s\S]*?<\/tableParts>/, '')) });
      fs.writeFileSync(otd3, noTable);
      await call('POST', '/kpi/calc/import', { force: true });
      calc = await call('GET', '/kpi/calc?year=2026');
      assert.deepEqual([wkOf('W2620').otd_internal, wkOf('W2652').otd_internal], [7, 0], 'the first Week column, not a later one');
      await call('PATCH', '/settings', { kpi_src_otd: otdF });
      await call('POST', '/kpi/calc/import', {});
      calc = await call('GET', '/kpi/calc?year=2026');
      await call('POST', '/kpi/calc/weekends', { split: true });
      assert.equal((await call('GET', '/kpi/calc?year=2026')).weeks.find((w) => w.week === 'W2614_2').otd_internal, 0.4, 'typed weeks stay put');
      await call('POST', '/kpi/calc/weekends', { split: false });
      // typed in each week: HR (Protime) and complaints
      let man = await call('PUT', '/kpi/manual/w2614_2', { protime: ['7', '33', '35', '', '', ''], hours: 999, contract: '40', temps: '2', cc_major: '1' });
      assert.deepEqual([man.week, man.hours, man.protime, man.contract, man.temps, man.cc_major, man.cc_critical], ['W2614_2', 577.5, '[7,33,35,null,null,null]', 40, 2, 1, null],
        '(7 + 33 + 35) × 7.5 + 7.5 for each weekday with a count (Mon, Tue) — the days win over a typed total');
      const { hoursFromProtime } = require('../src/kpidata');
      assert.equal(hoursFromProtime([2, 30, 30, 30, 30, 30]), 1140 + 37.5, 'a full week: the support staff\'s 37.5 h');
      assert.equal(hoursFromProtime(['', 30, 0, 30, '', '']), 450 + 15, 'a weekday at 0 (closed) adds no support hours');
      await assert.rejects(call('PUT', '/kpi/manual/week39', { hours: 1 }), /Not a week code/);
      await assert.rejects(call('PUT', '/kpi/manual/W2614_2', { temps: -1 }), /0 or more/);
      calc = await call('GET', '/kpi/calc?year=2026');
      const w2 = wkOf('W2614_2');
      assert.deepEqual([w2.hours, w2.hc, w2.complaints, w2.cpms, Math.round(w2.productivity * 1e4) / 1e4], [577.5, 42, 1, 1250, 0.8658], 'HC, complaints, CPMS per million shipped, cards per hour');
      assert.equal(wkOf('W2615').complaints, 0, 'no complaints typed in → 0');
      await call('PUT', '/kpi/manual/W2614_2', { cc_major: '' });
      calc = await call('GET', '/kpi/calc?year=2026');
      assert.deepEqual([wkOf('W2614_2').complaints, wkOf('W2614_2').cpms], [0, 0], 'and CPMS 0 for a week with cards shipped');
      await call('PUT', '/kpi/manual/W2614_2', { cc_major: '1' });
      calc = await call('GET', '/kpi/calc?year=2026');
      assert.equal(wkOf('W2614_1').scrap_rate, 0.002, 'scrap ÷ cards persoed');
      man = await call('PUT', '/kpi/manual/W2614_2', { protime: [], hours: '612.5' });
      assert.deepEqual([man.hours, man.protime], [612.5, null], 'or hours typed straight in');
      // carrying the year so far over from Excel: only weeks with nothing typed, up to Excel's week
      const copied = await call('POST', '/kpi/manual/from-excel', {});
      assert.deepEqual(copied, { weeks: 1, fields: 2 });
      calc = await call('GET', '/kpi/calc?year=2026');
      assert.deepEqual([wkOf('W2614_1').hours, wkOf('W2614_1').contract, wkOf('W2614_1').productivity], [100, 41, 10]);
      assert.equal(calc.excel.weeks.W2614_1.hours, 100);
      assert.deepEqual(await call('POST', '/kpi/manual/from-excel', {}), { weeks: 0, fields: 0 }, 'nothing overwritten');
      assert.ok((await call('GET', '/audit')).some((e) => e.table_name === 'kpi_manual'), 'typed-in figures are audited (and backed up)');

      // ---- the CI Manager's own A3 for any week: the workbook's formulas re-run on the source figures
      const { createCalc } = require('../src/xlcalc');
      const cellsOf = (o) => ({ cells: new Map(Object.entries(o).map(([r, c]) => [r, { r, row: Number(r.slice(1)), col: r.charCodeAt(0) - 64, t: typeof c.v === 'string' ? 's' : 'n', ...c }])), maxRow: 9, maxCol: 9 });
      const fx = createCalc({
        S: cellsOf({ A1: { v: 'a' }, A2: { v: 'b' }, A3: { v: 'c' }, B1: { v: 1 }, B2: { v: 5 }, B3: { v: 9 },
          D1: { f: 'FILTER(A1:A3,B1:B3>2)', arrayRef: 'D1:D2', v: 'old' }, D2: { v: 'old' },
          E1: { f: 'XLOOKUP("c",A1:A3,B1:B3,0)', v: 0 }, E2: { f: 'LET(x,SUM(B1:B3),x*2)', v: 0 }, E3: { f: 'COUNTIFS(B1:B3,">1")', v: 0 },
          E4: { f: 'SUMPRODUCT((B1:B3>2)*B1:B3)', v: 0 }, E5: { f: 'Missing!A1', v: 42 }, E6: { f: 'INDEX(_xlfn.ANCHORARRAY(D1),2)', v: 0 }, E7: { f: 'C1', v: 7 } }),
      }, { override: (sh, ref) => (ref === 'B2' ? 6 : undefined) });
      assert.deepEqual(['D1', 'D2', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'].map((r) => fx.value('S', r)), ['b', 'c', 9, 32, 2, 15, 42, 'c', 0],
        'spills, lookups, LET, overrides; a sheet it can\'t see keeps the saved value; an empty cell reads 0');
      // a forecast file read as the workbook's query would: first row as headers, into the table
      {
        const { forecastSheet } = require('../src/kpi');
        const tpl = cellsOf({ A1: { v: 'Cust_Nm' }, B1: { v: 'Line_Month' }, C1: { v: 'Line_Qty' }, D1: { v: 'Short' }, E1: { v: 'Mon' },
          A2: { v: 'Old' }, B2: { v: 1 }, C2: { v: 5 }, D2: { f: 'UPPER(LEFT(ForecastImport[[#This Row],[Cust_Nm]],3))', v: 'OLD' }, E2: { f: 'CHOOSE(B2,"Jan","Feb","Mar")', v: 'Jan' },
          G1: { f: 'SUMIFS(A:A,E:E,"Feb")', v: 0 } });
        Object.assign(tpl, { name: 'BeNeLux Forecast', maxRow: 2, maxCol: 7 });
        const file = buildXlsx([{ name: 'LIVE', columns: [{ header: 'Line_Qty', type: 'number' }, { header: 'Line_Month', type: 'number' }, { header: 'Cust_Nm' }], rows: [[100, 2, 'Belfius'], [50, 1, 'ING'], [7, 2, 'ING']] }]);
        const sh = forecastSheet(tpl, { range: { top: 1, left: 1, bottom: 2, right: 5 } }, file, { file: 'Benelux Forecast.xlsx', sheet: 'live', workbook: 'BeNeLux Forecast' });
        const fc = createCalc({ 'BeNeLux Forecast': sh });
        assert.deepEqual(['A1', 'A2', 'C4', 'D1', 'D2', 'E2', 'D3', 'E4', 'G1'].map((r) => fc.value('BeNeLux Forecast', r)), ['Line_Qty', 100, 'ING', 'Short', 'BEL', 'Feb', 'ING', 'Feb', 107],
          'columns by the file\'s order, the table\'s formula columns carried down by header, formulas outside the table kept');
        assert.equal(sh.read.rows, 3);
        const amex = buildXlsx([{ name: 'Sittard', columns: [{ header: '' }, { header: '' }, { header: 'x', type: 'number' }], rows: [['TOTAL', 'Total', 9]] }]);
        const files2 = rz(amex); files2['xl/worksheets/sheet1.xml'] = Buffer.from(files2['xl/worksheets/sheet1.xml'].toString().replace(/<c r="C1"[^>]*>[\s\S]*?<\/c>/, '<c r="C1"><v>46023</v></c>'));
        const am = forecastSheet(Object.assign(cellsOf({ A1: { v: 'Column1' } }), { name: 'Amex Forecast', maxRow: 1, maxCol: 1 }), { range: { top: 1, left: 1, bottom: 2, right: 3 } }, mkZip(files2), { file: 'Amex Forecast.xlsx', sheet: 'Sittard', workbook: 'Amex Forecast' });
        assert.deepEqual(['A1', 'B1', 'C1', 'C2'].map((r) => am.cells.get(r)?.v), ['Column1', 'Column2', '01/01/2026', 9], 'blank headers ColumnN, dates as dd/mm/yyyy text');
        assert.throws(() => forecastSheet(tpl, { range: { top: 1, left: 1, bottom: 2, right: 5 } }, file, { file: 'x.xlsx', sheet: 'Other', workbook: 'BeNeLux Forecast' }), /no sheet called "Other"/);
      }
      const yr = await call('GET', '/kpi/weeks?year=2026');
      assert.equal(yr.template, true, 'the loaded workbook is kept as the template');
      assert.equal(yr.template_week, 'W2639');
      assert.equal(yr.weeks.find((w) => w.week === 'W2639').a3.origin, 'excel');
      assert.equal(yr.weeks.find((w) => w.week === 'W2614_1').a3, null);
      const built = await call('POST', '/kpi/build', { week: 'W2614_1' });
      assert.deepEqual([built.week, built.origin, built.source_name], ['W2614_1', 'ci', 'CI Manager']);
      assert.deepEqual(built.flags.map((f) => f.part), ['text'], 'flags what still comes from the workbook');
      const bsnap = await call('GET', `/kpi/snapshots/${built.id}`);
      assert.equal(cellAt(bsnap.views.a3, 1, 1)[2], 'W2614_1', 'the A3 recalculated for that week');
      assert.equal(bsnap.values.B2, 'W2614_1');
      assert.equal(bsnap.values.D63 ?? 0, wkOf('W2614_1').perso_ps ?? 0, 'the Database block filled from the source figures');
      assert.equal(bsnap.values.O63, 100, 'typed-in hours');
      assert.equal(bsnap.template_week, 'W2639');
      assert.equal((await call('POST', '/kpi/build', { week: 'W2614_1' })).id, built.id, 'rebuilding replaces it');
      // ▶ Prepare the week: where each step stands
      let prep = await call('GET', '/kpi/prepare?week=W2614_1');
      assert.equal(prep.week, 'W2614_1');
      assert.ok(prep.weeks.length && prep.default_week, 'a choice of weeks, the last finished one first');
      assert.deepEqual([prep.snap.origin, prep.snap.stale, prep.snap.saved_current, prep.snap.text_edited], ['ci', false, false, 0]);
      assert.equal(prep.figures.week, 'W2614_1');
      await call('PUT', '/kpi/manual/W2614_1', { temps: '3' });
      assert.equal((await call('GET', '/kpi/prepare?week=W2614_1')).snap.stale, true, 'typed in since it was built → out of date');
      await call('POST', '/kpi/build', { week: 'W2614_1' });
      prep = await call('GET', '/kpi/prepare?week=W2614_1');
      assert.equal(prep.snap.stale, false);
      assert.equal(prep.manual.temps, 3);
      assert.equal((await call('GET', '/kpi/prepare?week=W2613')).snap, null, 'a week without an A3');
      assert.equal((await call('GET', '/kpi/prepare?week=nonsense')).week, prep.default_week, 'a bad week falls back to the last finished one');
      await assert.rejects(call('POST', '/kpi/build', { week: 'W2639' }), /loaded from Excel/);
      await assert.rejects(call('POST', '/kpi/build', { week: 'nope' }), /Not a week code/);
      assert.equal((await call('GET', '/kpi/calc?year=2026')).excel.week, 'W2639', 'the Excel comparison ignores weeks the CI Manager built');
      const bx = await fetch(`${BASE}/kpi/snapshots/${built.id}/export`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TaskManager' } });
      assert.equal(bx.status, 200, 'a built week exports like any other');
      await call('DELETE', `/kpi/snapshots/${built.id}`);
      // a workbook loaded before templates were kept: the one at the saved path stands in
      fs.rmSync(path.join(tmp, 'kpi', 'template.xlsm'));
      await call('PATCH', '/settings', { kpi_template_week: '' });
      const yr2 = await call('GET', '/kpi/weeks');
      assert.deepEqual([yr2.year, yr2.template, yr2.weeks.length > 50], [2026, true, true], 'every week listed, the year from the weeks loaded');
      const built2 = await call('POST', '/kpi/build', { week: 'W2614_1' });
      assert.equal(built2.origin, 'ci');
      assert.ok(fs.existsSync(path.join(tmp, 'kpi', 'template.xlsm')), 'and is kept as the template');
      assert.equal((await call('GET', '/kpi/weeks')).template_week, 'W2639');
      await call('DELETE', `/kpi/snapshots/${built2.id}`);

      // without file paths, the workbook's import sheets stand in (this workbook has none)
      await call('PATCH', '/settings', { kpi_src_perso: '', kpi_src_shipped: path.join(tmp, 'nope.xlsx') });
      imp = await call('POST', '/kpi/calc/import', { force: true });
      assert.deepEqual(imp.slice(0, 2).map((r) => [r.status, r.from || null]), [['error', null], ['missing', null]]);
      assert.match(imp[0].error, /"PersoImport" isn't in the file/);

      await call('DELETE', `/kpi/snapshots/${wk.id}`);
      assert.equal((await call('GET', '/kpi/snapshots')).length, 0);
    }

    // ---- 🏭 Planning: the open work orders export as a priority list
    {
      const P = require('../src/planning');
      const { buildXlsx: bx } = require('../src/xlsx');
      assert.deepEqual([P.parseDay('Oct  6 2026 '), P.parseDay(46301), P.parseTime('16:00'), P.parseTime('UNDEFINED')], [{ y: 2026, m: 9, d: 6 }, { y: 2026, m: 9, d: 6 }, 960, null]);
      const cols = ['WO', 'PER', 'Card AX', 'QNY', 'Due Out', 'Prio', 'Status', '', 'LIVE', 'GROUP', 'Shipper', 'Shipping Time'].map((h, i) => ({ header: h, type: i === 3 ? 'number' : undefined }));
      const r = (wo, per, ax, q, due, prio, st, ship, time) => [wo, per, ax, q, due, prio, st, '', 'LIVE', 'G', ship, time];
      const exp = bx([{ name: 'OpenPersoWorkorders_PerAx', columns: cols, rows: [
        r('CAESS26100601', '0002', 'A1', 20, 'Oct  7 2026 ', 'Low', 'Ready To Be Started', 'PostNL', '17:00'),
        r('CAESS26100601', '0002', 'A2', 5, 'Oct  7 2026 ', 'Low', 'Ready To Be Started', 'PostNL', '17:00'),
        r('CINDS26100602', '0001', 'B1', 100, 'Oct  7 2026 ', 'High', 'Ready To Be Started', 'DHL', '17:00'),
        r('CKBCS26100603', '0001', 'C1', 50, 'Oct  7 2026 ', 'Low', 'Ready To Be Started', 'De Post', '12:00'),
        r('CRABS26100604', '0001', 'D1', 10, 'Oct  6 2026 ', 'Low', 'In Progress', 'PostNL', '16:00'),
        r('CSIXS26100605', '0001', 'E1', 7, 'Oct  8 2026 ', 'High', 'Ready To Be Started', 'Fedex', 'UNDEFINED'),
      ] }]);
      const parsed = P.parse(exp);
      assert.equal(parsed.lines.length, 6);
      const jobs = P.jobsOf(parsed.lines);
      assert.deepEqual(jobs.map((j) => [j.key, j.qty, j.deadline]), [['CAESS26100601/0002', 25, '2026-10-07T17:00'], ['CINDS26100602/0001', 100, '2026-10-07T17:00'],
        ['CKBCS26100603/0001', 50, '2026-10-07T12:00'], ['CRABS26100604/0001', 10, '2026-10-06T16:00'], ['CSIXS26100605/0001', 7, '2026-10-08T23:59']], 'lines → jobs, deadline = due date at the cut-off');
      assert.equal(jobs[3].running, true);
      assert.equal(jobs[4].no_cutoff, true, 'no cut-off: end of the day, flagged');
      const queue = jobs.filter((j) => !j.running);
      assert.deepEqual(P.order(queue, 'fifo').map((j) => j.customer), ['KBC', 'IND', 'AES', 'SIX'], 'FIFO: deadline first (12:00 before 17:00; High breaks the tie)');
      assert.deepEqual(P.order(queue, 'bau').map((j) => j.customer), ['IND', 'KBC', 'AES', 'SIX'], 'BAU: due day, then High before Low, then cut-off');
      const run = jobs.filter((j) => j.running); const q = P.order(queue, 'fifo');
      assert.equal(P.project(run, q, { rate: 60, lines: 1, start: 360, end: 1320, days: [1, 2, 3, 4, 5] }, new Date(2026, 9, 7, 11, 0)), true);
      assert.deepEqual([run[0].late_minutes, new Date(q[0].finish_at).getHours(), q[0].late_minutes, q[1].late_minutes > 0],
        [19 * 60 + 10, 12, 0, false], '60 cards/h from Wed 11:00: the running job (due Tue 16:00) finishes 11:10, 19 h 10 min late; KBC right at its 12:00 cut-off');
      const at = (d, m, st, en, days = [1, 2, 3, 4, 5]) => P.addWorking(d, m, { start: st, end: en, days });
      assert.equal(at(new Date(2026, 9, 6, 13, 0), 120, 360, 360).getHours(), 15, 'the same start and end: round the clock');
      assert.equal(at(new Date(2026, 9, 6, 23, 0), 180, 1320, 360).getHours(), 2, 'a night shift (22:00–06:00) runs past midnight');
      assert.equal(at(new Date(2026, 9, 6, 13, 0), 60, 1320, 360).getHours(), 23, '… and starts at 22:00');
      assert.equal(at(new Date(2026, 9, 6, 13, 0), 60, 360, 1320, []), null, 'no working days: no working time');
      const wk = P.addWorking(new Date(2026, 9, 9, 21, 0), 120, { start: 360, end: 1320, days: [1, 2, 3, 4, 5] });
      assert.equal(wk.getDate(), 12, 'Fri 21:00 + 2 h of work → Monday');
      assert.equal(wk.getHours() * 60 + wk.getMinutes(), 7 * 60, '… 07:00 (1 h on Friday, 1 h from 06:00 Monday)');
      const slots = P.loadByDeadline(jobs);
      assert.deepEqual(slots.map((x) => [x.deadline.slice(5), x.qty, x.cumulative]), [['10-06T16:00', 10, 10], ['10-07T12:00', 50, 60], ['10-07T17:00', 125, 185], ['10-08T23:59', 7, 192]]);
      // through the API: an uploaded copy, then the linked file
      let pl = await call('GET', '/plan');
      assert.equal(pl.source.status, 'none');
      const up = await fetch(`${BASE}/plan/upload`, { method: 'POST', body: exp, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager' } });
      assert.equal(up.status, 201);
      assert.equal((await fetch(`${BASE}/plan/upload`, { method: 'POST', body: Buffer.from('nope'), headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager' } })).status, 400);
      pl = await call('GET', '/plan?mode=bau');
      assert.deepEqual([pl.source.status, pl.source.uploaded, pl.mode, pl.running.length, pl.queue.map((j) => j.customer), pl.projected], ['ok', true, 'bau', 1, ['IND', 'KBC', 'AES', 'SIX'], false]);
      const linked = path.join(tmp, 'OpenPersoWorkorders_PerAx.xlsx'); fs.writeFileSync(linked, exp);
      await call('PATCH', '/settings', { plan_src: linked, plan_rate: '1000', plan_lines: '2' });
      pl = await call('GET', '/plan');
      assert.deepEqual([pl.source.uploaded, pl.source.name, pl.projected, pl.capacity.rate, pl.capacity.lines], [false, 'OpenPersoWorkorders_PerAx.xlsx', true, 1000, 2]);
      assert.ok(pl.queue.every((j) => j.finish_at), 'each job projected');
      // the card database: AX Ref → type, material, print sides; speeds per kind of card
      const acc = P.readCards({ file: path.join(__dirname, 'fixtures', 'sample.accdb'), table: 'Table1', columns: { key: 'A', type: 'B' } });
      assert.deepEqual([acc.status, acc.count, acc.cards.get('ABCDEFG').type], ['ok', 2, 'hijklmnop'], 'an Access table is read');
      assert.match(P.readCards({ file: path.join(__dirname, 'fixtures', 'sample.accdb') }).error, /no table called "Cards" \(it has Table1/);
      const cardsF = path.join(tmp, 'Cards.xlsx');
      fs.writeFileSync(cardsF, bx([{ name: 'Cards', columns: ['AX Ref', 'Type', 'Material', 'Print Sides', 'Cardbody Name'].map((h) => ({ header: h })), rows: [
        ['A1', 'DOD', 'PVC', 'Front/Back', 'Gold'], ['A2', 'DOD', 'PVC', 'Front', 'Silver'], ['B1', 'Laser', 'PC', 'Front/Back', 'Black'], ['C1', 'DOD', 'PVC', 'Front', 'Blue'],
        ['D1', 'Emboss', 'PVC', 'Front', 'Red'] ] }]));
      await call('PATCH', '/settings', { plan_db: cardsF, plan_rate: '', plan_lines: '1' });
      await assert.rejects(call('POST', '/plan/speeds', { type: 'DOD', speed: 0 }), /above 0/);
      const r1 = await call('POST', '/plan/speeds', { type: 'DOD', material: 'PVC', sides: 'Front', speed: '3000' });
      await call('POST', '/plan/speeds', { type: 'DOD', speed: '1500' });
      await call('POST', '/plan/speeds', { type: 'Laser', speed: 600 });
      assert.equal((await call('POST', '/plan/speeds', { type: 'dod', material: 'pvc', sides: 'front', speed: 2400 })).id, r1.id, 'the same kind again updates it');
      pl = await call('GET', '/plan');
      assert.equal(pl.cards_db.status, 'ok');
      assert.deepEqual(pl.unknown_articles, ['E1'], 'card articles missing from the card database are listed');
      const art = (key, a) => [...pl.running, ...pl.queue].find((j) => j.key === key).articles.find((x) => x.article === a);
      assert.deepEqual([art('CAESS26100601/0002', 'A1').speed, art('CAESS26100601/0002', 'A2').speed, art('CINDS26100602/0001', 'B1').speed], [1500, 2400, 600],
        'most specific rule: DOD PVC Front 2400, other DOD 1500, Laser 600');
      assert.equal(art('CRABS26100604/0001', 'D1').speed_from, 'average', 'no rule (Emboss) and no flat rate → the average of the others');
      assert.equal(art('CSIXS26100605/0001', 'E1').card, null);
      const job = pl.queue.find((j) => j.key === 'CAESS26100601/0002');
      assert.equal(Math.round(job.minutes * 100) / 100, Math.round((20 / 1500 * 60 + 5 / 2400 * 60) * 100) / 100, 'a job takes the sum of its card lines at their speeds');
      assert.equal(pl.projected, true);
      assert.deepEqual(pl.combos.map((c) => [c.type, c.material, c.sides, c.qty]), [['Laser', 'PC', 'Front/Back', 100], ['DOD', 'PVC', 'Front', 55], ['DOD', 'PVC', 'Front/Back', 20], ['Emboss', 'PVC', 'Front', 10]]);
      // machines: each card line on the first free machine that runs its type
      await assert.rejects(call('POST', '/plan/machines', { name: ' ' }), /name/);
      const m1 = await call('POST', '/plan/machines', { name: 'DOD 1', types: 'DOD; ' });
      assert.equal(m1.types, 'DOD');
      pl = await call('GET', '/plan');
      const notDod = [...pl.running, ...pl.queue].find((j) => j.key === 'CINDS26100602/0001');
      assert.deepEqual([notDod.unplanned, notDod.finish_at], [1, null], 'a Laser card with no Laser machine stays unplanned');
      assert.deepEqual(notDod.unplanned_why, ['machine'], '… and says why');
      assert.equal([...pl.running, ...pl.queue].find((j) => j.key === 'CSIXS26100605/0001').articles[0].machine, 'DOD 1', 'a card not in the card database goes on any running machine');
      assert.ok(pl.capacity_by_type.find((t) => t.type === 'Laser').machines.length === 0);
      await call('POST', '/plan/machines', { name: 'Laser 1', types: 'Laser' });
      await call('POST', '/plan/machines', { name: 'Any', types: '' });
      pl = await call('GET', '/plan');
      const all = [...pl.running, ...pl.queue];
      assert.ok(all.every((j) => j.finish_at), 'every job planned once a machine runs each type (blank types: any)');
      assert.deepEqual(all.find((j) => j.key === 'CINDS26100602/0001').machines, ['Laser 1']);
      assert.ok(all.find((j) => j.key === 'CAESS26100601/0002').articles.every((a) => ['DOD 1', 'Any'].includes(a.machine)), 'DOD lines on DOD 1 or the any-type machine');
      const dod = pl.capacity_by_type.find((t) => t.type === 'DOD');
      assert.deepEqual(dod.machines, ['DOD 1', 'Any']);
      assert.ok(Math.abs(dod.max_per_day - dod.speed * 16 * 2) < 40, 'max a day: speed × 16 working hours × 2 machines');
      assert.equal(pl.machine_load.length, 3);
      await call('PATCH', `/plan/machines/${m1.id}`, { active: false });
      assert.equal((await call('GET', '/plan')).capacity_by_type.find((t) => t.type === 'DOD').machines.join(), 'Any', 'a stopped machine doesn\'t count');
      assert.ok((await call('GET', '/audit')).some((e) => e.table_name === 'plan_machines'));
      for (const m of (await call('GET', '/plan')).machines) await call('DELETE', `/plan/machines/${m.id}`);
      await call('PATCH', `/plan/speeds/${r1.id}`, { speed: 3600 });
      await call('DELETE', `/plan/speeds/${r1.id}`);
      assert.ok((await call('GET', '/audit')).some((e) => e.table_name === 'plan_speeds'), 'speeds are audited (and backed up)');
      await call('PATCH', '/settings', { plan_src: path.join(tmp, 'gone.xlsx') });
      assert.equal((await call('GET', '/plan')).source.status, 'missing');
    }

    await call('POST', '/shutdown');
    const code = await new Promise((r) => server.once('exit', r));
    assert.equal(code, 0, 'server exits cleanly on shutdown');

    console.log('\n✔ Smoke test passed');
  } catch (err) {
    console.error('\n✘ Smoke test failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (server.exitCode === null) {
      server.kill();
      await new Promise((r) => server.once('exit', r));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
