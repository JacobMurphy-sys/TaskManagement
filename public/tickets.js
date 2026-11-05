'use strict';
// 🎫 Tickets: a bug report, a feature request or a question, sent from 💬 in the top bar with where it
// was sent from (the page, the version, the browser, the last error messages) and, if wanted, a
// screenshot pasted in. The Tickets page lists them; someone with the "Handle tickets" right sets their
// status and answers them. Loaded before app.js.

const TICKET_KIND = { bug: ['🐞', 'Bug'], feature: ['💡', 'Feature request'], question: ['❓', 'Question'] };
const TICKET_STATUS = { new: 'New', triaged: 'Seen', in_progress: 'Being worked on', done: 'Done', wont_do: 'Won\'t do' };
const TICKET_PROMPT = {
  bug: 'What did you do, what did you expect, and what happened instead?\n\n1. I went to …\n2. I clicked …\n3. I expected … but …',
  feature: 'What would you like SITHUB to do, and what would it help with?',
  question: 'What would you like to know?',
};
// '#/project/4' -> 'Projects', by the name on the top bar
const ticketPageName = (hash) => { const v = String(hash).replace(/^#\//, '').split('/')[0] || 'dashboard'; const map = { project: 'kanban', idea: 'ideas' };
  const a = document.querySelector(`#topnav a[data-nav="${map[v] || v}"], #top-menu a[data-nav="${map[v] || v}"]`); return a ? a.textContent.replace(/^\W+/u, '').trim() : v; };
const ticketPill = (s) => `<span class="pill tk-${s}">${esc(TICKET_STATUS[s] || s)}</span>`;

function ticketDialog(kind = store.get('ticketKind', 'bug')) {
  let shot = null; // data URL of the screenshot
  const page = location.hash || '#/dashboard';
  const where = document.title && $('#topnav a.on, #topnav a.active')?.textContent?.trim();
  openModal(`
    <div class="modal-head"><h2 style="margin:0">💬 Report a bug or ask for something</h2><button class="icon" data-action="close-modal">✕</button></div>
    <div class="seg" id="tk-kind">${Object.entries(TICKET_KIND).map(([k, [i, l]]) => `<button type="button" data-kind="${k}" class="${k === kind ? 'on' : ''}">${i} ${l}</button>`).join('')}</div>
    <label class="f" style="margin-top:10px">Title<input id="tk-title" maxlength="200" placeholder="In a few words, e.g. “Gantt doesn't show subtasks”"></label>
    <label class="f" style="margin-top:8px">Details<textarea id="tk-desc" rows="7"></textarea></label>
    <label class="small row" id="tk-block-row" style="margin-top:6px"><input type="checkbox" id="tk-blocking"> It stops me from working</label>
    <div class="tk-shot" id="tk-shot" tabindex="0" title="Paste a screenshot here (Ctrl+V), drop an image, or click to choose one">
      <span class="muted small">📷 <b>Screenshot</b> (optional): press <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>, then paste it here with <kbd>Ctrl</kbd>+<kbd>V</kbd> — or click to choose a file</span>
      <input type="file" id="tk-file" accept="image/*" hidden></div>
    <p class="small muted" style="margin:8px 0 0">Sent with it: the page you're on (${esc(where || page)}), SITHUB's version, your browser${noticeErrors.length ? ' and the last error messages' : ''}, and your name.</p>
    <div class="row" style="margin-top:12px"><a class="small" href="#/tickets" data-action="close-modal-go">🎫 See all tickets</a><div class="spacer"></div>
      <button data-action="close-modal">Cancel</button><button class="primary" id="tk-send">Send</button></div>`);
  const setKind = (k) => {
    kind = k; store.set('ticketKind', k);
    $$('#tk-kind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === k));
    $('#tk-desc').placeholder = TICKET_PROMPT[k];
    $('#tk-block-row').hidden = k !== 'bug';
  };
  setKind(kind);
  $('#tk-kind').onclick = (e) => { const b = e.target.closest('[data-kind]'); if (b) setKind(b.dataset.kind); };
  const box = $('#tk-shot');
  const take = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    if (file.size > 15 * 1024 * 1024) { toast('That picture is too large (15 MB at most)', 'error'); return; }
    const r = new FileReader();
    r.onload = () => { shot = r.result; box.innerHTML = `<img src="${shot}" alt="Screenshot"><button type="button" class="icon tk-shot-x" title="Remove the screenshot">✕</button>`; box.querySelector('.tk-shot-x').onclick = (e) => { e.stopPropagation(); shot = null; ticketDialog(kind); }; };
    r.readAsDataURL(file);
  };
  $('#modal').addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); take(f); } });
  box.onclick = () => { if (!shot) $('#tk-file').click(); };
  $('#tk-file').onchange = (e) => take(e.target.files[0]);
  box.ondragover = (e) => { e.preventDefault(); box.classList.add('over'); };
  box.ondragleave = () => box.classList.remove('over');
  box.ondrop = (e) => { e.preventDefault(); box.classList.remove('over'); take(e.dataTransfer.files[0]); };
  $('#tk-send').onclick = async () => {
    const title = $('#tk-title').value.trim();
    if (!title) { $('#tk-title').focus(); toast('Give it a short title'); return; }
    $('#tk-send').disabled = true;
    try {
      const t = await api.post('/tickets', { kind, title, description: $('#tk-desc').value, blocking: $('#tk-blocking').checked, page,
        browser: navigator.userAgent, screen: `${innerWidth}×${innerHeight}`, errors: noticeErrors.map((x) => x.msg), screenshot: shot });
      closeModal();
      toast(`Thanks — ${t.ref} sent. Follow it on 🎫 Tickets`);
      if (state.view === 'tickets') route();
    } catch (err) { toast(err.message, 'error'); $('#tk-send').disabled = false; }
  };
  $('#tk-title').focus();
}

