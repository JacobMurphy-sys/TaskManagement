'use strict';
// 📚 Library: read-only instructions and procedures imported from an Obsidian vault.
// The server renders each note's Markdown (see src/markdown.js); this page shows the
// folder tree, search, the note, and what links to it. Loaded before app.js.

const LIB_ATTACH_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac',
  'mp4', 'webm', 'mov', 'ogv', 'mkv', 'pdf', 'txt', 'csv', 'xlsx', 'xlsm', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'vsdx', 'msg', 'zip'];
const libExt = (p) => (String(p).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
const HIDDEN_PROPS = ['tags', 'tag', 'aliases', 'alias', 'cssclasses', 'cssclass', 'position', 'publish'];

async function renderLibrary(arg, extra) {
  if (arg === 'find') { // [[Name]] clicked in a task or project description
    const target = decodeURIComponent(extra || '');
    try {
      const r = await api.get(`/library/resolve?t=${encodeURIComponent(target)}`);
      location.replace(`#/library/${r.id}${r.slug ? `/${r.slug}` : ''}`);
    } catch {
      main().innerHTML = `<div class="card"><h2>“${esc(target)}” isn't in the library</h2>
        <p class="muted">Check the name, or update the library from your vault.</p><a href="#/library">Open the library</a></div>`;
    }
    return;
  }
  const lib = await api.get('/library');
  state.library = lib;
  if (!lib.docs.length) {
    main().innerHTML = `<h1>📚 Library</h1>
      <div class="card lib-empty"><h2>Bring in your Obsidian vault</h2>
        <p>Instructions, procedures and reference notes from Obsidian, kept with their folders and formatting —
          headings, lists and checklists, tables, callouts, highlights, images, PDFs and the links between notes.
          They're read-only here; keep editing them in Obsidian and update the library whenever you like.</p>
        <button class="primary" data-action="library-import">📥 Import Obsidian vault…</button></div>`;
    return;
  }
  const id = Number(arg) || null;
  let doc = null;
  if (id) {
    try { doc = await api.get(`/library/docs/${id}`); } catch (err) { toast(err.message, 'error'); }
  }
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">📚 Library</h1>
      <span class="muted small">${lib.docs.length} note${lib.docs.length === 1 ? '' : 's'}${lib.source ? ` from “${esc(lib.source)}”` : ''}
        · updated ${esc(fmtDateTime(lib.imported_at))} · read-only</span>
      <div class="spacer"></div><button data-action="library-import" title="Import the vault again to pick up changes">📥 Update from vault…</button></div>
    <div class="lib">
      <aside class="card lib-aside">
        <input type="search" id="lib-filter" placeholder="Search the library…" autocomplete="off" value="${esc(state.libFilter || '')}">
        <nav id="lib-nav">${libTreeHtml(lib.docs, id)}</nav>
      </aside>
      <article class="card lib-doc">${doc ? libDocHtml(doc) : libHomeHtml(lib)}</article>
    </div>`;
  const nav = $('#lib-nav');
  nav.addEventListener('toggle', (e) => { // remember which folders are folded
    const f = e.target.dataset?.folder;
    if (f === undefined) return;
    const closed = new Set(store.get('libClosed', []));
    if (e.target.open) closed.delete(f); else closed.add(f);
    store.set('libClosed', [...closed]);
  }, true);
  let timer = null;
  const filter = async () => {
    const q = $('#lib-filter').value.trim();
    state.libFilter = q;
    if (!q) { nav.innerHTML = libTreeHtml(lib.docs, id); return; }
    const hits = await api.get(`/library/search?q=${encodeURIComponent(q)}`);
    if ($('#lib-filter')?.value.trim() !== q) return;
    nav.innerHTML = hits.length ? hits.map((h) => `<a class="lib-hit ${h.id === id ? 'on' : ''}" href="#/library/${h.id}">
        <b>${markTerm(h.title, q)}</b>${h.folder ? `<span class="small muted"> · ${esc(h.folder)}</span>` : ''}
        <span class="small muted lib-snippet">${markTerm(h.snippet, q)}</span></a>`).join('')
      : '<div class="empty small">Nothing matches.</div>';
  };
  $('#lib-filter').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(filter, 200); });
  if (state.libFilter) filter();
  const slug = extra && decodeURIComponent(extra);
  const target = slug && $(`#h-${CSS.escape(slug)}`);
  if (target) scrollToEl(target); else main().scrollTop = 0;
  $('.lib-item.on')?.scrollIntoView({ block: 'nearest' });
}

const markTerm = (text, q) => {
  const s = String(text ?? '');
  const k = s.toLowerCase().indexOf(q.toLowerCase());
  return k < 0 ? esc(s) : `${esc(s.slice(0, k))}<mark>${esc(s.slice(k, k + q.length))}</mark>${esc(s.slice(k + q.length))}`;
};

function scrollToEl(el) {
  el.scrollIntoView({ block: 'start' });
  el.classList.add('lib-flash');
  setTimeout(() => el.classList.remove('lib-flash'), 1600);
}

function libTreeHtml(docs, currentId) {
  const root = { folders: new Map(), docs: [] };
  for (const d of docs) {
    let node = root;
    for (const part of d.folder ? d.folder.split('/') : []) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), docs: [] });
      node = node.folders.get(part);
    }
    node.docs.push(d);
  }
  const closed = new Set(store.get('libClosed', []));
  const cur = docs.find((d) => d.id === currentId);
  const count = (n) => n.docs.length + [...n.folders.values()].reduce((a, c) => a + count(c), 0);
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const draw = (node, prefix) => [...node.folders.entries()].sort((a, b) => cmp(a[0], b[0])).map(([name, child]) => {
    const p = prefix ? `${prefix}/${name}` : name;
    const open = !closed.has(p) || (cur && (cur.folder === p || cur.folder.startsWith(`${p}/`)));
    return `<details class="lib-folder" data-folder="${esc(p)}" ${open ? 'open' : ''}><summary>📁 ${esc(name)} <span class="muted small">${count(child)}</span></summary>
      <div class="lib-children">${draw(child, p)}</div></details>`;
  }).join('') + node.docs.sort((a, b) => cmp(a.title, b.title)).map((d) =>
    `<a class="lib-item ${d.id === currentId ? 'on' : ''}" href="#/library/${d.id}" title="${esc(d.path)}">📄 ${esc(d.title)}</a>`).join('');
  return draw(root, '');
}

