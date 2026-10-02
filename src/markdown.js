'use strict';
// Markdown as Obsidian writes it, turned into HTML for the read-only Library.
// Covers what procedures and instructions typically use: headings, bold / italic /
// strikethrough / ==highlight==, lists (nested, numbered, - [ ] tasks), tables,
// quotes and > [!note] callouts (foldable too), code blocks, footnotes, #tags,
// frontmatter properties, [[wikilinks]] (with #heading and |alias), ![[embeds]] of
// images, PDFs, audio/video and other notes, and %%comments%%. Raw HTML is escaped
// except a few harmless formatting tags, so a note can never run script in the app.
//
// renderMarkdown(src, ctx) -> { html, headings, props }
//   ctx.resolveDoc(target, fromPath)  -> { id, title, path } | null
//   ctx.resolveFile(target, fromPath) -> { url, name } | null
//   ctx.loadDoc(id)                   -> markdown of another note (for ![[Note]])
//   ctx.path                          -> path of the note being rendered

const sheets = require('./sheets');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'ogv', 'mkv'];
const DOC_EXT = ['pdf', 'txt', 'csv', 'xlsx', 'xlsm', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'vsdx', 'msg', 'zip'];
const ATTACHMENT_EXT = [...IMAGE_EXT, ...AUDIO_EXT, ...VIDEO_EXT, ...DOC_EXT];
const extOf = (p) => (String(p).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';

const slugify = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
// Heading / link text without its Markdown, for outlines and anchors.
const plain = (text) => String(text)
  .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[*_=~`]/g, '').replace(/\s+/g, ' ').trim();

// ---- frontmatter --------------------------------------------------------------------

const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
function parseFrontmatter(src) {
  const m = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { props: {}, body: src };
  const props = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) {
      const cur = props[key];
      props[key] = [...(Array.isArray(cur) ? cur : cur ? [cur] : []), unquote(item[1])];
      continue;
    }
    const kv = line.match(/^([^\s:#-][^:]*):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1].trim();
    const v = kv[2].trim();
    props[key] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(',').map(unquote).filter(Boolean) : v === '' ? [] : unquote(v);
  }
  return { props, body: src.slice(m[0].length) };
}

const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean);

// Title-independent facts about a note: its properties, tags and aliases.
function docMeta(src) {
  const { props, body } = parseFrontmatter(String(src).replace(/\r\n?/g, '\n'));
  const tags = new Set(asList(props.tags ?? props.tag).map((t) => t.replace(/^#/, '')));
  const noCode = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, '');
  for (const m of noCode.matchAll(/(^|\s)#([\p{L}_][\p{L}\p{N}_/-]*)/gu)) tags.add(m[2]);
  const aliases = (Array.isArray(props.aliases ?? props.alias) ? props.aliases ?? props.alias : [props.aliases ?? props.alias])
    .map((a) => String(a ?? '').trim()).filter(Boolean);
  return { props, tags: [...tags], aliases };
}

// Plain text of a note, for search results.
const toPlainText = (src) => parseFrontmatter(String(src).replace(/\r\n?/g, '\n')).body
  .replace(/%%[\s\S]*?%%/g, '').replace(/```[^\n]*\n?/g, '').replace(/^\s*>\s?(\[![^\]]*\][+-]?)?/gm, '')
  .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^#+\s+/gm, '').replace(/[*_=~`|]/g, '').replace(/^\s*[-+]\s+(\[.\]\s+)?/gm, '').replace(/\s+/g, ' ').trim();

// ---- callouts -----------------------------------------------------------------------

const CALLOUT_ICON = { note: '✏️', abstract: '📋', info: 'ℹ️', todo: '☑️', tip: '🔥', success: '✅', question: '❓',
  warning: '⚠️', failure: '❌', danger: '⚡', bug: '🐞', example: '📝', quote: '❝' };
const CALLOUT_ALIAS = { summary: 'abstract', tldr: 'abstract', hint: 'tip', important: 'tip', check: 'success', done: 'success',
  help: 'question', faq: 'question', caution: 'warning', attention: 'warning', fail: 'failure', missing: 'failure',
  error: 'danger', cite: 'quote' };

// ---- block level --------------------------------------------------------------------

const FENCE = /^( *)(`{3,}|~{3,})\s*([^`\s]*).*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?: +|$)/;
const FOOTDEF = /^\[\^([^\]]+)\]:\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_SEP.test(lines[i + 1]);
const startsBlock = (lines, i) => {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) || FOOTDEF.test(l)
    || /^\s*\$\$/.test(l) || isTableStart(lines, i);
};
const indentOf = (l) => l.search(/\S|$/);

