'use strict';
// Status report: what happened on each project over a period, ready to paste
// into an email, download for Word, or print. Loaded before app.js.

const REPORT_PERIODS = {
  last7: 'Last 7 days', thisweek: 'This week', lastweek: 'Last week', since: 'Since last report', custom: 'Custom dates',
};

function reportRange(period, custom, lastSent) {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const back = (d, n) => { const r = new Date(d); r.setDate(r.getDate() - n); return r; };
  switch (period) {
    case 'thisweek': return [dateKey(monday), dateKey(today)];
    case 'lastweek': return [dateKey(back(monday, 7)), dateKey(back(monday, 1))];
    case 'since': return [lastSent ? dateKey(new Date(lastSent)) : dateKey(back(today, 6)), dateKey(today)];
    case 'custom': return [custom.from || dateKey(back(today, 6)), custom.to || dateKey(today)];
    default: return [dateKey(back(today, 6)), dateKey(today)];
  }
}

const rDate = (key) => new Date(`${key}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const rMoney = (v, cur) => `${cur}${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Turns the API result into sections, shared by the page, the text and the Word versions.
function reportModel(r) {
  const projects = r.projects.map((p) => {
    const health = projectHealth({ ...p, overdue_count: p.overdue.length, blocked_count: p.blocked.length });
    const slip = p.baseline_due_at && p.due_at && p.baseline_due_at !== p.due_at
      ? Math.round((new Date(p.due_at) - new Date(p.baseline_due_at)) / 86400000) : 0;
    const facts = [
      `${p.done_count}/${p.task_count} tasks done${p.task_count ? ` (${Math.round((p.done_count / p.task_count) * 100)}%)` : ''}`,
      p.due_at ? `due ${fmtDate(p.due_at)}${slip ? ` (${slip > 0 ? '+' : ''}${slip} days vs baseline)` : ''}` : null,
      p.budget !== null && p.budget !== undefined ? `spent ${rMoney(p.spent, r.currency)} of ${rMoney(p.budget, r.currency)} budget` : (p.spent ? `spent ${rMoney(p.spent, r.currency)}` : null),
      p.spent_in_period ? `${rMoney(p.spent_in_period, r.currency)} spent this period` : null,
    ].filter(Boolean);
    const t = (x) => x.title + (x.parent_id ? ' (subtask)' : '');
    const sections = [
      ['✅ Completed', p.completed.map((x) => `${t(x)} — ${fmtDate(x.completed_at)}`)],
      ['▶ Started', p.started.map((x) => x.title)],
      ['➕ Added', p.added.map((x) => `${t(x)}${p.baseline_set_at && !x.is_baseline ? ' (new scope)' : ''}`)],
      ['📅 Date changes', p.due_changes.map((m) => `${m.what}: ${m.from ? fmtDate(m.from) : 'no date'} → ${m.to ? fmtDate(m.to) : 'no date'}`)],
      ['⛔ Blocked', p.blocked.map((x) => t(x))],
      ['⏳ Waiting on others', p.waiting.map((x) => `${t(x)} — waiting on ${x.waiting_on}${x.waiting_since ? ` for ${daysSince(x.waiting_since)} days` : ''}`)],
      ['⚠ Overdue', p.overdue.map((x) => `${t(x)} — was due ${fmtDate(x.due_at)}`)],
      ['🔜 Coming up (next 14 days)', p.upcoming.map((x) => `${t(x)} — due ${fmtDate(x.due_at)}`)],
      ['📝 Notes', p.notes.map((n) => `${fmtDate(n.created_at)}${n.task_title ? ` [${n.task_title}]` : ''}: ${n.body}`)],
    ].filter(([, items]) => items.length);
    const quiet = !p.completed.length && !p.added.length && !p.notes.length && !p.due_changes.length && !p.started.length;
    return { id: p.id, name: p.name, status: p.status, health, facts, sections, quiet };
  }).sort((a, b) => a.quiet - b.quiet); // projects with news first
  const ideas = r.ideas ? [
    ['💡 New ideas', r.ideas.raised.map((i) => `${i.ref} ${i.title}${i.submitted_by ? ` (from ${i.submitted_by})` : ''}${i.cost !== null ? ` — ${rMoney(i.cost, r.currency)}` : ''}`)],
    ['🔄 Idea status changes', r.ideas.status_changes.map((c) => `${c.ref} ${c.title}: ${IDEA_STATUS[c.from] || c.from} → ${IDEA_STATUS[c.to] || c.to}`)],
  ].filter(([, items]) => items.length) : [];
  const count = (k) => r.projects.reduce((n, p) => n + p[k].length, 0);
  const summary = `${r.projects.length} project${r.projects.length === 1 ? '' : 's'} · ${count('completed')} tasks completed · `
    + `${count('added')} added · ${count('overdue')} overdue · ${count('blocked')} blocked · ${count('waiting')} waiting on others`;
  const title = r.from === r.to ? `Status report — ${rDate(r.from)}` : `Status report — ${rDate(r.from)} to ${rDate(r.to)}`;
  return { title, summary, projects, ideas, generated: fmtDateTime(r.generated_at) };
}

function reportHtml(m) {
  const list = ([head, items]) => `<h4>${esc(head)}</h4><ul>${items.map((i) => `<li class="pre">${linkify(i)}</li>`).join('')}</ul>`;
  return `<h1>${esc(m.title)}</h1>
    <p class="muted">${esc(m.summary)}<br><span class="small">Generated ${esc(m.generated)}</span></p>
    ${m.projects.map((p) => `<section class="r-project">
      <h2>${esc(p.name)} <span class="health health-${p.health.key}" title="${esc(p.health.why)}">${p.health.icon} ${p.health.label}</span>
        ${p.status !== 'active' ? `<span class="small muted">${esc(PSTATUS[p.status])}</span>` : ''}</h2>
      <p class="small muted">${esc(p.facts.join(' · '))}</p>
      ${p.quiet ? '<p class="small muted"><i>No new activity in this period.</i></p>' : ''}
      ${p.sections.map(list).join('')}
    </section>`).join('') || '<p class="empty">No projects to report on.</p>'}
    ${m.ideas.length ? `<section class="r-project"><h2>Ideas</h2>${m.ideas.map(list).join('')}</section>` : ''}`;
}

function reportText(m) {
  const lines = [m.title, m.summary, ''];
  for (const p of m.projects) {
    lines.push(`■ ${p.name} — ${p.health.label}${p.status !== 'active' ? ` (${PSTATUS[p.status]})` : ''}`);
    lines.push(`  ${p.facts.join(' · ')}`);
    if (p.quiet) lines.push('  No new activity in this period.');
    for (const [head, items] of p.sections) {
      lines.push(`  ${head}`);
      for (const i of items) lines.push(`    • ${i.replace(/\n/g, '\n      ')}`);
    }
    lines.push('');
  }
  if (m.ideas.length) {
    lines.push('■ Ideas');
    for (const [head, items] of m.ideas) {
      lines.push(`  ${head}`);
      for (const i of items) lines.push(`    • ${i}`);
    }
  }
  return lines.join('\n').trim();
}

function reportWord(m) {
  const style = `body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#1d2330}
    h1{font-size:18pt;margin:0 0 4pt}h2{font-size:14pt;margin:16pt 0 2pt;border-bottom:1px solid #dde2ea}
    h4{font-size:11pt;margin:8pt 0 2pt}ul{margin:0 0 4pt 18pt;padding:0}.muted{color:#687185}.small{font-size:9pt}
    .health{font-size:10pt;font-weight:normal;color:#687185}.pre{white-space:pre-wrap}`;
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
    <head><meta charset="utf-8"><title>${esc(m.title)}</title><style>${style}</style></head>
    <body>${reportHtml(m).replace(/<a [^>]*data-path="([^"]*)"[^>]*>📁 [^<]*<\/a>/g, '$1')}</body></html>`;
}

async function renderReport(projectFromRoute) {
  const settings = await api.get('/settings');
  state.settings = settings;
  const saved = { period: 'last7', project: '', from: '', to: '', ...store.get('report', {}) };
  if (projectFromRoute) saved.project = projectFromRoute;
  const [from, to] = reportRange(saved.period, saved, settings.report_last_sent);
  const qs = new URLSearchParams({ from, to });
  if (saved.project) qs.set('project_id', saved.project);
  const r = await api.get(`/report?${qs}`);
  const m = reportModel(r);
  const projects = state.projects.filter((p) => p.status !== 'archived');

  main().innerHTML = `
    <div class="kanban-tools report-tools">
      <h1 style="margin:0">📰 Report</h1><div class="spacer"></div>
      <select id="r-period">${options(REPORT_PERIODS, saved.period)}</select>
      ${saved.period === 'custom' ? `<input type="date" id="r-from" value="${esc(from)}"> to <input type="date" id="r-to" value="${esc(to)}">` : ''}
      <select id="r-project"><option value="">All projects</option>${projects.map((p) =>
        `<option value="${p.id}" ${String(p.id) === String(saved.project) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    </div>
    <div class="kanban-tools report-tools">
      <button class="primary" data-r="copy">📋 Copy as text</button>
      <button data-r="word">⬇ Word</button>
      <button data-r="print">🖨 Print / PDF</button>
      <button data-r="sent" title="Remember now as the last report date, for 'Since last report'">✓ Mark as sent</button>
      <span class="small muted">${settings.report_last_sent ? `Last marked as sent ${esc(fmtDateTime(settings.report_last_sent))}` : 'Not marked as sent yet'}</span>
    </div>
    <div class="card report" id="report-body">${reportHtml(m)}</div>`;

  const save = (patch) => {
    store.set('report', { ...saved, ...patch });
    if (projectFromRoute) location.hash = '#/report'; else renderReport();
  };
  $('#r-period').addEventListener('change', (e) => save({ period: e.target.value, from, to }));
  $('#r-project').addEventListener('change', (e) => save({ project: e.target.value }));
  $('#r-from')?.addEventListener('change', (e) => save({ from: e.target.value }));
  $('#r-to')?.addEventListener('change', (e) => save({ to: e.target.value }));
  $('[data-r="copy"]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(reportText(m)); toast('Report copied — paste it into an email'); } catch {
      toast('Could not copy automatically — select the report and copy it', 'error');
    }
  });
  $('[data-r="word"]').addEventListener('click', () => {
    const blob = new Blob(['﻿', reportWord(m)], { type: 'application/msword' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Status report ${from}${from === to ? '' : ` to ${to}`}.doc`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('[data-r="print"]').addEventListener('click', () => window.print());
  $('[data-r="sent"]').addEventListener('click', async () => {
    await api.patch('/settings', { report_last_sent: new Date().toISOString() });
    toast('Marked as sent — "Since last report" starts from now');
    renderReport(projectFromRoute);
  });
}