async function renderTickets() {
  const { tickets, can_handle: canHandle } = await api.get('/tickets');
  const f = store.get('ticketFilter', { show: 'open', kind: '', mine: false });
  const me = store.get('userName', '');
  const open = (t) => !['done', 'wont_do'].includes(t.status);
  const shown = tickets.filter((t) => (f.show === 'all' || (f.show === 'open' ? open(t) : !open(t))) && (!f.kind || t.kind === f.kind) && (!f.mine || sameName(t.reporter || '', me)));
  const count = (k) => tickets.filter((t) => open(t) && t.kind === k).length;
  const row = (t) => `<div class="card tk-card ${open(t) ? '' : 'tk-closed'}" data-tk="${t.id}">
      <div class="tk-head"><span class="tk-kind" title="${esc(TICKET_KIND[t.kind][1])}">${TICKET_KIND[t.kind][0]}</span>
        <b class="tk-title">${esc(t.title)}</b> <span class="small muted">${esc(t.ref)}</span>${t.priority >= 3 ? ' <span class="why bad">stops them working</span>' : ''}
        <span class="spacer"></span>
        ${canHandle ? `<select class="tk-status" title="Status">${Object.entries(TICKET_STATUS).map(([k, l]) => `<option value="${k}" ${k === t.status ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ticketPill(t.status)}</div>
      <div class="small muted">${t.reporter ? `${personDot(t.reporter)} ${esc(t.reporter)} · ` : ''}${esc(fmtDateTime(t.created_at))}${t.page ? ` · from <a href="${esc(t.page)}">${esc(ticketPageName(t.page))}</a>` : ''}</div>
      ${t.description ? `<div class="pre tk-desc">${linkify(t.description)}</div>` : ''}
      ${t.has_screenshot ? `<a href="/api/tickets/${t.id}/screenshot" data-tk-shot="${t.id}" data-tk-alt="${esc(`${t.ref} · ${t.title}`)}" target="_blank" rel="noopener" title="View the screenshot"><img class="tk-thumb" src="/api/tickets/${t.id}/screenshot" alt="Screenshot" loading="lazy"></a>` : ''}
      ${canHandle ? `<label class="na-line tk-reply-line" title="An answer for whoever sent it — saved as you type">↩ <input type="text" class="tk-reply" maxlength="2000" value="${esc(t.reply || '')}" placeholder="Answer (e.g. fixed in the next update, or a question back)"></label>`
        : t.reply ? `<div class="tk-reply-show">↩ ${linkify(t.reply)}</div>` : ''}
      <details class="small muted tk-ctx"><summary>Details sent with it</summary>${esc(t.context.version ? `Version ${t.context.version}` : '')}${t.context.screen ? ` · window ${esc(t.context.screen)}` : ''}${t.context.computer ? ` · ${esc(t.context.computer)}` : ''}
        <div>${esc(t.context.browser || '')}</div>${(t.context.errors || []).length ? `<div>Last error messages:<ul>${t.context.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${canHandle ? `<button class="link small danger tk-del">Delete this ticket</button>` : ''}</details>
    </div>`;
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">🎫 Tickets</h1>
      <div class="seg" id="tk-show">${[['open', 'Open'], ['closed', 'Done'], ['all', 'All']].map(([k, l]) => `<button type="button" data-show="${k}" class="${f.show === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <select id="tk-filter-kind" style="width:auto"><option value="">Every kind</option>${Object.entries(TICKET_KIND).map(([k, [i, l]]) => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${i} ${l} (${count(k)} open)</option>`).join('')}</select>
      ${me ? `<label class="small muted row"><input type="checkbox" id="tk-mine" ${f.mine ? 'checked' : ''}> only mine</label>` : ''}
      <div class="spacer"></div>
      ${ddMenu('⋯', '<a href="/api/tickets/export.xlsx" download>⬇ All tickets to Excel</a>', { title: 'Export' })}
      <button class="primary" data-action="ticket">💬 New ticket</button></div>
    ${canHandle ? '' : '<p class="small muted">Send a bug report, a feature request or a question with 💬 in the top bar. The answers show here.</p>'}
    <div class="tk-list">${shown.map(row).join('') || `<div class="card empty">${tickets.length ? 'Nothing here with these filters.' : 'No tickets yet. Found a bug, or missing something? Click 💬 in the top bar.'}</div>`}</div>`;
  const setF = (o) => { store.set('ticketFilter', { ...f, ...o }); renderTickets(); };
  $('#tk-show').onclick = (e) => { const b = e.target.closest('[data-show]'); if (b) setF({ show: b.dataset.show }); };
  $('#tk-filter-kind').onchange = (e) => setF({ kind: e.target.value });
  $('#tk-mine')?.addEventListener('change', (e) => setF({ mine: e.target.checked }));
  // 📷 a screenshot opens in the image viewer over the page (zoom, ← → through the others shown); ⧉ there opens it in a tab
  main().onclick = (e) => {
    const a = e.target.closest('[data-tk-shot]'); if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
    e.preventDefault();
    const shots = $$('[data-tk-shot]');
    imageViewer(shots.map((x) => ({ src: x.getAttribute('href'), alt: x.dataset.tkAlt })), shots.indexOf(a));
  };
  for (const el of $$('.tk-card')) {
    const id = el.dataset.tk;
    const save = async (body) => { try { await api.patch(`/tickets/${id}`, body); return true; } catch (err) { toast(err.message, 'error'); return false; } };
    el.querySelector('.tk-status')?.addEventListener('change', async (e) => { if (await save({ status: e.target.value })) { toast(`Marked “${TICKET_STATUS[e.target.value]}”`); renderTickets(); } });
    const rep = el.querySelector('.tk-reply'); let t = null;
    if (rep) {
      const go = async () => { clearTimeout(t); if (rep.value === rep.defaultValue) return; if (await save({ reply: rep.value })) { rep.defaultValue = rep.value; rep.classList.add('saved'); setTimeout(() => rep.classList.remove('saved'), 900); } };
      rep.oninput = () => { clearTimeout(t); t = setTimeout(go, 1200); }; rep.onchange = go; rep.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); rep.blur(); } };
    }
    el.querySelector('.tk-del')?.addEventListener('click', async () => {
      if (!confirm('Delete this ticket (and its screenshot)?')) return;
      try { await api.del(`/tickets/${id}`); toast('Ticket deleted'); renderTickets(); } catch (err) { toast(err.message, 'error'); }
    });
  }
}

// 🎫 one ticket in a popout: what was sent (with its screenshot) and the answer, opened from a message about it, so
// whoever sent it needn't go to the Tickets page. Those who handle tickets get a link to it there.
async function ticketPopout(id) {
  let t;
  try { t = await api.get(`/tickets/${id}`); } catch (err) { toast(err.message === 'Ticket not found' ? 'That ticket has been deleted' : err.message, 'error'); return; }
  const [icon, kindLabel] = TICKET_KIND[t.kind] || ['🎫', 'Ticket'];
  openModal(`<div class="modal-head"><h2 style="margin:0">${icon} ${esc(t.title)}</h2><button class="icon" data-action="close-modal">✕</button></div>
    <div class="tk-pop">
      <div class="row small" style="gap:8px;flex-wrap:wrap;align-items:center">${ticketPill(t.status)}<span class="muted">${esc(kindLabel)} · ${esc(t.ref)}${t.reporter ? ` · from ${esc(t.reporter)}` : ''} · ${esc(fmtDateTime(t.created_at))}</span></div>
      ${t.reply ? `<div class="tk-pop-answer"><b>↩ The answer</b><div class="pre">${linkify(t.reply)}</div></div>`
        : `<div class="tk-pop-answer none small muted">No answer yet${t.status === 'new' ? ': it hasn\'t been looked at yet.' : '.'}</div>`}
      ${t.description ? `<div><b class="small muted">What was sent</b><div class="pre tk-desc">${linkify(t.description)}</div></div>` : ''}
      ${t.has_screenshot ? `<a href="/api/tickets/${t.id}/screenshot" data-tk-pop-shot target="_blank" rel="noopener" title="View the screenshot"><img class="tk-thumb" src="/api/tickets/${t.id}/screenshot" alt="Screenshot"></a>` : ''}
    </div>
    <div class="modal-foot row" style="gap:8px;margin-top:14px"><div class="spacer"></div>
      ${t.can_handle ? `<a class="button" href="#/tickets" data-tk-pop-page>Open on the Tickets page</a>` : ''}<button class="primary" data-action="close-modal">Close</button></div>`, { cls: 'tk-pop-modal' });
  $('[data-tk-pop-page]')?.addEventListener('click', () => closeModal());
  $('[data-tk-pop-shot]')?.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault(); imageViewer([{ src: e.currentTarget.getAttribute('href'), alt: `${t.ref} · ${t.title}` }], 0);
  });
}