function codeBlock(code, lang) {
  const label = { mermaid: 'Mermaid diagram (shown as text)', dataview: 'Dataview query (not run here)',
    dataviewjs: 'Dataview script (not run here)', tasks: 'Tasks query (not run here)' }[lang] || lang;
  return `<div class="md-code">${label ? `<div class="md-code-lang">${esc(label)}</div>` : ''}<pre><code>${esc(code)}</code></pre></div>`;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let link = 0;
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += link ? '\\|' : '|'; i++; continue; }
    if (c === '`') code = !code;
    if (!code && c === '[' && s[i + 1] === '[') link++;
    if (!code && c === ']' && s[i + 1] === ']' && link) link--;
    if (c === '|' && !link && !code) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells.map((x) => x.trim());
}

function blocks(lines, st) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(FENCE))) {
      const close = new RegExp(`^\\s*${m[2][0] === '`' ? '`' : '~'}{${m[2].length},}\\s*$`);
      const body = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i].slice(Math.min(m[1].length, indentOf(lines[i]))));
      i++;
      if (m[3].toLowerCase() === 'sheet' && st.sheets) { // Sheets Extended table block
        try { out.push(sheets.sheetBlock(body.join('\n'), (c) => inline(c, st))); } catch (err) {
          out.push(`<div class="md-sheet-error">Sheet: ${esc(err.message)}</div>${codeBlock(body.join('\n'), 'sheet')}`);
        }
        continue;
      }
      out.push(codeBlock(body.join('\n'), m[3].toLowerCase()));
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      const body = [line.trim().slice(2)];
      if (!(body[0].endsWith('$$') && body[0].length >= 2)) {
        for (i++; i < lines.length && !lines[i].trim().endsWith('$$'); i++) body.push(lines[i]);
        if (i < lines.length) body.push(lines[i]);
      }
      i++;
      out.push(`<div class="md-math">${esc(body.join('\n').replace(/\$\$\s*$/, '').trim())}</div>`);
      continue;
    }
    if ((m = line.match(HEADING))) { out.push(heading(m[1].length, m[2], st)); i++; continue; }
    if (HR.test(line)) { out.push('<hr>'); i++; continue; }
    if ((m = line.match(FOOTDEF))) {
      const body = [m[2]];
      for (i++; i < lines.length && (indentOf(lines[i]) >= 2 || (!lines[i].trim() && i + 1 < lines.length && indentOf(lines[i + 1]) >= 2)); i++) body.push(lines[i].trim());
      st.footnotes.set(m[1], body);
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
      out.push(quote(inner, st));
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      const rows = [];
      const delimiter = splitRow(lines[i + 1]);
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(splitRow(lines[i]));
      if (st.sheets) { out.push(sheets.nativeTable(head, delimiter, rows, (c) => inline(c, st))); continue; }
      const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c, st)}</${tag}>`;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LIST.test(line)) {
      const [html, next] = list(lines, i, st);
      out.push(html);
      i = next;
      continue;
    }
    if (indentOf(line) >= 4) { // indented code block
      const body = [];
      for (; i < lines.length && (indentOf(lines[i]) >= 4 || !lines[i].trim()); i++) body.push(lines[i].slice(4));
      while (body.length && !body[body.length - 1].trim()) body.pop();
      out.push(codeBlock(body.join('\n'), ''));
      continue;
    }
    const para = [line];
    for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines, i); i++) para.push(lines[i]);
    const html = para.map((l) => inline(l.trim(), st)).join('<br>\n');
    out.push(/class="md-embed/.test(html) ? `<div class="md-p">${html}</div>` : `<p>${html}</p>`);
  }
  return out.join('\n');
}

function heading(level, raw, st) {
  const text = plain(raw);
  let slug = slugify(text);
  const n = (st.slugs.get(slug) || 0) + 1;
  st.slugs.set(slug, n);
  if (n > 1) slug = `${slug}-${n}`;
  st.headings.push({ level, text, slug });
  return `<h${level} id="h-${esc(slug)}" class="md-h">${inline(raw, st)}</h${level}>`;
}

function quote(inner, st) {
  const m = inner[0].match(/^\s*\[!([\w-]+)\]([+-]?)\s*(.*)$/);
  if (!m) return `<blockquote>${blocks(inner, st)}</blockquote>`;
  const type = m[1].toLowerCase();
  const kind = CALLOUT_ALIAS[type] || (CALLOUT_ICON[type] ? type : 'note');
  const title = m[3] ? inline(m[3], st) : esc(type[0].toUpperCase() + type.slice(1));
  const body = blocks(inner.slice(1), st);
  const head = `<span class="callout-icon">${CALLOUT_ICON[kind]}</span><span class="callout-title-text">${title}</span>`;
  const content = body ? `<div class="callout-content">${body}</div>` : '';
  return m[2]
    ? `<details class="callout callout-${kind}"${m[2] === '+' ? ' open' : ''}><summary class="callout-title">${head}</summary>${content}</details>`
    : `<div class="callout callout-${kind}"><div class="callout-title">${head}</div>${content}</div>`;
}

function list(lines, i, st) {
  const first = lines[i].match(LIST);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  while (i < lines.length) {
    const m = lines[i].match(LIST);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered || HR.test(lines[i])) break;
    const col = m[0].length;
    const body = [lines[i].slice(col)];
    let blanks = 0;
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) { blanks++; continue; }
      const ind = indentOf(l);
      if (ind > base) {
        for (; blanks > 0; blanks--) body.push('');
        body.push(l.slice(Math.min(ind, col)));
        continue;
      }
      if (!blanks && !startsBlock(lines, i)) { body.push(l.trim()); continue; } // lazy continuation
      break;
    }
    items.push(body);
  }
  const start = ordered ? parseInt(first[2], 10) : 1;
  const tag = ordered ? 'ol' : 'ul';
  return [`<${tag}${start !== 1 ? ` start="${start}"` : ''}>${items.map((b) => listItem(b, st)).join('')}</${tag}>`, i];
}

function listItem(body, st) {
  let first = body[0];
  const task = first.match(/^\[(.)\](?:\s+(.*))?$/);
  if (task) first = task[2] || '';
  const inner = blocks([first, ...body.slice(1)], st).replace(/^<p>([\s\S]*?)<\/p>/, '$1');
  if (!task) return `<li>${inner}</li>`;
  const done = task[1] !== ' ';
  return `<li class="task-item${done ? ' is-checked' : ''}" data-task="${esc(task[1])}"><input type="checkbox" disabled${done ? ' checked' : ''}> ${inner}</li>`;
}

// ---- inline ---------------------------------------------------------------------------

const splitHash = (s) => {
  const k = s.indexOf('#');
  const target = (k < 0 ? s : s.slice(0, k)).trim();
  const heading = k < 0 ? '' : s.slice(k + 1).trim();
  return [target, heading.startsWith('^') ? '' : heading];
};
const docHref = (doc, heading) => `#/library/${doc.id}${heading ? `/${encodeURIComponent(slugify(heading))}` : ''}`;