function libHomeHtml(lib) {
  const tags = new Map();
  for (const d of lib.docs) for (const t of String(d.tags || '').split(', ').filter(Boolean)) tags.set(t, (tags.get(t) || 0) + 1);
  const folders = new Set(lib.docs.map((d) => d.folder.split('/')[0]).filter(Boolean));
  const recent = [...lib.docs].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 8);
  return `<h2 style="margin-top:0">Your library</h2>
    <p class="muted">${lib.docs.length} notes in ${folders.size} folder${folders.size === 1 ? '' : 's'}, ${lib.files} attachment${lib.files === 1 ? '' : 's'}.
      Pick a note on the left, or search. To link a procedure from a task or project, put its name in double square brackets in the
      description, e.g. <code>[[Lockout procedure]]</code> (🔗 on a note copies it for you).</p>
    <h3>Recently changed in the vault</h3>
    <ul class="mini">${recent.map((d) => `<li><a href="#/library/${d.id}">📄 ${esc(d.title)}</a> <span class="small muted">${esc(d.folder)} · ${esc(fmtDate(d.updated_at))}</span></li>`).join('')}</ul>
    ${tags.size ? `<h3>Tags</h3><div class="lib-tags">${[...tags].sort((a, b) => b[1] - a[1]).map(([t, n]) =>
      `<button class="md-tag" data-lib-tag="${esc(t)}">#${esc(t)} <span class="muted">${n}</span></button>`).join(' ')}</div>` : ''}`;
}

