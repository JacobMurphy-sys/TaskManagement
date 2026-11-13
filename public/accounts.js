// 👤 Accounts (src/accounts.js): sign-in when they're on, your password, 📥 My work, and the
// admin's list of accounts in Settings. Off until the first account is made: nothing changes until then.
const ACCT = { enabled: false, account: null, newCount: 0, modules: [], areas: [], rights: [] };

// 👁 every password box gets an eye to show what's been typed (sign-in, changing your own, setting one for someone):
// added to any that appears, now or later; it goes back to hidden when the form is sent or the box is left empty
const PW_EYE = { show: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  hide: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M2 12s3.6-7 10-7c2 0 3.8.7 5.2 1.6M22 12s-3.6 7-10 7c-2 0-3.8-.7-5.2-1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M4 20 20 4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>' };
function pwEyes(root = document) {
  for (const inp of root.querySelectorAll('input[type=password]:not([data-pw-eye])')) {
    inp.dataset.pwEye = '1';
    const wrap = document.createElement('span'); wrap.className = 'pw-wrap';
    inp.replaceWith(wrap); wrap.append(inp);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pw-eye'; b.tabIndex = -1; b.innerHTML = PW_EYE.show; b.title = 'Show the password'; b.setAttribute('aria-label', 'Show the password');
    const set = (shown) => { inp.type = shown ? 'text' : 'password'; b.innerHTML = shown ? PW_EYE.hide : PW_EYE.show; const t = shown ? 'Hide the password' : 'Show the password'; b.title = t; b.setAttribute('aria-label', t); b.classList.toggle('on', shown); };
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the typing where it is
    b.addEventListener('click', () => { const at = [inp.selectionStart, inp.selectionEnd]; set(inp.type === 'password'); inp.focus(); try { inp.setSelectionRange(...at); } catch { /* fine */ } });
    inp.form?.addEventListener('submit', () => set(false));
    inp.addEventListener('input', () => { if (!inp.value) set(false); });
    wrap.append(b);
  }
}
new MutationObserver((list) => { // only what was just added is looked at
  for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches('input[type=password]') || n.querySelector?.('input[type=password]'))) { pwEyes(n.parentNode || document); return; }
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', () => pwEyes());

// 🧩 Modules: the parts of the app an account can see (admins and no-accounts: all of them).
const MOD_OF_VIEW = { team: 'team', capex: 'capex', kanban: 'projects', project: 'projects', ideas: 'ideas', idea: 'ideas', planning: 'planning', cpm: 'cpm', forecast: 'forecast', report: 'report', contacts: 'contacts' };
// areas (projects, kpi, ideas, planning, report, contacts), each part of a module (Management: projects and kpi)
const modOk = (area) => !ACCT.account || (ACCT.account.areas || []).includes(area);
// 📊 Reporting's tabs, each with the area (module) it needs: the Weekly SC Report, Database and Operations (Prod
// Management), Quality and EHS (Quality), Sources (Admin). Reporting is in the top bar for any of them.
const KPI_TABS = [['a3', 'Weekly SC Report', 'kpi', '#/kpi'], ['database', 'Database', 'kpi', '#/kpi/0/database'], ['operations', '🏭 Operations', 'kpi', '#/kpi/operations'], ['otd', '🚚 OTD', 'otd', '#/kpi/otd'], ['quality', '🧪 Quality', 'quality', '#/kpi/quality'],
  ['ehs', '⛑ EHS', 'quality', '#/kpi/ehs'], ['sources', 'Sources', 'kpi_sources', '#/kpi/sources']];
const kpiTabOk = (tab) => modOk(KPI_TABS.find((t) => t[0] === tab)?.[2] || 'kpi');
const reportingOk = () => KPI_TABS.some(([k]) => kpiTabOk(k));
// the Reporting tab an address is on (#/kpi/12/database → database)
const kpiTabOf = (rest) => (['sources', 'calc'].includes(rest[0]) ? 'sources' : ['quality', 'ehs', 'operations', 'otd'].includes(rest[0]) ? rest[0] : rest[1] === 'database' ? 'database' : 'a3');
// 🔒 admin rights (src/accounts.js RIGHTS): setup, accounts, backups, server. Admins and the host have
// them all; the host gives some to other accounts. With accounts off, whoever is here has them.
const acctRight = (key) => !ACCT.enabled || (ACCT.account?.rights || []).includes(key);
const acctAdmin = () => acctRight('setup'); // the setup: Settings, Planning's setup, KPI sources, the library
const acctOwner = () => !ACCT.enabled || !!ACCT.account?.owner;
function modApply() {
  document.body.classList.toggle('not-admin', !acctAdmin());
  $$('#top-menu a[data-nav="backups"]').forEach((a) => { a.hidden = !acctRight('backups'); });
  $$('#topnav a[data-nav], #top-menu a[data-nav]').forEach((a) => { const m = MOD_OF_VIEW[a.dataset.nav]; if (m) a.hidden = !modOk(m); else if (a.dataset.nav === 'kpi') a.hidden = !reportingOk(); });
  for (const a of ACCT.areas) document.body.classList.toggle(`nomod-${a}`, !modOk(a));
}

// At start-up: who's signed in. → false when the sign-in page is showing instead of the app.
async function acctInit() {
  let me0;
  try { me0 = await api.get('/auth/me'); } catch { return true; }
  ACCT.enabled = !!me0.enabled; ACCT.account = me0.account; ACCT.modules = me0.modules || []; ACCT.areas = me0.areas || []; ACCT.rights = me0.rights || [];
  if (ACCT.enabled && !ACCT.account) { renderSignIn(); return false; }
  if (ACCT.account) {
    if (ACCT.account.theme) setTheme(ACCT.account.theme, { save: false }); // your appearance, from your account
    me.setName(ACCT.account.person); // who's here and who changed what: the account's person
    acctChrome(); modApply();
    if (ACCT.account.training) trainingBanner(); // 🎓 the training copy
    if (ACCT.account.must_change) await acctPasswordDialog(true);
    acctPoll(); setInterval(acctPoll, 60000);
  }
  return true;
}

function renderSignIn(msg = '') {
  document.body.classList.add('signin-page');
  document.getElementById('signin')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="signin" id="signin"><form class="card signin-card" id="signin-form">
      <h1><img src="favicon.svg" alt="" class="brand-ico lg">SITHUB</h1><p class="muted small">Sign in with the account you were given.</p>
      <label class="f">Username<input type="text" name="username" autocomplete="username" required autofocus></label>
      <label class="f">Password<input type="password" name="password" autocomplete="current-password" required></label>
      <div class="signin-msg" id="signin-msg">${esc(msg)}</div>
      <button class="primary" type="submit">Sign in</button>
      <p class="small muted" style="margin-bottom:0">Forgotten your password? Ask an admin to set a new one.</p></form></div>`);
  document.querySelector('#signin [name=username]')?.focus();
  document.getElementById('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.post('/auth/login', { username: fd.get('username'), password: fd.get('password') });
      location.reload();
    } catch (err) { document.getElementById('signin-msg').textContent = err.message; }
  });
}

// Your password: forced (a new account, or one an admin reset) or from the menu.
function acctPasswordDialog(forced = false) {
  return new Promise((resolve) => {
    const d = collabDialog(`<form method="dialog" id="pw-form"><h3 style="margin-top:0">🔑 ${forced ? 'Choose your own password' : 'Change your password'}</h3>
      ${forced ? '<p class="small muted">You signed in with a password someone else set. Pick one only you know (at least 8 characters).</p>' : ''}
      <label class="f">Current password<input type="password" name="current" autocomplete="current-password" required></label>
      <label class="f">New password<input type="password" name="next" autocomplete="new-password" minlength="8" required></label>
      <label class="f">New password again<input type="password" name="again" autocomplete="new-password" minlength="8" required></label>
      <div class="signin-msg" id="pw-msg"></div>
      <div class="row" style="margin-top:8px"><span class="spacer"></span>${forced ? '' : '<button value="cancel" formnovalidate>Cancel</button>'}<button class="primary" value="ok">Save</button></div></form>`);
    if (forced) d.addEventListener('cancel', (e) => e.preventDefault());
    d.querySelector('form').addEventListener('submit', async (e) => {
      if (e.submitter?.value === 'cancel') return;
      e.preventDefault();
      const fd = new FormData(e.target);
      if (fd.get('next') !== fd.get('again')) { d.querySelector('#pw-msg').textContent = 'The new passwords don\'t match'; return; }
      try { await api.post('/auth/password', { current: fd.get('current'), next: fd.get('next') }); ACCT.account.must_change = false; toast('Password changed'); d.close(); } catch (err) { d.querySelector('#pw-msg').textContent = err.message; }
    });
    d.addEventListener('close', () => resolve());
  });
}

// The top bar for a signed-in person: 📥 My work (with what's new), and their menu.
function acctChrome() {
  const nav = $('#topnav');
  if (nav && !$('[data-nav="mine"]', nav)) nav.insertAdjacentHTML('afterbegin', '<a href="#/mine" data-nav="mine" title="What\'s assigned to you"><span class="ico">📥</span><span class="lbl"> My work</span> <span id="mine-count" class="count" hidden>0</span></a>');
  const menu = $('#top-menu');
  if (menu && !$('[data-action="sign-out"]', menu)) {
    menu.insertAdjacentHTML('afterbegin', `<div class="small muted" style="padding:4px 10px">Signed in as <b>${esc(ACCT.account.person)}</b> (${esc(ACCT.account.username)}${ACCT.account.owner ? ', host' : ACCT.account.role === 'admin' ? ', admin' : ''})</div>
      ${ACCT.account.role === 'admin' ? `<button data-action="see-all" title="An admin's view of every task and project, not just their own and what they're invited to (it's noted in the activity log)">👁 All work: ${ACCT.account.see_all ? 'on' : 'off'}</button>` : ''}
      <button data-action="change-password">🔑 Change password</button><button data-action="sign-out">↪ Sign out</button><hr>`);
  }
  seeAllBar();
  // with an account, the name comes from it
  $$('[data-action="set-name"]').forEach((b) => { b.nextElementSibling?.tagName === 'HR' && b.nextElementSibling.remove(); b.remove(); });
}
// 👁 an admin with All work on: a bar on every page, so it's never on by mistake
function seeAllBar() {
  document.getElementById('see-all-bar')?.remove();
  if (!ACCT.account?.see_all) return;
  document.getElementById('topbar')?.insertAdjacentHTML('afterend', `<div id="see-all-bar" class="see-all-bar" role="status">👁 <b>All work is on:</b> you see every task and project, not just your own and what you're invited to.
    <button type="button" class="small" data-action="see-all">Turn it off</button></div>`);
}
async function toggleSeeAll() {
  try {
    const r = await api.put('/me/see-all', { on: !ACCT.account.see_all });
    ACCT.account.see_all = r.see_all;
    const b = $('#top-menu [data-action="see-all"]'); if (b) b.textContent = `👁 All work: ${r.see_all ? 'on' : 'off'}`;
    seeAllBar(); toast(r.see_all ? '👁 All work on: every task and project' : 'All work off: your own and what you\'re invited to'); route();
  } catch (err) { toast(err.message, 'error'); }
}

// ---- 🔒 who sees a task or project: who made it, who's on it, who's invited, and inviting someone ----------------
async function accessPanel(el, kind, id) {
  if (!el) return;
  let d; let people;
  try { [d, people] = await Promise.all([api.get(`/access/${kind}/${id}`), api.get('/access/people')]); } catch (err) { el.innerHTML = `<span class="small muted">${esc(err.message)}</span>`; return; }
  const why = { leader: 'leads it', sponsor: 'sponsors it', team: 'on the team', owner: 'owns it', 'owner of this subtask': 'owns this subtask' };
  const invited = new Set(d.invited.map((i) => i.account_id));
  const choices = people.filter((p) => p.id !== d.creator?.id && !invited.has(p.id));
  const autoChip = (a) => (a.person ? `<span class="chip acc-chip">${esc(a.person)} <span class="muted">· ${esc(why[a.why] || a.why)}</span></span>`
    : `<span class="chip acc-chip">${esc(a.why)}${a.project ? ` “${esc(a.project)}”` : a.task ? ` “${esc(a.task)}”` : ''}</span>`);
  el.innerHTML = `<div class="acc">
    <div class="acc-line small"><span class="muted">Made by</span> <b>${esc(d.creator?.person || '—')}</b></div>
    ${d.auto.length ? `<div class="acc-line small"><span class="muted">Also sees it, by being on it:</span> ${d.auto.map(autoChip).join(' ')}</div>` : ''}
    <div class="acc-line small"><span class="muted">Invited:</span> ${d.invited.length ? d.invited.map((i) => `<span class="chip acc-chip">${esc(i.person)}${d.can_invite ? ` <button type="button" class="icon acc-x" data-acc-remove="${i.account_id}" title="Stop sharing it with ${esc(i.person)}">✕</button>` : ''}</span>`).join(' ') : '<span class="muted">nobody yet</span>'}</div>
    ${d.can_invite ? `<select class="tm-quiet-select" data-acc-pick><option value="">＋ Invite someone…</option>${choices.map((p) => `<option value="${p.id}">${esc(p.person)}</option>`).join('')}</select>
      <div class="small muted">${kind === 'task' ? 'Anyone invited sees this task, its subtasks and notes.' : 'Anyone invited sees the whole project: its tasks, notes and costs. Putting someone on the team does the same.'}</div>` : ''}
    ${d.note ? `<div class="small muted">🔒 ${esc(d.note)}</div>` : ''}</div>`;
  el.querySelector('[data-acc-pick]')?.addEventListener('change', async (e) => {
    const v = e.target.value; if (!v) return;
    try { await api.post(`/access/${kind}/${id}`, { account_id: Number(v) }); toast(`Shared with ${people.find((p) => p.id === Number(v))?.person || 'them'}`); accessPanel(el, kind, id); } catch (err) { toast(err.message, 'error'); }
  });
  el.querySelectorAll('[data-acc-remove]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.del(`/access/${kind}/${id}/${b.dataset.accRemove}`); accessPanel(el, kind, id); } catch (err) { toast(err.message, 'error'); }
  }));
}

async function acctPoll() {
  if (!ACCT.account) return;
  try {
    const w = await api.get('/me/work');
    ACCT.newCount = w.new.length;
    const c = $('#mine-count'); if (c) { c.hidden = !w.new.length; c.textContent = w.new.length; }
  } catch { /* next time */ }
}

// ---- 📥 My work ----------------------------------------------------------------------------------
async function renderMine() {
  if (!ACCT.account) { main().innerHTML = '<div class="card"><h2>📥 My work</h2><p class="muted">My work is for signed-in accounts. Accounts are set up in ⚙ Settings › 👤 Accounts.</p></div>'; return; }
  const w = await api.get('/me/work');
  const when = (iso) => fmtDateTime(iso);
  const taskRow = (t) => `<tr><td><span class="t" data-action="open-task" data-id="${t.id}">${esc(t.title)}</span>${t.project_name ? `<div class="small muted"><a href="#/project/${t.project_id}">${esc(t.project_name)}</a></div>` : ''}</td>
      <td>${statusChip(t.status) || `<span class="muted small">${esc(STATUS[t.status] || t.status)}</span>`}</td><td class="nowrap">${t.due_at ? dueChip(t) : '<span class="muted">—</span>'}</td><td class="small">${esc(splitOwners(t.owner).filter((n) => n.toLowerCase() !== w.account.person.toLowerCase()).join(', '))}</td></tr>`;
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">📥 My work</h1><span class="muted">— ${esc(w.account.person)}</span><div class="spacer"></div>
      ${w.new.length ? '<button data-mine="seen">✓ Mark the new ones as seen</button>' : ''}</div>
    ${w.new.length ? `<div class="card mine-new"><h2>New for you <span class="muted small">— since ${esc(when(w.seen_at))}</span></h2><ul class="mine-list">
      ${w.new.map((n) => `<li>${n.kind === 'task' ? `✅ <span class="t" data-action="open-task" data-id="${n.id}">${esc(n.title)}</span> <span class="muted small">— a task for you</span>`
        : `📋 <a href="#/project/${n.id}">${esc(n.title)}</a> <span class="muted small">— you're ${esc(n.role === 'leader' ? 'the leader' : n.role === 'sponsor' ? 'the sponsor' : `on the team (${n.role})`)}</span>`}
        <span class="small muted">· ${n.by ? `by ${esc(n.by)}, ` : ''}${esc(when(n.at))}</span></li>`).join('')}</ul></div>` : ''}
    <div class="card"><h2>My tasks <span class="muted small">${w.tasks.length}</span></h2>
      ${w.tasks.length ? `<table class="log"><thead><tr><th>Task</th><th>Status</th><th>Due</th><th>With</th></tr></thead><tbody>${w.tasks.map(taskRow).join('')}</tbody></table>`
        : '<div class="empty">No open tasks with your name as an owner.</div>'}</div>
    <div class="card"><h2>My projects <span class="muted small">${w.projects.length}</span></h2>
      ${w.projects.length ? `<table class="log"><thead><tr><th>Project</th><th>Your part</th><th>Status</th><th>Due</th></tr></thead><tbody>
        ${w.projects.map((p) => `<tr><td><a href="#/project/${p.id}"><b>${esc(p.name)}</b></a></td><td>${esc(p.roles.join(', '))}</td><td>${esc(PSTATUS[p.status] || p.status)}</td><td>${p.due_at ? esc(fmtDate(p.due_at)) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No active projects with you as leader, sponsor or on the team.</div>'}</div>
    <p class="small muted">Tasks are yours when your name (${esc(w.account.person)}) is one of their owners; projects when you're the leader, the sponsor or on the team.</p>`;
  $('[data-mine="seen"]')?.addEventListener('click', async () => { await api.post('/me/work/seen', {}); await acctPoll(); renderMine(); });
}

// ---- ⚙ Settings › 👤 Accounts ------------------------------------------------------------------
async function acctSettingsHtml() {
  if (!acctRight('accounts')) return '';
  const owner = acctOwner();
  let list = [];
  if (ACCT.enabled) { try { list = await api.get('/accounts'); } catch { list = []; } }
  let people = [];
  try { const groups = await api.get('/owner-options'); const seen = new Set(); people = groups.flatMap((g) => g.names).filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())); } catch { /* none */ }
  const extra = ACCT.modules.filter((m) => !m.always);
  const basic = ACCT.modules.find((m) => m.always);
  const ticks = (a) => (a.role === 'admin' ? '<span class="small muted">all — admins have every module</span>'
    : `<div class="mod-ticks">${extra.map((m) => `<label title="${esc(`${m.label}: ${m.what}`)}"><input type="checkbox" data-mod="${m.key}" ${a.modules.includes(m.key) ? 'checked' : ''}> ${m.icon} ${esc(m.label)}</label>`).join('')}</div>`);
  // admin rights: the host chooses them; others see them
  const rightsCell = (a) => {
    if (a.owner) return '<span class="acct-host">🏠 Host</span> <span class="small muted">— everything; gives the rights</span>';
    if (!owner) return a.role === 'admin' ? '<b>Admin</b> <span class="small muted">— every right</span>' : a.rights.length ? esc(ACCT.rights.filter((r) => a.rights.includes(r.key)).map((r) => `${r.icon} ${r.label}`).join(' · ')) : '<span class="muted">User</span>';
    return `<select name="role">${options({ user: 'User', admin: 'Admin — every right' }, a.role)}</select>
      ${a.role === 'admin' ? '' : `<div class="mod-ticks acct-rights">${ACCT.rights.map((r) => `<label title="${esc(`${r.label}: ${r.what}`)}"><input type="checkbox" data-right="${r.key}" ${a.rights.includes(r.key) ? 'checked' : ''}> ${r.icon} ${esc(r.label)}</label>`).join('')}</div>`}`;
  };
  const canEdit = (a) => !a.owner && (owner || a.role !== 'admin');
  const presets = [['Basic pack only', []], ['Production: Basic + Prod Management', ['production']], ['Quality: Basic + Quality', ['quality']], ['Manager: everything', extra.map((m) => m.key)]];
  const form = (first) => `<form id="acct-form" class="row acct-form">
      <label class="f">Person <span class="muted small">(from the contacts)</span><input type="text" name="person" list="acct-people" required autocomplete="off" placeholder="e.g. Sam Taylor"></label>
      <label class="f">Username<input type="text" name="username" required pattern="[A-Za-z0-9._@\\-]{2,40}" placeholder="e.g. sam.taylor"></label>
      <label class="f">${first ? 'Your password' : 'First password'}<input type="text" name="password" required minlength="8" autocomplete="new-password" placeholder="at least 8 characters"></label>
      ${first || !owner ? '' : '<label class="f">Role<select name="role"><option value="user">User</option><option value="admin">Admin — every right</option></select></label>'}
      ${first ? '' : `<div class="f acct-mods"><span>Modules <span class="muted small">— ${esc(basic?.label || 'Basic pack')} always: ${esc(basic?.what || '')}</span></span>
        <div class="mod-ticks">${extra.map((m) => `<label title="${esc(m.what)}"><input type="checkbox" name="modules" value="${m.key}" checked> ${m.icon} ${esc(m.label)}</label>`).join('')}</div>
        <div class="row small" style="gap:6px">${presets.map(([l, keys]) => `<button type="button" class="small" data-mod-preset="${esc(keys.join(','))}">${esc(l)}</button>`).join('')}</div></div>`}
      <button class="primary" type="submit">${first ? 'Make my account and turn sign-in on' : 'Add account'}</button>
      <datalist id="acct-people">${people.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></form>`;
  if (!ACCT.enabled) {
    return `<div class="card acct-card"><h2>👤 Accounts</h2>
      <p class="small muted">Accounts are <b>off</b>: anyone who can reach SITHUB uses it, as now. Make your own account first (as the admin) to turn sign-in on — from then on everyone signs in,
        and each account is linked to a person in the contacts, so <b>📥 My work</b> shows them the tasks they own and the projects they lead, sponsor or are on the team of, and what's new for them.</p>
      ${form(true)}</div>`;
  }
  return `<div class="card acct-card"><h2>👤 Accounts <span class="muted small">${list.length}</span></h2>
    <p class="small muted">Each account is linked to a person: the name used as a task owner, project leader, sponsor or team member. A first password (and one an admin resets) must be changed at the next sign-in.
      A forgotten admin password can be reset on the server: <code>node scripts/reset-password.js &lt;username&gt; &lt;new password&gt;</code>.</p>
    <p class="small muted">🔑 <b>Admin rights</b> are given by the host account${owner ? ' (you)' : ''}: an <b>Admin</b> has them all, or tick some for a user — ${ACCT.rights.map((r) => `<span title="${esc(r.what)}">${r.icon} ${esc(r.label)}</span>`).join(', ')} (hover for what each covers).</p>
    <p class="small muted">🧩 <b>Modules</b> choose what each account sees and can use; ${esc(basic?.label || 'the basic pack')} (${esc(basic?.what || '')}) is always there. Hover over a module for what it covers. A change applies the next time they open or refresh the page.</p>
    <table class="log acct-table"><thead><tr><th>Person</th><th>Username</th><th>Role and rights</th><th>Modules</th><th>Last signed in</th><th>Active</th><th></th></tr></thead><tbody>
      ${list.map((a) => `<tr data-acct="${a.id}"><td><input type="text" name="person" list="acct-people" value="${esc(a.person)}" ${canEdit(a) || a.id === ACCT.account?.id ? '' : 'disabled'}></td><td><b>${esc(a.username)}</b>${a.must_change ? ' <span class="small muted">(to change password)</span>' : ''}
          ${owner && !a.owner && a.role !== 'admin' ? `<label class="small acct-training" title="Works in a training copy of SITHUB only, never the real data: for leading training sessions"><input type="checkbox" data-acct-training ${a.training ? 'checked' : ''}> 🎓 Training account</label>` : a.training ? '<div><span class="chip">🎓 Training account</span></div>' : ''}</td>
        <td>${rightsCell(a)}</td><td>${ticks(a)}</td><td class="small">${a.last_login ? esc(fmtDateTime(a.last_login)) : '<span class="muted">never</span>'}</td>
        <td><input type="checkbox" name="active" ${a.active ? 'checked' : ''} ${canEdit(a) ? '' : 'disabled'}></td>
        <td class="nowrap">${canEdit(a) ? `<button class="small" data-acct-reset="${a.id}">Set a new password</button> <button class="icon" data-acct-del="${a.id}" title="Remove the account">✕</button>` : ''}</td></tr>`).join('')}
    </tbody></table>
    <h3 class="kc-sub">Add an account</h3>${form(false)}</div>`;
}
function acctSettingsWire(rerender) {
  $('#acct-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const body = Object.fromEntries(fd);
      if ($('#acct-form .acct-mods')) body.modules = fd.getAll('modules');
      await api.post('/accounts', body);
      if (!ACCT.enabled) { toast('Your account is made — sign-in is on'); setTimeout(() => location.reload(), 600); return; }
      toast(`Account ${fd.get('username')} added — give them the username and first password`);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  });
  $$('[data-mod-preset]').forEach((b) => b.addEventListener('click', () => {
    const keys = b.dataset.modPreset.split(',').filter(Boolean);
    $$('#acct-form [name=modules]').forEach((x) => { x.checked = keys.includes(x.value); });
  }));
  $$('[data-acct-training]').forEach((el) => el.addEventListener('change', async () => {
    const row = el.closest('[data-acct]');
    if (!confirm(el.checked ? 'Make this a 🎓 training account? From its next sign-in it works in a training copy of SITHUB only (copied from the real data), and never changes the real data.' : 'Make this an ordinary account again? From its next sign-in it works on the real data.')) { el.checked = !el.checked; return; }
    try { await api.patch(`/accounts/${row.dataset.acct}`, { training: el.checked }); toast(el.checked ? 'Training account: it signs in to the training copy' : 'An ordinary account again'); rerender(); } catch (err) { toast(err.message, 'error'); rerender(); }
  }));
  $$('[data-acct] [data-right]').forEach((el) => el.addEventListener('change', async () => {
    const row = el.closest('[data-acct]');
    const rights = $$('[data-right]', row).filter((x) => x.checked).map((x) => x.dataset.right);
    try { await api.patch(`/accounts/${row.dataset.acct}`, { rights }); toast('Rights saved — they apply when that person next opens or refreshes the page'); } catch (err) { toast(err.message, 'error'); rerender(); }
  }));
  $$('[data-acct] [data-mod]').forEach((el) => el.addEventListener('change', async () => {
    const row = el.closest('[data-acct]');
    const modules = $$('[data-mod]', row).filter((x) => x.checked).map((x) => x.dataset.mod);
    try { await api.patch(`/accounts/${row.dataset.acct}`, { modules }); toast('Modules saved — they apply when that person next opens or refreshes the page'); } catch (err) { toast(err.message, 'error'); rerender(); }
  }));
  // a person's username, suggested from their name
  $('#acct-form [name=person]')?.addEventListener('change', (e) => {
    const u = $('#acct-form [name=username]');
    if (!u.value) u.value = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  });
  $$('[data-acct] [name]').forEach((el) => el.addEventListener('change', async () => {
    const id = el.closest('[data-acct]').dataset.acct;
    try { await api.patch(`/accounts/${id}`, { [el.name]: el.type === 'checkbox' ? el.checked : el.value }); toast('Saved'); if (el.name === 'role') rerender(); } catch (err) { toast(err.message, 'error'); rerender(); }
  }));
  $$('[data-acct-reset]').forEach((b) => b.addEventListener('click', async () => {
    const pw = prompt('A new password for this account (at least 8 characters) — they choose their own at the next sign-in:');
    if (!pw) return;
    try { await api.patch(`/accounts/${b.dataset.acctReset}`, { password: pw }); toast('New password set — they\'ll be asked to change it'); rerender(); } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-acct-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this account? Their tasks and projects stay as they are.')) return;
    try { await api.del(`/accounts/${b.dataset.acctDel}`); toast('Account removed'); rerender(); } catch (err) { toast(err.message, 'error'); }
  }));
}

// ---- 🖥 the server, from any PC (the Server right) -------------------------------------------------
function serverCardHtml() {
  if (!ACCT.enabled || !acctRight('server')) return '';
  return `<div class="card"><h2>🖥 Server</h2>
    <p class="small muted">Look after the shared SITHUB from your own PC: read its log, or restart it. Restarting checks for an update and installs it first; everyone's pages reconnect by themselves after a few seconds.</p>
    <div class="row" style="gap:8px;flex-wrap:wrap"><button data-srv="log">📜 Server log</button><button data-srv="restart">🔄 Restart (and update)</button></div>
    <div id="srv-pw" class="srv-pw"></div></div>`;
}
// 🔑 the server PC's Windows password: when it was last checked, the next ✉ reminder, how often
async function serverPwDraw(d) {
  const box = $('#srv-pw'); if (!box) return;
  if (!d) { try { d = await api.get('/server/password'); } catch { box.innerHTML = ''; return; } }
  const day = (iso) => esc(new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
  box.innerHTML = `<h3>🔑 The server PC's password</h3>
    <p class="small muted">SITHUB runs on the server PC under ${d.account ? `the Windows account <b>${esc(d.account)}</b>` : 'a Windows account'}, and its scheduled task keeps that account's password. If the password expires or is changed, SITHUB won't start after the next restart, so check it now and then: after a change, give the task the new one (Task Scheduler › <i>SITHUB server</i> › Properties › OK, or run <code>server-install.bat</code> again).</p>
    <div class="srv-pw-row ${d.due ? 'due' : ''}">
      <span>Last checked <b>${day(d.checked_at)}</b>${d.checked_by ? ` by ${esc(d.checked_by)}` : ''}</span>
      <span class="${d.due ? 'srv-pw-due' : 'muted'}">${!d.weeks ? 'No reminders' : d.due ? '⏰ Due now: a ✉ reminder has gone out' : `Next ✉ reminder ${day(d.due_at)}`}</span>
      <label class="row small" style="gap:6px">Every <input type="number" id="srv-pw-weeks" min="0" max="52" step="1" value="${d.weeks}" style="width:64px"> weeks</label>
      <button class="${d.due ? 'primary' : ''}" data-srv="pw-checked">✓ Checked it</button>
    </div>
    <p class="small muted">The reminder goes to everyone with the Server right${d.people?.length ? ` (${esc(d.people.join(', '))})` : ''}, and again each week until someone ticks it off. 0 weeks: no reminders.</p>`;
}
async function serverPwSave(body, msg) {
  try { serverPwDraw(await api.post('/server/password', body)); if (msg) toast(msg); if (typeof mailPoll === 'function') mailPoll(); } catch (err) { toast(err.message, 'error'); }
}
async function serverLog(onlyProblems = false) {
  let d; try { d = await api.get('/server/log?lines=600'); } catch (err) { toast(err.message, 'error'); return; }
  const lines = d.lines.filter((l) => !onlyProblems || /\[(WARN|ERROR)\]/.test(l)).reverse();
  openModal(`<div class="modal-head"><h2 style="margin:0">📜 Server log <span class="muted small">${esc(d.file || 'none yet')}</span></h2><button class="icon" data-action="close-modal">✕</button></div>
    <div class="row" style="gap:8px;margin:6px 0"><label class="row small" style="gap:4px"><input type="checkbox" id="srv-problems" ${onlyProblems ? 'checked' : ''}> Warnings and errors only</label>
      <span class="spacer"></span><button class="small" id="srv-again">↻ Refresh</button></div>
    <pre class="srv-log">${lines.length ? lines.map((l) => `<span class="${/\[ERROR\]/.test(l) ? 'srv-err' : /\[WARN\]/.test(l) ? 'srv-warn' : ''}">${esc(l)}</span>`).join('\n') : 'Nothing logged today.'}</pre>
    <p class="small muted">Today's log, newest first (the last 600 lines). Older days are in the logs folder on the server.</p>`, { wide: true });
  $('#srv-problems').addEventListener('change', (e) => serverLog(e.target.checked));
  $('#srv-again').addEventListener('click', () => serverLog($('#srv-problems').checked));
}
async function serverRestart() {
  if (!confirm('Restart SITHUB for everyone?\n\nIt checks for an update and installs it, then starts again — usually within a minute. Anything being typed on other PCs and not yet saved may be lost.')) return;
  try { await api.post('/server/restart', {}); } catch (err) { toast(err.message, 'error'); return; }
  toast('Restarting — this page reloads when it\'s back');
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 4000));
  for (;;) {
    try { const r = await fetch('/api/health', { cache: 'no-store' }); if (r.ok) { location.reload(); return; } } catch { /* not back yet */ }
    if (Date.now() - started > 5 * 60000) { toast('It hasn\'t come back after 5 minutes — check the server', 'error'); return; }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-srv]'); if (!b) return;
  if (b.dataset.srv === 'log') serverLog(); else if (b.dataset.srv === 'restart') serverRestart();
  else if (b.dataset.srv === 'pw-checked') serverPwSave({ checked: true }, '🔑 Ticked off: the next reminder is in a few weeks');
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'srv-pw-weeks') serverPwSave({ weeks: Number(e.target.value) }, 'Saved');
});
// the card is drawn with the Settings page: fill in the password part once it's there
new MutationObserver(() => { const box = document.getElementById('srv-pw'); if (box && !box.dataset.loaded) { box.dataset.loaded = '1'; serverPwDraw(); } })
  .observe(document.documentElement, { childList: true, subtree: true });