function wikilink(inner, st) {
  const [raw, ...rest] = inner.replace(/\\\|/g, '|').split('|');
  const alias = rest.join('|').trim();
  const [target, heading] = splitHash(raw);
  const name = target.replace(/\.md$/i, '').split('/').pop();
  const label = alias || (target ? (heading ? `${name} › ${heading}` : name) : heading);
  if (!target && heading) return `<a class="wikilink" data-scroll="h-${esc(slugify(heading))}">${esc(label)}</a>`;
  const doc = st.ctx.resolveDoc?.(target, st.ctx.path);
  if (doc) return `<a class="wikilink" href="${docHref(doc, heading)}" title="${esc(doc.title)}">${esc(label)}</a>`;
  const file = st.ctx.resolveFile?.(target, st.ctx.path);
  if (file) return `<a class="wikilink" href="${esc(file.url)}" target="_blank" rel="noopener">📎 ${esc(label)}</a>`;
  return `<span class="wikilink unresolved" title="“${esc(target)}” isn't in the library">${esc(label)}</span>`;
}

function media(file, ext, alt, size) {
  if (IMAGE_EXT.includes(ext)) {
    return `<img class="md-img" src="${esc(file.url)}" alt="${esc(alt)}" loading="lazy"${size ? ` width="${size[1]}"` : ''}${size?.[2] ? ` height="${size[2]}"` : ''}>`;
  }
  if (AUDIO_EXT.includes(ext)) return `<audio class="md-audio" controls preload="none" src="${esc(file.url)}"></audio>`;
  if (VIDEO_EXT.includes(ext)) return `<video class="md-video" controls preload="metadata" src="${esc(file.url)}"></video>`;
  if (ext === 'pdf') {
    return `<span class="md-embed md-pdf"><a href="${esc(file.url)}" target="_blank" rel="noopener">📄 ${esc(file.name)}</a>`
      + `<iframe src="${esc(file.url)}" loading="lazy" title="${esc(file.name)}"></iframe></span>`;
  }
  return `<a class="md-file" href="${esc(file.url)}" target="_blank" rel="noopener">📎 ${esc(file.name)}</a>`;
}

