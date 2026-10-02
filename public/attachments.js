'use strict';
// Attachments on tasks and meetings: upload, drag and drop, paste a screenshot
// (Ctrl+V), thumbnails that open in the image viewer, rename and delete.
// Loaded before app.js; uses its helpers (and imageViewer from library.js).

const ATT_IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];
const attExt = (name) => (String(name).match(/\.([a-z0-9]{1,8})$/i) || [])[1]?.toLowerCase() || '';
const attIcon = (name) => ({ pdf: '📕', xlsx: '📊', xlsm: '📊', xls: '📊', csv: '📊', docx: '📘', doc: '📘', pptx: '📙', ppt: '📙',
  msg: '✉️', eml: '✉️', zip: '🗜', txt: '📄', log: '📄', mp4: '🎬', mov: '🎬', mp3: '🎵' }[attExt(name)] || '📎');
const attSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const attUrl = (a, download) => `/api/attachments/${a.id}/file${download ? '?download=1' : ''}`;

// owner: { kind: 'tasks' | 'meetings', id }
function attachmentsHtml(list, owner) {
  const images = list.filter((a) => ATT_IMAGE.includes(attExt(a.name)));
  const files = list.filter((a) => !ATT_IMAGE.includes(attExt(a.name)));
  return `<div class="section att-section" data-att-kind="${owner.kind}" data-att-id="${owner.id}">
    <h3>Attachments <span class="muted small">${list.length || ''}</span></h3>
    ${images.length ? `<div class="att-thumbs">${images.map((a) => `<figure class="att-thumb" data-att="${a.id}">
        <img src="${attUrl(a)}" alt="${esc(a.name)}" loading="lazy" data-att-view="${a.id}" title="${esc(a.name)} — click to view">
        <figcaption><span title="${esc(a.name)}">${esc(a.name)}</span>
          <button class="icon" data-att-rename="${a.id}" title="Rename">✎</button><button class="icon" data-att-del="${a.id}" title="Delete">✕</button></figcaption></figure>`).join('')}</div>` : ''}
    ${files.length ? `<ul class="att-files">${files.map((a) => `<li data-att="${a.id}">
        <a href="${attUrl(a, !['pdf', 'txt', 'csv', 'log', 'mp4', 'mp3'].includes(attExt(a.name)))}" target="_blank" rel="noopener">${attIcon(a.name)} ${esc(a.name)}</a>
        <span class="small muted">${attSize(a.size || 0)} · ${esc(fmtDateTime(a.created_at, { weekday: false }))}</span>
        <a class="small" href="${attUrl(a, true)}" title="Download">⬇</a>
        <button class="icon" data-att-rename="${a.id}" title="Rename">✎</button><button class="icon" data-att-del="${a.id}" title="Delete">✕</button></li>`).join('')}</ul>` : ''}
    <div class="att-drop">
      <label class="button">📎 Add files…<input type="file" multiple hidden data-att-input></label>
      <span class="small muted">or drag files here, or paste a screenshot with <kbd>Ctrl</kbd>+<kbd>V</kbd></span>
    </div>
  </div>`;
}

async function uploadAttachments(owner, files) {
  const list = [...files].filter((f) => f && f.size);
  if (!list.length) return 0;
  const big = list.filter((f) => f.size > 100 * 1024 * 1024);
  if (big.length) toast(`Too big to attach (over 100 MB): ${big.map((f) => f.name).join(', ')}`, 'error');
  let done = 0;
  for (const f of list.filter((x) => !big.includes(x))) {
    if (list.length > 1) toast(`Uploading ${done + 1} of ${list.length}…`);
    const res = await fetch(`/api/${owner.kind}/${owner.id}/attachments`, { method: 'POST', body: f,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(f.name) } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); toast(`${f.name}: ${d.error || res.statusText}`, 'error'); continue; }
    done++;
  }
  if (done) toast(`${done} file${done === 1 ? '' : 's'} attached`);
  return done;
}

// A pasted screenshot has no useful name; give it one from the date and time.
const screenshotName = (type) => {
  const d = new Date();
  return `Screenshot ${dateKey(d)} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.${(type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
};

// Hooks up an attachments section inside `root`. reload() redraws the window afterwards.
function wireAttachments(root, list, reload) {
  const sec = $('.att-section', root);
  if (!sec) return;
  const owner = { kind: sec.dataset.attKind, id: sec.dataset.attId };
  const after = async (n) => { if (n) { state.modalDirty = true; await reload(); } };
  sec.addEventListener('att-pasted', () => after(1));
  $('[data-att-input]', sec).addEventListener('change', async (e) => after(await uploadAttachments(owner, e.target.files)));
  sec.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); sec.classList.add('att-over'); } });
  sec.addEventListener('dragleave', (e) => { if (!sec.contains(e.relatedTarget)) sec.classList.remove('att-over'); });
  sec.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    sec.classList.remove('att-over');
    await after(await uploadAttachments(owner, e.dataTransfer.files));
  });
  sec.addEventListener('click', async (e) => {
    const view = e.target.closest('[data-att-view]');
    if (view) {
      const imgs = list.filter((a) => ATT_IMAGE.includes(attExt(a.name)));
      imageViewer(imgs.map((a) => ({ src: attUrl(a), alt: a.name })), imgs.findIndex((a) => String(a.id) === view.dataset.attView));
      return;
    }
    const del = e.target.closest('[data-att-del]');
    const ren = e.target.closest('[data-att-rename]');
    const a = list.find((x) => String(x.id) === (del || ren)?.dataset[del ? 'attDel' : 'attRename']);
    if (!a) return;
    try {
      if (del) {
        if (!confirm(`Delete the attachment “${a.name}”?`)) return;
        await api.del(`/attachments/${a.id}`);
        toast('Attachment deleted');
      } else {
        const ext = attExt(a.name);
        let name = prompt('New name for the attachment:', a.name);
        if (!name || name.trim() === a.name) return;
        name = name.trim();
        if (ext && attExt(name) !== ext) name = `${name}.${ext}`; // keep the file type
        await api.patch(`/attachments/${a.id}`, { name });
      }
      await after(1);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// Ctrl+V with an image or file on the clipboard, while a task or meeting window is open,
// attaches it there (text pastes carry on as normal).
document.addEventListener('paste', async (e) => {
  const sec = $('#modal[open] .att-section');
  if (!sec || $('#contacts-dialog[open], #lightbox[open]')) return;
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  const named = files.map((f) => (/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name) || !f.name
    ? new File([f], screenshotName(f.type || 'image/png'), { type: f.type }) : f));
  const n = await uploadAttachments({ kind: sec.dataset.attKind, id: sec.dataset.attId }, named);
  if (n) sec.dispatchEvent(new CustomEvent('att-pasted', { bubbles: true }));
});