function libDocHtml(d) {
  const props = Object.entries(d.props || {}).filter(([k, v]) => !HIDDEN_PROPS.includes(k.toLowerCase()) && String(v).trim());
  const tags = String(d.tags || '').split(', ').filter(Boolean);
  const aliases = String(d.aliases || '').split('\n').filter(Boolean);
  const first = d.headings[0];
  const titleInBody = first && first.level === 1 && first.text.toLowerCase() === d.title.toLowerCase();
  const top = Math.min(...d.headings.map((h) => h.level));
  const val = (v) => (Array.isArray(v) ? v.map((x) => esc(x)).join(', ') : esc(v));
  const linked = [...d.linked_projects.map((p) => `<li><a href="#/project/${p.id}">📁 ${esc(p.name)}</a></li>`),
    ...d.linked_tasks.map((t) => `<li><span class="t" data-action="open-task" data-id="${t.id}">${t.status === 'done' ? '✅' : '☐'} ${esc(t.title)}</span>
      ${t.project_name ? `<a class="small" href="#/project/${t.project_id}">${esc(t.project_name)}</a>` : ''}</li>`)];
  return `<div class="lib-toolbar row">
      <span class="small muted">📚${d.folder ? ` ${d.folder.split('/').map(esc).join(' <span>›</span> ')}` : ''}</span><div class="spacer"></div>
      <button class="icon" data-action="library-copy-link" data-title="${esc(d.title)}" title="Copy a [[link]] to this note for a task or project description">🔗 Link</button>
      <button class="icon" data-action="library-print" title="Print this note">🖨 Print</button></div>
    ${titleInBody ? '' : `<h1 class="lib-title">${esc(d.title)}</h1>`}
    ${props.length || tags.length || aliases.length ? `<div class="lib-props">
      ${aliases.length ? `<div><span>Aliases</span><span>${aliases.map(esc).join(', ')}</span></div>` : ''}
      ${tags.length ? `<div><span>Tags</span><span>${tags.map((t) => `<button class="md-tag" data-lib-tag="${esc(t)}">#${esc(t)}</button>`).join(' ')}</span></div>` : ''}
      ${props.map(([k, v]) => `<div><span>${esc(k)}</span><span>${val(v)}</span></div>`).join('')}</div>` : ''}
    ${d.headings.length >= 3 ? `<details class="lib-toc"><summary>Contents</summary>${d.headings.map((h) =>
      `<a data-scroll="h-${esc(h.slug)}" style="padding-left:${(h.level - top) * 14 + 4}px">${esc(h.text)}</a>`).join('')}</details>` : ''}
    <div class="md">${d.html}</div>
    <div class="lib-foot">
      ${d.backlinks.length ? `<div><h3>Linked from</h3><ul class="mini">${d.backlinks.map((b) => `<li><a href="#/library/${b.id}">📄 ${esc(b.title)}</a>
        ${b.folder ? `<span class="small muted">${esc(b.folder)}</span>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${linked.length ? `<div><h3>Used in</h3><ul class="mini">${linked.join('')}</ul></div>` : ''}
      <div class="small muted">${esc(d.path)} · last changed in the vault ${esc(fmtDateTime(d.updated_at))} · imported ${esc(fmtDateTime(d.imported_at))}</div>
    </div>`;
}

// In-note links (contents, footnotes, [[#Heading]]) scroll instead of changing the page.
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-scroll]');
  if (a) {
    e.preventDefault();
    const el = document.getElementById(a.dataset.scroll);
    if (el) scrollToEl(el);
    return;
  }
  const tag = e.target.closest('[data-lib-tag]');
  if (tag) {
    state.libFilter = `#${tag.dataset.libTag}`;
    if (location.hash.startsWith('#/library')) route(); else location.hash = '#/library';
  }
});

// ---- importing the vault --------------------------------------------------------------

function libraryImportDialog() {
  const has = state.library?.docs?.length;
  openModal(`
    <div class="modal-head"><h2 style="margin:0">📥 ${has ? 'Update from' : 'Import'} your Obsidian vault</h2><button class="icon" data-action="close-modal">✕</button></div>
    <p>Choose the vault folder (the one that contains the hidden <code>.obsidian</code> folder). Every note (<code>.md</code>) is copied in
      with its folders, together with images, PDFs and other attachments. Obsidian's settings, plugins and trash are left out,
      and nothing in your vault is changed.</p>
    <p class="small muted">The browser will ask you to confirm “uploading” the files — they only go to the CI Manager on this PC.
      ${has ? 'Notes changed since last time are refreshed, new ones added and ones deleted from the vault removed.' : 'Import again at any time to pick up changes.'}</p>
    <div class="row"><label class="button primary">📁 Choose vault folder…<input type="file" id="vault-pick" webkitdirectory multiple hidden></label></div>
    <div id="vault-progress" style="margin-top:12px"></div>
    ${has ? `<div class="section row"><span class="small muted">${state.library.docs.length} notes in the library now.</span><div class="spacer"></div>
      <button class="danger" id="lib-remove">Remove the library…</button></div>` : ''}`);
  $('#vault-pick').addEventListener('change', (e) => importVaultFiles([...e.target.files]));
  $('#lib-remove')?.addEventListener('click', async () => {
    if (!confirm('Remove all notes and attachments from the library? (Your Obsidian vault is not touched.)')) return;
    await api.del('/library');
    closeModal();
    toast('Library removed');
    if (location.hash.startsWith('#/library')) { location.hash = '#/library'; route(); }
  });
}

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(file);
});