// The part of a note under one heading (to the next heading of the same or higher level).
function extractSection(md, heading) {
  const lines = parseFrontmatter(String(md).replace(/\r\n?/g, '\n')).body.split('\n');
  const want = slugify(heading);
  const start = lines.findIndex((l) => { const m = l.match(HEADING); return m && slugify(plain(m[2])) === want; });
  if (start < 0) return lines.join('\n');
  const level = lines[start].match(HEADING)[1].length;
  let end = lines.findIndex((l, k) => { const m = k > start && l.match(HEADING); return m && m[1].length <= level; });
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n');
}

function embed(inner, st) {
  const parts = inner.replace(/\\\|/g, '|').split('|');
  const opt = parts.slice(1).join('|').trim();
  const [target, heading] = splitHash(parts[0]);
  const ext = extOf(target);
  if (ext && ext !== 'md') {
    const file = st.ctx.resolveFile?.(target, st.ctx.path);
    if (!file) return `<span class="wikilink unresolved" title="Attachment not found in the library">📎 ${esc(target)}</span>`;
    const size = opt.match(/^(\d+)(?:x(\d+))?$/);
    return media(file, ext, size ? target : opt || target, size);
  }
  const doc = st.ctx.resolveDoc?.(target, st.ctx.path);
  if (!doc) return `<span class="wikilink unresolved" title="“${esc(target)}” isn't in the library">⧉ ${esc(opt || target)}</span>`;
  const depth = st.ctx.depth || 0;
  const seen = st.ctx.seen || new Set();
  const title = opt || (heading ? `${doc.title} › ${heading}` : doc.title);
  if (depth >= 2 || seen.has(doc.id) || !st.ctx.loadDoc) return `<a class="wikilink" href="${docHref(doc, heading)}">⧉ ${esc(title)}</a>`;
  const md = st.ctx.loadDoc(doc.id) || '';
  const sub = renderMarkdown(heading ? extractSection(md, heading) : md,
    { ...st.ctx, path: doc.path, depth: depth + 1, seen: new Set([...seen, doc.id]) });
  return `<span class="md-embed md-embed-note"><span class="md-embed-title"><a class="wikilink" href="${docHref(doc, heading)}">⧉ ${esc(title)}</a></span>`
    + `<span class="md-embed-body">${sub.html}</span></span>`;
}

