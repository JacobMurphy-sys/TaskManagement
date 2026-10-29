'use strict';
// 🎯 Today's and this week's focus: a few open tasks and topics to look at first, each with why —
// from due dates, priority, what's been started, who's being waited on, how long it's been open,
// and projects that need attention. Works on plain rows, so it can be tested on its own.
//
//   focus({ tasks, projects, now }) -> { day: [item], week: [item], more_overdue }
//   item: { kind: 'task' | 'project', id, title, project_id, project_name, parent_title, owner,
//           score, reasons: [text] }

const DAY = 86400000;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const days = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / DAY); // a − b, in whole days
const weekday = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short' });

function focus({ tasks = [], projects = [], now = new Date() }) {
  const open = tasks.filter((t) => t.status !== 'done');
  const item = (t, score, reasons) => ({ kind: 'task', id: t.id, title: t.title, project_id: t.project_id || null, project_name: t.project_name || null,
    parent_title: t.parent_title || null, owner: t.owner || null, due_at: t.due_at || null, priority: t.priority, score, reasons });

  // ---- today: what's late or due, what's been started, who to chase
  const dayList = [];
  for (const t of open) {
    if (t.status === 'blocked') continue; // can't be done today — it's a topic for the week
    let s = 0; const why = [];
    const due = t.due_at ? days(t.due_at, now) : null;
    if (due !== null && due < 0) { s += 100 + Math.min(-due, 30) * 2; why.push(`overdue ${-due} d`); }
    else if (due === 0) { s += 80; why.push('due today'); }
    else if (due === 1) { s += 45; why.push('due tomorrow'); }
    else if (due !== null && due <= 3 && t.priority >= 3) { s += 35; why.push(`due ${weekday(t.due_at)}`); }
    if (t.priority >= 4) { s += 25; why.push('critical'); } else if (t.priority === 3 && s) { s += 12; why.push('high priority'); }
    if (t.status === 'in_progress' && s) { s += 15; why.push('started — finish it'); }
    if (t.waiting_on && t.waiting_since) { const w = days(now, t.waiting_since); if (w >= 3) { s += 30 + Math.min(w, 20); why.push(`chase ${t.waiting_on} (${w} d)`); } }
    if (s >= 30) dayList.push(item(t, s, why));
  }
  dayList.sort((a, b) => b.score - a.score || String(a.due_at || '9').localeCompare(String(b.due_at || '9')));
  const DAY_MAX = 6;
  const day = dayList.slice(0, DAY_MAX);
  const moreOverdue = dayList.slice(DAY_MAX).filter((x) => x.reasons.some((r) => r.startsWith('overdue'))).length;
  const inDay = new Set(day.map((x) => x.id));

  // ---- this week: coming up, stuck, left too long, and projects to talk about
  const week = [];
  for (const t of open) {
    if (inDay.has(t.id)) continue;
    let s = 0; const why = [];
    const due = t.due_at ? days(t.due_at, now) : null;
    const age = t.created_at ? days(now, t.created_at) : 0;
    if (t.status === 'blocked') { s += 35; why.push('blocked — what would unblock it?'); }
    if (due !== null && due >= 0 && due <= 7) { s += 40 - due * 3; why.push(due <= 1 ? `due ${due ? 'tomorrow' : 'today'}` : `due ${weekday(t.due_at)}`); }
    else if (due !== null && due < 0) { s += 30; why.push(`overdue ${-due} d`); }
    if (t.status === 'todo' && age >= 30 && (due === null || due > 14)) { s += 18 + Math.min(age / 10, 15); why.push(`open ${Math.round(age / 7)} weeks`); }
    if (t.priority >= 3 && s) s += t.priority === 4 ? 10 : 5;
    if (s >= 20) week.push(item(t, s, why));
  }
  for (const p of projects) {
    if (p.status !== 'active') continue;
    let s = 0; const why = [];
    if (p.overdue_count) { s += 30 + p.overdue_count * 4; why.push(`${p.overdue_count} overdue task${p.overdue_count === 1 ? '' : 's'}`); }
    if (p.blocked_count) { s += 15; why.push(`${p.blocked_count} blocked`); }
    const due = p.due_at ? days(p.due_at, now) : null;
    if (due !== null && due < 0) { s += 30; why.push(`past its due date (${-due} d)`); } else if (due !== null && due <= 14) { s += 20; why.push(`due ${due <= 7 ? weekday(p.due_at) : `in ${due} d`}`); }
    const ph = p.current_phase; const phd = ph?.due_at ? days(ph.due_at, now) : null;
    if (phd !== null && phd <= 7) { s += 15; why.push(phd < 0 ? `phase “${ph.name}” was due ${-phd} d ago` : `phase “${ph.name}” ends ${weekday(ph.due_at)}`); }
    if (s && !p.next_action) why.push('no next action set');
    if (s >= 20) week.push({ kind: 'project', id: p.id, title: p.name, project_id: p.id, project_name: p.name, owner: p.leader || null, next_action: p.next_action || null, score: s, reasons: why });
  }
  week.sort((a, b) => b.score - a.score);
  return { day, week: week.slice(0, 8), more_overdue: moreOverdue };
}

module.exports = { focus };
