'use strict';
// ✉ Messages to you, under ✉ in the top bar: 👉 a poke about a task given to you, 🎫 news on a ticket
// you sent (answered, its status). Kept on the server by person, so they reach you on any PC: signed
// in, as your account's person; without accounts, by the name this browser was given. Loaded before
// app.js; uses its helpers.

const MAIL = { unread: 0, seen: new Set(), first: true, list: [] };
const MAIL_ICON = { poke: '👉', ticket: '🎫', message: '✉' };

async function mailPoll() {
  let r;
  try { r = await api.get('/messages'); } catch { return; }
  MAIL.list = r.messages; MAIL.person = r.person;
  const c = $('#mail-count');
  if (c) { c.hidden = !r.unread; c.textContent = r.unread; }
  // what's arrived since the last look: a toast (not for what was there when the page opened)
  const fresh = r.messages.filter((m) => !m.read && !MAIL.seen.has(m.id));
  r.messages.forEach((m) => MAIL.seen.add(m.id));
  if (!MAIL.first && fresh.length) toast(`✉ ${fresh.length > 1 ? `${fresh.length} new messages` : fresh[0].title}`);
  MAIL.first = false; MAIL.unread = r.unread;
  if (!$('#mail-panel')?.hidden) mailDraw();
}

function mailDraw() {
  const panel = $('#mail-panel'); if (!panel) return;
  if (!MAIL.person) {
    panel.innerHTML = `<div class="mail-empty">Messages are sent to you by name.<br><button class="small" data-action="set-name">👤 Say who you are</button></div>`;
    return;
  }
  panel.innerHTML = `<div class="mail-head"><b>✉ Messages</b><span class="muted small">for ${esc(MAIL.person)}</span><span class="spacer"></span>
      ${MAIL.list.some((m) => !m.read) ? '<button class="small link" data-mail="read-all">Mark all read</button>' : ''}</div>
    ${MAIL.list.length ? `<ul class="mail-list">${MAIL.list.map((m) => `<li class="${m.read ? '' : 'unread'}" data-mail-id="${m.id}">
        <span class="mail-ico">${MAIL_ICON[m.kind] || '✉'}</span>
        <div class="mail-main" data-mail="open" title="${m.task_id ? 'Open the task' : m.ticket_id ? 'Open the tickets' : m.link ? 'Open it' : ''}">
          <div class="mail-title">${esc(m.title)}</div>
          ${m.body ? `<div class="mail-body">${esc(m.body)}</div>` : ''}
          <div class="small muted">${m.from_person ? `${esc(m.from_person)} · ` : ''}${esc(fmtDateTime(m.created_at))}${m.task_status === 'done' ? ' · ✅ task done' : ''}</div></div>
        <button class="icon" data-mail="delete" title="Remove">✕</button></li>`).join('')}</ul>`
    : '<div class="mail-empty muted">Nothing yet. A poke about one of your tasks, or an answer to a ticket you sent, shows up here.</div>'}`;
}

async function mailRead(ids) {
  try { await api.post('/messages/read', ids ? { ids } : {}); } catch { /* next time */ }
  for (const m of MAIL.list) if (!ids || ids.includes(m.id)) m.read = true;
  MAIL.unread = MAIL.list.filter((m) => !m.read).length;
  const c = $('#mail-count'); if (c) { c.hidden = !MAIL.unread; c.textContent = MAIL.unread; }
}

function mailClose() {
  const panel = $('#mail-panel'); if (!panel || panel.hidden) return;
  panel.hidden = true; $('#mail-btn')?.setAttribute('aria-expanded', 'false');
}

function mailWire() {
  const btn = $('#mail-btn'); const panel = $('#mail-panel');
  if (!btn || !panel) return;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!panel.hidden) { mailClose(); return; }
    panel.hidden = false; btn.setAttribute('aria-expanded', 'true');
    mailDraw(); await mailPoll();
  });
  panel.addEventListener('click', async (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-mail]'); if (!b) return;
    const li = b.closest('[data-mail-id]'); const m = li && MAIL.list.find((x) => x.id === Number(li.dataset.mailId));
    if (b.dataset.mail === 'read-all') { await mailRead(null); mailDraw(); return; }
    if (b.dataset.mail === 'delete' && m) {
      try { await api.del(`/messages/${m.id}`); } catch (err) { toast(err.message, 'error'); return; }
      MAIL.list = MAIL.list.filter((x) => x !== m); MAIL.unread = MAIL.list.filter((x) => !x.read).length;
      const c = $('#mail-count'); if (c) { c.hidden = !MAIL.unread; c.textContent = MAIL.unread; }
      mailDraw(); return;
    }
    if (b.dataset.mail === 'open' && m) {
      if (!m.read) await mailRead([m.id]);
      mailClose();
      if (m.task_id) taskModal(m.task_id);
      else if (m.ticket_id) location.hash = '#/tickets';
      else if (m.link) location.hash = m.link;
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#mail')) mailClose(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') mailClose(); });
  mailPoll();
  setInterval(mailPoll, 60000);
  window.addEventListener('focus', () => mailPoll());
}

// 👉 Poke the people a task is given to — for whoever has the "Poke people" right (accounts off:
// anyone), or leads or sponsors the task's project.
function canPoke(t) {
  const meName = ACCT.account?.person || me.name || '';
  const owners = String(t.owner || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  if (t.status === 'done' || !owners.some((o) => !meName || !sameName(o, meName))) return false;
  if (!ACCT.enabled || acctRight('poke')) return true;
  const p = state.projects?.find((x) => x.id === t.project_id);
  return !!p && [p.leader, p.sponsor].some((v) => String(v || '').split(/[,;\n]/).some((o) => o.trim() && sameName(o.trim(), meName)));
}
// the line to add, under the task window's buttons, then send
function pokeDialog(t, after) {
  const owners = String(t.owner || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)
    .filter((o) => !sameName(o, ACCT.account?.person || me.name || ''));
  $('#poke-row')?.remove();
  after.insertAdjacentHTML('afterend', `<div class="section row poke-row" id="poke-row"><span>👉 Poke <b>${esc(owners.join(', '))}</b></span>
    <input type="text" id="poke-note" maxlength="2000" placeholder="Add a line if you like — e.g. can you update this by Friday?" style="flex:1;min-width:200px">
    <button class="primary" id="poke-send">Send</button><button class="link small" id="poke-cancel">Cancel</button></div>`);
  const input = $('#poke-note'); input.focus();
  const send = async () => {
    try {
      const r = await api.post(`/tasks/${t.id}/poke`, { note: input.value });
      toast(`👉 Poked ${r.sent.join(', ')}${r.skipped.length ? ` (not ${r.skipped.join(', ')}: poked in the last 15 minutes)` : ''}`);
      $('#poke-row')?.remove();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#poke-send').onclick = send;
  $('#poke-cancel').onclick = () => $('#poke-row')?.remove();
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
}