function mdLink(label, url, st) {
  url = url.trim().replace(/\s+"[^"]*"$/, '');
  if (/^(https?|mailto|onenote):/i.test(url)) return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inline(label, st)}</a>`;
  if (/^obsidian:/i.test(url)) { // obsidian://open?vault=…&file=Folder%2FNote
    const file = (url.match(/[?&]file=([^&]+)/) || [])[1];
    const doc = file && st.ctx.resolveDoc?.(decodeURIComponent(file), st.ctx.path);
    return doc ? `<a class="wikilink" href="${docHref(doc)}">${inline(label, st)}</a>` : `<span class="wikilink unresolved">${inline(label, st)}</span>`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return inline(label, st); // other schemes (javascript:, file:…) aren't links
  let target = url;
  try { target = decodeURIComponent(url); } catch { /* keep as is */ }
  const [path, heading] = splitHash(target);
  if (!path && heading) return `<a class="wikilink" data-scroll="h-${esc(slugify(heading))}">${inline(label, st)}</a>`;
  const ext = extOf(path);
  if (ext && ext !== 'md') {
    const file = st.ctx.resolveFile?.(path, st.ctx.path);
    return file ? `<a href="${esc(file.url)}" target="_blank" rel="noopener">${inline(label, st)}</a>` : `<span class="wikilink unresolved">${inline(label, st)}</span>`;
  }
  const doc = st.ctx.resolveDoc?.(path, st.ctx.path);
  return doc ? `<a class="wikilink" href="${docHref(doc, heading)}">${inline(label, st)}</a>` : `<span class="wikilink unresolved">${inline(label, st)}</span>`;
}

function image(alt, url, st) {
  const [text, sizeText = ''] = alt.split('|');
  const size = sizeText.trim().match(/^(\d+)(?:x(\d+))?$/);
  url = url.trim().replace(/\s+"[^"]*"$/, '');
  if (/^https?:/i.test(url)) return media({ url, name: text }, 'png', text, size);
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return esc(text);
  let target = url;
  try { target = decodeURIComponent(url); } catch { /* keep as is */ }
  const file = st.ctx.resolveFile?.(target, st.ctx.path);
  return file ? media(file, extOf(target) || 'png', text, size) : `<span class="wikilink unresolved">🖼 ${esc(text || target)}</span>`;
}

function fnRef(id, st) {
  if (!st.fnOrder.includes(id)) st.fnOrder.push(id);
  return `<sup class="md-fn-ref"><a data-scroll="fn-${esc(slugify(id))}">${st.fnOrder.indexOf(id) + 1}</a></sup>`;
}

const SAFE_TAGS = /<(\/?)(br|u|sup|sub|kbd|mark|b|i|s|em|strong|small|del|ins)\s*\/?>/gi;

function inline(text, st) {
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0001`;
  let s = String(text)
    .replace(/(`+)(.+?)\1(?!`)/g, (m, t, c) => hold(`<code>${esc(c.replace(/^ (.*) $/, '$1'))}</code>`))
    .replace(/!\[\[([^\]\n]+?)\]\]/g, (m, inner) => hold(embed(inner, st)))
    .replace(/\[\[([^\]\n]+?)\]\]/g, (m, inner) => hold(wikilink(inner, st)))
    .replace(/\\([\\`*_{}[\]()#+\-.!|~=<>$%^])/g, (m, c) => hold(esc(c)))
    .replace(SAFE_TAGS, (m, c, t) => hold(t.toLowerCase() === 'br' ? '<br>' : `<${c}${t.toLowerCase()}>`))
    .replace(/!\[([^\]\n]*)\]\(\s*<?([^)>\n]+?)>?\s*\)/g, (m, alt, url) => hold(image(alt, url, st)))
    .replace(/\[([^\]\n]+)\]\(\s*<?([^)>\n]+?)>?\s*\)/g, (m, label, url) => hold(mdLink(label, url, st)))
    .replace(/\[\^([^\]\s]+)\]/g, (m, id) => hold(fnRef(id, st)))
    .replace(/\bhttps?:\/\/[^\s<>()\u0000\u0001]*[^\s<>().,;:!?'"\u0000\u0001]/g,
      (u) => hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`));
  s = esc(s)
    .replace(/\*\*\*(\S(?:.*?\S)??)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(\S(?:.*?\S)??)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(\S(?:.*?\S)??)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(\S(?:.*?\S)??)~~/g, '<del>$1</del>')
    .replace(/==(\S(?:.*?\S)??)==/g, '<mark>$1</mark>')
    .replace(/(^|\s)#([\p{L}_][\p{L}\p{N}_/-]*)/gu, '$1<span class="md-tag">#$2</span>');
  return s.replace(/\u0000(\d+)\u0001/g, (m, n) => slots[n]);
}

// ---- entry point ----------------------------------------------------------------------

function renderMarkdown(src, ctx = {}) {
  const { props, body } = parseFrontmatter(String(src ?? '').replace(/\r\n?/g, '\n'));
  // Sheets Extended table features, unless the note opts out like it does in Obsidian.
  const sheetsOn = ctx.sheets !== false && !/^(true|yes)$/i.test(String(props['disable-sheet'] ?? ''));
  const st = { ctx, headings: [], slugs: new Map(), footnotes: new Map(), fnOrder: [], sheets: sheetsOn };
  const lines = body.replace(/%%[\s\S]*?%%/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n')
    .map((l) => l.replace(/\t/g, '    ').replace(/\s\^[A-Za-z0-9-]+\s*$/, '')); // drop ^block-ids
  let html = blocks(lines, st);
  const notes = st.fnOrder.filter((id) => st.footnotes.has(id));
  if (notes.length) {
    html += `<section class="md-footnotes"><hr><ol>${notes.map((id) => `<li id="fn-${esc(slugify(id))}">`
      + `${blocks(st.footnotes.get(id), st).replace(/^<p>([\s\S]*?)<\/p>/, '$1')}</li>`).join('')}</ol></section>`;
  }
  return { html, headings: st.headings, props };
}

module.exports = { renderMarkdown, docMeta, toPlainText, parseFrontmatter, slugify, extOf, ATTACHMENT_EXT, IMAGE_EXT };