async function importVaultFiles(all) {
  const box = $('#vault-progress');
  const source = (all[0]?.webkitRelativePath || '').split('/')[0];
  const tooBig = [];
  const wanted = all.map((f) => ({ f, rel: f.webkitRelativePath.split('/').slice(1).join('/') }))
    .filter((x) => x.rel && !x.rel.split('/').some((seg) => seg.startsWith('.')))
    .filter((x) => libExt(x.rel) === 'md' || LIB_ATTACH_EXT.includes(libExt(x.rel)))
    .filter((x) => (x.f.size > 55 * 1024 * 1024 ? (tooBig.push(x.rel), false) : true));
  const notes = wanted.filter((x) => libExt(x.rel) === 'md').length;
  if (!notes) {
    box.innerHTML = `<p class="restore-warn">No notes (.md files) in “${esc(source)}”. Pick the vault folder itself.</p>`;
    return;
  }
  const draw = (done, msg) => {
    box.innerHTML = `<div class="small">${esc(msg)}</div><div class="progress" style="margin-top:6px"><div style="width:${Math.round((done / wanted.length) * 100)}%"></div></div>`;
  };
  try {
    draw(0, `Reading “${source}”: ${notes} notes, ${wanted.length - notes} attachments…`);
    const { id } = await api.post('/library/import', { source });
    let batch = [];
    let size = 0;
    let done = 0;
    const flush = async () => {
      if (!batch.length) return;
      await api.post(`/library/import/${id}/files`, { files: batch });
      done += batch.length;
      batch = [];
      size = 0;
      draw(done, `Copying… ${done} of ${wanted.length} files`);
    };
    for (const x of wanted) {
      const item = libExt(x.rel) === 'md' ? { path: x.rel, text: await x.f.text() } : { path: x.rel, base64: await fileToBase64(x.f) };
      const bytes = (item.text ?? item.base64).length;
      if (size && size + bytes > 12e6) await flush();
      batch.push(item);
      size += bytes;
      if (batch.length >= 300) await flush();
    }
    await flush();
    const r = await api.post(`/library/import/${id}/finish`);
    box.innerHTML = `<div class="ok-note">✅ <b>${r.notes} notes</b> and ${r.files} attachments are in the library.
      ${state.library?.docs?.length ? `<br><span class="small">${r.added} new · ${r.updated} changed · ${r.unchanged} unchanged · ${r.removed} removed</span>` : ''}
      ${tooBig.length ? `<br><span class="small">Left out (over 55 MB): ${tooBig.map(esc).join(', ')}</span>` : ''}</div>
      <div class="row" style="margin-top:10px"><div class="spacer"></div><a class="button primary" href="#/library" data-action="close-modal-go">Open the library</a></div>`;
    if (location.hash.startsWith('#/library')) route();
  } catch (err) {
    box.innerHTML = `<p class="restore-warn">Import failed: ${esc(err.message)}. The library is unchanged.</p>`;
  }
}
