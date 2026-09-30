// End-to-end smoke test. Starts the server on a spare port with a throw-away
// database in a temp folder, and exercises the API. Usage: npm test
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const PORT = 3999;
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
      DB_FILE: path.join(tmp, 'test.db'), BACKUP_DIR: path.join(tmp, 'backups'), LOG_DIR: path.join(tmp, 'logs'),
    },
    stdio: 'inherit',
  });
  try {
    await waitForServer();

    const p = await call('POST', '/projects', {
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

    const escalated = await call('POST', `/ideas/${idea1.id}/escalate`, { baseline_tasks: ['Build model', 'Pilot'] });
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

    // Change requests without the app's header are refused (blocks other websites).
    const bare = await fetch(`${BASE}/backups`, { method: 'POST' });
    assert.equal(bare.status, 403, 'request without X-Requested-With refused');
    assert.equal((await call('GET', '/health')).app, 'taskmanager');

    // Deleting a project cascades and is audited.
    await call('DELETE', `/projects/${p.id}`);
    const log = await call('GET', `/audit?project_id=${p.id}`);
    assert.ok(log.some((e) => e.action === 'DELETE' && e.table_name === 'projects'), 'project delete audited');
    assert.equal((await call('GET', `/tasks?project_id=${p.id}`)).length, 0, 'tasks cascaded');

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