// ---- 🎓 training: a banner on every page of the training copy; which department's view it shows; a fresh copy --------
async function trainingBanner() {
  document.body.classList.add('in-training');
  let t = null; try { t = await api.get('/training'); } catch { /* shown without the details */ }
  const view = ACCT.account.training_view;
  const views = t?.views || [];
  const mine = view ? view.split(',').filter((k) => k && k !== 'basic').join(',') : null;
  const cur = views.find((v) => (v.modules ? v.modules.join(',') : null) === (mine || null))?.key ?? 'custom';
  const old = document.getElementById('training-bar'); if (old) old.outerHTML = '';
  document.getElementById('topbar')?.insertAdjacentHTML('afterend', `<div id="training-bar" class="training-bar" role="status">
    <b>🎓 Training</b><span class="tb-what">a practice copy of SITHUB${t?.copied_at ? `, copied from the real data ${esc(fmtDateTime(t.copied_at))}` : ''}: the site's planning and reporting data, with no one's tasks, projects or notes. Nothing here changes the real SITHUB.</span>
    <label class="tb-view">Viewing as <select id="training-view">${views.map((v) => `<option value="${esc(v.key)}" ${v.key === cur ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}${cur === 'custom' ? '<option value="custom" selected>Custom</option>' : ''}</select></label>
    <button type="button" class="small" id="training-reset" title="Throw away what's been done in training and copy the real data again">↺ Fresh copy from live</button></div>`);
  $('#training-view')?.addEventListener('change', async (e) => {
    const v = views.find((x) => x.key === e.target.value); if (!v) return;
    try { await api.put('/training/view', { modules: v.modules }); toast(`Viewing as ${v.label}`); setTimeout(() => location.reload(), 300); } catch (err) { toast(err.message, 'error'); }
  });
  $('#training-reset')?.addEventListener('click', async () => {
    if (!confirm('Make a fresh training copy from the real data? Everything done in training so far is thrown away. The real SITHUB isn\'t touched.')) return;
    try { await api.post('/training/reset', {}); toast('A fresh copy from live'); setTimeout(() => location.reload(), 400); } catch (err) { toast(err.message, 'error'); }
  });
}
