// 👤 Accounts (src/accounts.js): sign-in when they're on, your password, 📥 My work, and the
// admin's list of accounts in Settings. Off until the first account is made: nothing changes until then.
const ACCT = { enabled: false, account: null, newCount: 0 };

// At start-up: who's signed in. → false when the sign-in page is showing instead of the app.
async function acctInit() {
  let me0;
  try { me0 = await api.get('/auth/me'); } catch { return true; }
  ACCT.enabled = !!me0.enabled; ACCT.account = me0.account;
  if (ACCT.enabled && !ACCT.account) { renderSignIn(); return false; }
  if (ACCT.account) {
    me.setName(ACCT.account.person); // who's here and who changed what: the account's person
    acctChrome();
    if (ACCT.account.must_change) await acctPasswordDialog(true);
    acctPoll(); setInterval(acctPoll, 60000);
  }
  return true;
}

function renderSignIn(msg = '') {
  document.body.classList.add('signin-page');
  document.getElementById('signin')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="signin" id="signin"><form class="card signin-card" id="signin-form">
      <h1>✔ CI Manager</h1><p class="muted small">Sign in with the account you were given.</p>
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
  if (nav && !$('[data-nav="mine"]', nav)) nav.insertAdjacentHTML('afterbegin', '<a href="#/mine" data-nav="mine" title="What\'s assigned to you">📥<span class="lbl"> My work</span> <span id="mine-count" class="count" hidden>0</span></a>');
  const menu = $('#top-menu');
  if (menu && !$('[data-action="sign-out"]', menu)) {
    menu.insertAdjacentHTML('afterbegin', `<div class="small muted" style="padding:4px 10px">Signed in as <b>${esc(ACCT.account.person)}</b> (${esc(ACCT.account.username)}${ACCT.account.role === 'admin' ? ', admin' : ''})</div>
      <button data-action="change-password">🔑 Change password</button><button data-action="sign-out">↪ Sign out</button><hr>`);
  }
  // with an account, the name comes from it
  $$('[data-action="set-name"]').forEach((b) => { b.nextElementSibling?.tagName === 'HR' && b.nextElementSibling.remove(); b.remove(); });
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
  const admin = ACCT.account?.role === 'admin';
  if (ACCT.enabled && !admin) return '';
  let list = [];
  if (ACCT.enabled) { try { list = await api.get('/accounts'); } catch { list = []; } }
  let people = [];
  try { const groups = await api.get('/owner-options'); const seen = new Set(); people = groups.flatMap((g) => g.names).filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())); } catch { /* none */ }
  const form = (first) => `<form id="acct-form" class="row acct-form">
      <label class="f">Person <span class="muted small">(from the contacts)</span><input type="text" name="person" list="acct-people" required autocomplete="off" placeholder="e.g. Sam Taylor"></label>
      <label class="f">Username<input type="text" name="username" required pattern="[A-Za-z0-9._@\\-]{2,40}" placeholder="e.g. sam.taylor"></label>
      <label class="f">${first ? 'Your password' : 'First password'}<input type="text" name="password" required minlength="8" autocomplete="new-password" placeholder="at least 8 characters"></label>
      ${first ? '' : '<label class="f">Role<select name="role"><option value="user">User</option><option value="admin">Admin</option></select></label>'}
      <button class="primary" type="submit">${first ? 'Make my account and turn sign-in on' : 'Add account'}</button>
      <datalist id="acct-people">${people.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></form>`;
  if (!ACCT.enabled) {
    return `<div class="card acct-card"><h2>👤 Accounts</h2>
      <p class="small muted">Accounts are <b>off</b>: anyone who can reach the CI Manager uses it, as now. Make your own account first (as the admin) to turn sign-in on — from then on everyone signs in,
        and each account is linked to a person in the contacts, so <b>📥 My work</b> shows them the tasks they own and the projects they lead, sponsor or are on the team of, and what's new for them.</p>
      ${form(true)}</div>`;
  }
  return `<div class="card acct-card"><h2>👤 Accounts <span class="muted small">${list.length}</span></h2>
    <p class="small muted">Each account is linked to a person: the name used as a task owner, project leader, sponsor or team member. A first password (and one an admin resets) must be changed at the next sign-in.
      A forgotten admin password can be reset on the server: <code>node scripts/reset-password.js &lt;username&gt; &lt;new password&gt;</code>.</p>
    <table class="log acct-table"><thead><tr><th>Person</th><th>Username</th><th>Role</th><th>Last signed in</th><th>Active</th><th></th></tr></thead><tbody>
      ${list.map((a) => `<tr data-acct="${a.id}"><td><input type="text" name="person" list="acct-people" value="${esc(a.person)}"></td><td><b>${esc(a.username)}</b>${a.must_change ? ' <span class="small muted">(to change password)</span>' : ''}</td>
        <td><select name="role">${options({ user: 'User', admin: 'Admin' }, a.role)}</select></td><td class="small">${a.last_login ? esc(fmtDateTime(a.last_login)) : '<span class="muted">never</span>'}</td>
        <td><input type="checkbox" name="active" ${a.active ? 'checked' : ''}></td>
        <td class="nowrap"><button class="small" data-acct-reset="${a.id}">Set a new password</button> <button class="icon" data-acct-del="${a.id}" title="Remove the account">✕</button></td></tr>`).join('')}
    </tbody></table>
    <h3 class="kc-sub">Add an account</h3>${form(false)}</div>`;
}
function acctSettingsWire(rerender) {
  $('#acct-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.post('/accounts', Object.fromEntries(fd));
      if (!ACCT.enabled) { toast('Your account is made — sign-in is on'); setTimeout(() => location.reload(), 600); return; }
      toast(`Account ${fd.get('username')} added — give them the username and first password`);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  });
  // a person's username, suggested from their name
  $('#acct-form [name=person]')?.addEventListener('change', (e) => {
    const u = $('#acct-form [name=username]');
    if (!u.value) u.value = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  });
  $$('[data-acct] [name]').forEach((el) => el.addEventListener('change', async () => {
    const id = el.closest('[data-acct]').dataset.acct;
    try { await api.patch(`/accounts/${id}`, { [el.name]: el.type === 'checkbox' ? el.checked : el.value }); toast('Saved'); } catch (err) { toast(err.message, 'error'); rerender(); }
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
