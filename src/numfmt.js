'use strict';
// Excel number formats → display text (for showing a workbook's cached values the way
// Excel does): General, decimals, thousands, percent, scientific, dates and times,
// literal text, sections (positive;negative;zero;text) and [Colour] codes.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const COLOURS = { black: '000000', blue: '0000FF', cyan: '00FFFF', green: '00FF00', magenta: 'FF00FF', red: 'FF0000', white: 'FFFFFF', yellow: 'FFFF00' };

// Split on ; outside quotes and brackets.
function sections(code) {
  const out = []; let cur = ''; let q = false; let b = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\' && !q) { cur += ch + (code[i + 1] ?? ''); i++; continue; }
    if (ch === '"') q = !q;
    else if (!q && ch === '[') b = true;
    else if (!q && ch === ']') b = false;
    if (ch === ';' && !q && !b) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function general(v) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e11 || abs < 1e-9) {
    const [m, e] = v.toExponential(5).split('e');
    const exp = Number(e);
    return `${m.replace(/\.?0+$/, '')}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  const digits = Math.max(0, 10 - Math.floor(Math.log10(abs)));
  return String(Number(v.toFixed(Math.min(digits, 10)))).replace(/^(-?)0\./, '$10.');
}

const excelDate = (serial, date1904) => {
  const ms = Math.round(((date1904 ? serial + 1462 : serial) - 25569) * 86400000);
  return new Date(ms);
};

function formatDate(v, code, date1904) {
  const d = excelDate(v, date1904);
  const Y = d.getUTCFullYear(); const M = d.getUTCMonth(); const D = d.getUTCDate();
  let h = d.getUTCHours(); const mi = d.getUTCMinutes(); const sec = d.getUTCSeconds() + d.getUTCMilliseconds() / 1000;
  const ampm = /AM\/PM|A\/P/i.test(code);
  const tokens = code.match(/"[^"]*"|\\.|\[h+\]|\[m+\]|\[s+\]|AM\/PM|am\/pm|A\/P|a\/p|y+|m+|d+|h+|s+(?:\.0+)?|0+|./gi) || [];
  // "m" right after h or before s means minutes.
  const kinds = tokens.map((t) => t.toLowerCase());
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]; const k = kinds[i];
    if (t.startsWith('"')) { out.push(t.slice(1, -1)); continue; }
    if (t.startsWith('\\')) { out.push(t.slice(1)); continue; }
    if (/^\[h+\]$/.test(k)) { out.push(String(Math.floor(v * 24)).padStart(k.length - 2, '0')); continue; }
    if (/^\[m+\]$/.test(k)) { out.push(String(Math.floor(v * 1440)).padStart(k.length - 2, '0')); continue; }
    if (/^\[s+\]$/.test(k)) { out.push(String(Math.floor(v * 86400)).padStart(k.length - 2, '0')); continue; }
    if (k[0] === 'y') { out.push(k.length <= 2 ? String(Y).slice(-2) : String(Y)); continue; }
    if (k[0] === 'd') { out.push(k.length === 1 ? String(D) : k.length === 2 ? String(D).padStart(2, '0') : k.length === 3 ? DAYS[d.getUTCDay()].slice(0, 3) : DAYS[d.getUTCDay()]); continue; }
    if (k[0] === 'm' && !k.startsWith('mm/') ) {
      const prev = kinds.slice(0, i).reverse().find((x) => /^[a-z[]/.test(x));
      const next = kinds.slice(i + 1).find((x) => /^[a-z[]/.test(x));
      const minutes = k.length <= 2 && ((prev && /^h|^\[h/.test(prev)) || (next && /^s/.test(next)));
      if (minutes) out.push(k.length === 1 ? String(mi) : String(mi).padStart(2, '0'));
      else out.push(k.length === 1 ? String(M + 1) : k.length === 2 ? String(M + 1).padStart(2, '0') : k.length === 3 ? MONTHS[M].slice(0, 3) : k.length === 5 ? MONTHS[M][0] : MONTHS[M]);
      continue;
    }
    if (k[0] === 'h') { const hh = ampm ? (h % 12 || 12) : h; out.push(k.length === 1 ? String(hh) : String(hh).padStart(2, '0')); continue; }
    if (k[0] === 's') {
      const dec = (k.split('.')[1] || '').length;
      const s = dec ? sec.toFixed(dec) : String(Math.floor(sec));
      out.push(s.split('.')[0].padStart(k.startsWith('ss') ? 2 : 1, '0') + (dec ? `.${s.split('.')[1]}` : ''));
      continue;
    }
    if (/^am\/pm$/.test(k)) { out.push(h < 12 ? 'AM' : 'PM'); continue; }
    if (/^a\/p$/.test(k)) { out.push(h < 12 ? 'A' : 'P'); continue; }
    out.push(t);
  }
  return out.join('');
}

function formatNumber(v, code) {
  // literal parts and the numeric picture
  let pct = 0; let lit = '';
  const parts = []; // { lit } or { num }
  let num = '';
  const flushNum = () => { if (num) { parts.push({ num }); num = ''; } };
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') { const j = code.indexOf('"', i + 1); flushNum(); parts.push({ lit: code.slice(i + 1, j < 0 ? undefined : j) }); i = j < 0 ? code.length : j; continue; }
    if (ch === '\\') { flushNum(); parts.push({ lit: code[i + 1] ?? '' }); i++; continue; }
    if (ch === '_') { flushNum(); parts.push({ lit: ' ' }); i++; continue; }
    if (ch === '*') { i++; continue; }
    if (ch === '%') { pct++; flushNum(); parts.push({ lit: '%' }); continue; }
    if ('0#?.,'.includes(ch) || (/[Ee]/.test(ch) && /[+-]/.test(code[i + 1] || '')) || (num && /[+-]/.test(ch) && /[Ee]/.test(code[i - 1]))) { num += ch; continue; }
    flushNum();
    parts.push({ lit: ch });
  }
  flushNum();
  lit = parts;
  const numParts = parts.filter((p) => p.num);
  if (!numParts.length) return parts.map((p) => p.lit).join('');
  let value = Math.abs(v) * 100 ** pct;
  const pic = numParts.map((p) => p.num).join('');
  // scientific
  const sci = pic.match(/^([0#?.,]*)[Ee]([+-])(0+)$/);
  let text;
  if (sci) {
    const dec = (sci[1].split('.')[1] || '').replace(/[^0#?]/g, '').length;
    const [m, e] = value.toExponential(dec).split('e');
    const exp = Number(e);
    text = `${m}E${exp < 0 ? '-' : sci[2] === '+' ? '+' : ''}${String(Math.abs(exp)).padStart(sci[3].length, '0')}`;
  } else {
    // trailing commas scale by 1000
    let p = pic;
    while (/,$/.test(p.replace(/[^0#?.,]/g, ''))) { p = p.replace(/,(?=[^,]*$)/, ''); value /= 1000; }
    const [intPic, decPic = ''] = p.split('.');
    const decimals = decPic.replace(/[^0#?]/g, '');
    const minDec = (decimals.match(/0/g) || []).length;
    let fixed = value.toFixed(decimals.length);
    let [ip, dp = ''] = fixed.split('.');
    // optional decimals (#) drop trailing zeros beyond the required ones
    if (decimals.length > minDec) { dp = dp.replace(/0+$/, ''); if (dp.length < minDec) dp = dp.padEnd(minDec, '0'); }
    const minInt = (intPic.match(/0/g) || []).length;
    if (ip === '0' && minInt === 0) ip = '';
    ip = ip.padStart(minInt, '0');
    if (/,/.test(intPic)) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    text = ip + (decPic !== '' && (dp || decimals.includes('0') || /\.$/.test(p)) ? `.${dp}` : '');
  }
  // put the number where the first numeric part was; drop the other numeric parts
  let placed = false;
  return lit.map((x) => (x.num ? (placed ? '' : (placed = true, text)) : x.lit)).join('');
}

// → { text, color } (color: "RRGGBB" from a [Red]-style code, or null)
function formatValue(v, code = 'General', { date1904 = false } = {}) {
  if (v === null || v === undefined) return { text: '', color: null };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', color: null };
  const secs = sections(code || 'General');
  if (typeof v === 'string') {
    const s = secs[3] ?? (secs.length === 1 && /@/.test(secs[0]) ? secs[0] : null);
    if (!s) return { text: v, color: null };
    return { text: s.replace(/"([^"]*)"/g, '$1').replace(/\[[^\]]*\]/g, '').replace(/@/g, v), color: null };
  }
  if (!Number.isFinite(v)) return { text: String(v), color: null };
  let sec = secs[0]; let neg = false;
  const cond = (s) => s.match(/\[(<=|>=|<>|<|>|=)(-?[\d.]+)\]/);
  if (secs.some(cond)) {
    const test = (s) => { const c = cond(s); if (!c) return null; const n = Number(c[2]); return { '<': v < n, '>': v > n, '=': v === n, '<=': v <= n, '>=': v >= n, '<>': v !== n }[c[1]]; };
    sec = secs.find((s) => test(s)) ?? secs.find((s) => !cond(s)) ?? secs[0];
    neg = v < 0 && !test(sec);
  } else if (v < 0 && secs.length > 1) sec = secs[1];
  else if (v === 0 && secs.length > 2) sec = secs[2];
  else neg = v < 0;
  let color = null;
  sec = sec.replace(/\[([^\]]*)\]/g, (m, inner) => {
    const c = inner.toLowerCase();
    if (COLOURS[c]) { color = COLOURS[c]; return ''; }
    if (/^color\s*\d+$/.test(c)) return '';
    if (/^\$/.test(inner)) return inner.slice(1).split('-')[0]; // [$€-x-euro] currency
    if (/^(<|>|=)/.test(inner)) return '';
    if (/^[hms]+$/i.test(inner)) return m; // elapsed time
    return '';
  });
  if (/^general$/i.test(sec.trim())) return { text: (neg ? '-' : '') + general(Math.abs(v)), color };
  const isDate = /(^|[^"\\])[dyhs]|(^|[^"\\])m(?![^"]*")|\[h\]|AM\/PM/i.test(sec.replace(/"[^"]*"/g, '')) && !/[0#?]/.test(sec.replace(/"[^"]*"/g, '').replace(/s+\.0+/gi, ''));
  if (isDate) return { text: formatDate(v, sec, date1904), color };
  if (!/[0#?]/.test(sec)) return { text: sec.replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1').replace(/General/i, general(Math.abs(v))), color };
  if (/General/i.test(sec)) sec = sec.replace(/General/i, '0.##########');
  const text = formatNumber(Math.abs(v), sec);
  const showMinus = neg && secs.length === 1;
  return { text: (showMinus ? '-' : '') + text, color };
}

module.exports = { formatValue, excelDate };
