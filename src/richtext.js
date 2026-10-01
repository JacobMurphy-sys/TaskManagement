// Meeting notes are stored as a small, safe subset of HTML: bold, italic, underline,
// strikethrough, highlight (<mark>), bullet / numbered lists and line breaks.
// Everything else the browser's editor (or a paste from Word/Outlook) produces is
// reduced to that subset; attributes are never kept, so nothing can run script.

const ALLOWED = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's', mark: 'mark',
  ul: 'ul', ol: 'ol', li: 'li', p: 'p', div: 'div', h1: 'b', h2: 'b', h3: 'b', h4: 'b' };
// Tags whose content is dropped along with them.
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'head', 'title', 'xml', 'svg', 'math']);

const escapeText = (s) => s.replace(/&(?!(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);)/gi, '&amp;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A span (or font) with inline styles becomes the matching simple tag, if any.
function styledTag(attrs) {
  const style = (attrs.match(/style\s*=\s*("([^"]*)"|'([^']*)')/i) || [])[2] || '';
  const bg = style.match(/background(?:-color)?\s*:\s*([^;]+)/i);
  if (bg && !/^(transparent|inherit|initial|unset|none|rgba\([^)]*,\s*0\))\s*$/i.test(bg[1].trim()) && !/^(#fff(fff)?|white|rgb\(255,\s*255,\s*255\))$/i.test(bg[1].trim())) return 'mark';
  if (/text-decoration[^;]*underline/i.test(style)) return 'u';
  if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) return 'b';
  if (/font-style\s*:\s*italic/i.test(style)) return 'i';
  return null;
}

function sanitizeHtml(html) {
  const out = [];
  const stack = []; // { src: original tag name, out: emitted tag or null }
  let skip = null; // name of a DROP tag whose content is being skipped
  const source = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '');
  for (const part of source.split(/(<[^>]*>)/)) {
    if (!part) continue;
    if (part[0] !== '<') {
      if (!skip) out.push(escapeText(part));
      continue;
    }
    const m = part.match(/^<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>$/);
    if (!m) { if (!skip) out.push(escapeText(part)); continue; }
    const closing = !!m[1];
    const name = m[2].toLowerCase();
    if (skip) { if (closing && name === skip) skip = null; continue; }
    if (DROP.has(name)) { if (!closing && !/\/\s*$/.test(m[3])) skip = name; continue; }
    if (closing) {
      const idx = stack.map((e) => e.src).lastIndexOf(name);
      if (idx < 0) continue;
      while (stack.length > idx) { const e = stack.pop(); if (e.out) out.push(`</${e.out}>`); }
      continue;
    }
    if (name === 'br') { out.push('<br>'); continue; }
    if (/\/\s*$/.test(m[3])) continue; // other self-closing tags (img, hr, o:p/ …) carry nothing we keep
    const tag = ALLOWED[name] || (name === 'span' || name === 'font' ? styledTag(m[3]) : null);
    stack.push({ src: name, out: tag });
    if (tag) out.push(`<${tag}>`);
  }
  while (stack.length) { const e = stack.pop(); if (e.out) out.push(`</${e.out}>`); }
  const result = out.join('').trim();
  // An editor left empty often still holds "<br>" or an empty block.
  return /^(<(br|p|div)>|<\/(p|div)>|\s|&nbsp;)*$/i.test(result) ? '' : result;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? all;
});

// Plain-text version (for search, Excel, the status report and copying as text).
function htmlToText(html) {
  const lists = [];
  const text = String(html ?? '').replace(/<(\/?)(ul|ol|li|br|p|div)>/gi, (all, close, tag) => {
    tag = tag.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'ul' || tag === 'ol') {
      if (close) lists.pop(); else lists.push({ ordered: tag === 'ol', n: 0 });
      return '\n';
    }
    if (tag === 'li') {
      if (close) return '\n';
      const list = lists[lists.length - 1] || { ordered: false, n: 0 };
      list.n += 1;
      return `${'  '.repeat(Math.max(0, lists.length - 1))}${list.ordered ? `${list.n}.` : '•'} `;
    }
    return close ? '\n' : '';
  }).replace(/<[^>]*>/g, '');
  return decode(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { sanitizeHtml, htmlToText };
