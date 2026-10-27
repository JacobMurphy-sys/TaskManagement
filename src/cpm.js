'use strict';
// 📐 CPM — capacity planning for Prod Management, on a macro level: the customer forecasts against what
// was persoed, a flex value learned from earlier years (actual ÷ forecast, month by month), and the demand
// per technology (DOD / Emboss / Laser) against the machines' capacity by month or week — with scenarios
// laid over it (machines added, removed or changed, speeds, shifts, OEE, volumes), each person's own.
//
//   demand needed  = forecast × flex × the customer's share for the technology ÷ its OEE
//   capacity       = Σ machines able to run it: speed × working days × shifts × productive hours
// Machines and speeds are Production's (⚙ Setup); a machine running several technologies gives its hours
// to whichever falls short. Forecasts follow the SITHUB workbook's rules (BeNeLux: Line_Qty where
// Man_SubArea_Nm is Benelux and Item_Nm contains "basic"; Amex: TOTAL BAU, with its technology rows).
// Actuals come from DailyPersoData, each card's technology from its type in the card database.
const db = require('./db');
const { readBook, colLetters } = require('./xlsxread');
const { sheetRows } = require('./kpidata');
const planning = require('./planning');

const TECHS = ['DOD', 'Emboss', 'Laser'];
// DOD, EMB, Emboss, CRAT, Laser, LAS… → DOD / Emboss / Laser (anything else kept as it is)
function normTech(v) {
  const s = String(v ?? '').trim(); if (!s) return null;
  if (/dod/i.test(s)) return 'DOD';
  if (/emb|crat/i.test(s)) return 'Emboss';
  if (/las/i.test(s)) return 'Laser';
  return s;
}
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// a month: 1–12, a month's name, 2026-01 / 01/2026, or a date
const monthOf = (v) => {
  if (typeof v === 'number' && v > 30000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).getUTCMonth() + 1;
  const t = String(v ?? '').trim().toLowerCase(); if (/^\d{1,2}(\.0+)?$/.test(t) && +t >= 1 && +t <= 12) return +t;
  let m = t.match(/^\d{4}[-/.](\d{1,2})\b/) || t.match(/^(\d{1,2})[-/.]\d{4}$/); if (m && +m[1] >= 1 && +m[1] <= 12) return +m[1];
  m = t.match(/^\d{1,2}[/.-](\d{1,2})[/.-]\d{4}$/); if (m && +m[1] >= 1 && +m[1] <= 12) return +m[1];
  const i = MONTHS.findIndex((x) => t.startsWith(x)); return i >= 0 ? i + 1 : null;
};
const setting = (k, d) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value ?? d;
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---- customers ------------------------------------------------------------------------------------
function customers() {
  return db.all('SELECT * FROM cpm_customers ORDER BY trigram').map((c) => ({ ...c, split: json(c.split, null), oee: json(c.oee, null),
    fc_names: String(c.fc_names || '').split('|').map((x) => x.trim()).filter(Boolean), active: !!c.active }));
}
// a forecast's customer name → trigram (its forecast names, or its own name)
function nameMap() {
  const m = new Map();
  for (const c of customers()) { for (const n of [...c.fc_names, c.name]) if (n) m.set(n.trim().toLowerCase(), c.trigram); }
  return m;
}

// ---- forecasts (SITHUB rules) ----------------------------------------------------------------------
// As Reporting reads it into SITHUB: the LIVE_EU_PAY_CARDS sheet (else the first), its headings in its
// first filled row; a column found by its heading, else where SITHUB's formulas expect it (they use
// fixed columns: year A, month D, sub-area I, customer M, item W, quantity AM).
const BNL_COLS = { year: ['Line_Year', 0], month: ['Line_Month', 3], area: ['Man_SubArea_Nm', 8], cust: ['Cust_Nm', 12], item: ['Item_Nm', 22], qty: ['Line_Qty', 38] };
function parseBenelux(buf, info = {}) {
  const book = readBook(buf);
  const name = (book.sheets.find((x) => /^live_eu_pay_cards$/i.test(x.name)) || book.sheets[0])?.name;
  if (!name) throw new Error('The file has no sheets');
  const sh = book.sheet(name);
  let top = Infinity; let left = Infinity;
  for (const c of sh.cells.values()) if (c.v !== null && c.v !== undefined && c.v !== '') { if (c.row < top) top = c.row; if (c.col < left) left = c.col; }
  if (top === Infinity) throw new Error(`The "${name}" sheet is empty`);
  const norm = (x) => String(x ?? '').trim().toLowerCase().replace(/[\s_]+/g, '');
  const heads = new Map(); for (let c = left; c <= sh.maxCol; c++) { const h = norm(sh.cells.get(`${colLetters(c)}${top}`)?.v); if (h && !heads.has(h)) heads.set(h, c); }
  const col = {}; const byPos = [];
  for (const [k, [h, off]] of Object.entries(BNL_COLS)) { col[k] = heads.get(norm(h)); if (!col[k]) { col[k] = left + off; byPos.push(`${h} → column ${colLetters(left + off)} (“${sh.cells.get(`${colLetters(left + off)}${top}`)?.v ?? ''}”)`); } }
  const v = (k, r) => sh.cells.get(`${colLetters(col[k])}${r}`)?.v;
  const sum = new Map(); let lines = 0; let kept = 0;
  for (let r = top + 1; r <= sh.maxRow; r++) {
    const q = Number(v('qty', r)) || 0; if (!q) continue; lines++;
    if (String(v('area', r) ?? '').trim().toLowerCase() !== 'benelux' || !/basic/i.test(String(v('item', r) ?? ''))) continue;
    const y = Number(v('year', r)) || dateOf(v('month', r))?.y; const m = monthOf(v('month', r));
    if (!y || !m) continue; kept++;
    const k = `${y}|${m}|${String(v('cust', r) ?? '').trim()}`;
    sum.set(k, (sum.get(k) || 0) + q);
  }
  Object.assign(info, { sheet: name, lines, kept, by_position: byPos });
  return [...sum].map(([k, qty]) => { const [y, m, nm] = k.split('|'); return { year: +y, month: +m, name: nm, tech: null, qty }; });
}
// Amex (Sittard): months across row 1 (01/MM/YYYY), sections down column A, New / Rep / Rew / Total in B
function parseAmex(buf) {
  const book = readBook(buf);
  const t = book.tables().find((x) => /sittard/i.test(x.name || x.displayName || ''));
  const sh = book.sheet(t?.sheet || book.sheets.find((s) => /sittard|amex/i.test(s.name))?.name || book.sheets[0].name);
  const v = (c, r) => sh.cells.get(`${colLetters(c)}${r}`)?.v;
  let head = 0;
  for (let r = 1; r <= 5 && !head; r++) { let n = 0; for (let c = 3; c <= Math.min(sh.maxCol, 12); c++) if (dateOf(v(c, r))) n++; if (n >= 2) head = r; }
  if (!head) throw new Error('Can\'t find the months in the Amex forecast');
  const cols = []; for (let c = 3; c <= sh.maxCol; c++) { const d = dateOf(v(c, head)); if (d) cols.push([c, d]); }
  const SECTION = { 'total bau': null, laser: 'Laser', 'emboss + crat': 'Emboss', 'dod total': 'DOD' };
  const out = []; let section;
  for (let r = head + 1; r <= sh.maxRow; r++) {
    const a = String(v(1, r) ?? '').trim().toLowerCase(); if (a) section = a;
    if (!(section in SECTION) || String(v(2, r) ?? '').trim().toLowerCase() !== 'total') continue;
    for (const [c, d] of cols) { const q = Number(v(c, r)); if (q) out.push({ year: d.y, month: d.m, name: 'AMEX', tech: SECTION[section], qty: q }); }
  }
  return out;
}
function dateOf(x) {
  if (typeof x === 'number' && x > 30000 && x < 80000) { const d = new Date(Math.round((x - 25569) * 86400000)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; }
  const m = String(x ?? '').match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); return m ? { y: +m[3], m: +m[2] } : null;
}
// Reads the linked forecast files into this month's snapshot when they changed (a file that couldn't be
// read is tried again next time). files: [{ key, file, modified, buf, error }]. force: read them anyway.
// What each read gave (or why not) is kept for the Overview: status().
function refreshForecasts(files, force = false) {
  const asOf = ymd(new Date()).slice(0, 7);
  const okSig = (f) => `${f.key}|${f.file}|${f.modified}`;
  const done = String(setting('cpm_fc_sig', '')); const doneOf = done.startsWith(`${asOf}#`) ? done.slice(asOf.length + 1).split(';') : [];
  const todo = files.filter((f) => f.buf && (force || !doneOf.includes(okSig(f))));
  const status = json(setting('cpm_fc_status', '{}'), {});
  for (const f of files) if (!f.buf) status[f.key] = f.file ? { file: f.file, error: f.error || 'can\'t be opened', at: new Date().toISOString() } : { error: 'not linked in Reporting › Sources' };
  const names = nameMap(); const now = new Date().toISOString(); const got = {};
  db.tx(() => {
    for (const f of todo) {
      const info = {};
      let rows; try { rows = f.key === 'amex' ? parseAmex(f.buf) : parseBenelux(f.buf, info); } catch (err) { got[f.key] = status[f.key] = { file: f.file, modified: f.modified, error: err.message, at: now }; continue; }
      db.run('DELETE FROM cpm_forecast WHERE as_of = ? AND source = ?', [asOf, f.key]);
      for (const r of rows) {
        const tri = f.key === 'amex' ? (names.get('amex') || 'AES') : names.get(r.name.toLowerCase()) || null;
        db.run('INSERT INTO cpm_forecast (as_of, source, year, month, trigram, name, tech, qty, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [asOf, f.key, r.year, r.month, tri, r.name, r.tech, r.qty, now]);
      }
      got[f.key] = status[f.key] = { file: f.file, modified: f.modified, rows: rows.length, years: [...new Set(rows.map((r) => r.year))].sort(), ...info, at: now };
    }
    const ok = files.filter((f) => f.buf && !status[f.key]?.error).map(okSig);
    const put = (k, val) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, val]);
    put('cpm_fc_sig', `${asOf}#${ok.join(';')}`); put('cpm_fc_status', JSON.stringify(status));
  });
  return got;
}
const forecastStatus = () => json(setting('cpm_fc_status', '{}'), {});
// Customers mapped again: forecast rows read before a name was mapped
function remapForecasts() {
  const names = nameMap();
  db.tx(() => { for (const r of db.all("SELECT DISTINCT name FROM cpm_forecast WHERE source <> 'amex'")) db.run("UPDATE cpm_forecast SET trigram = ? WHERE name = ? AND source <> 'amex'", [names.get(String(r.name || '').toLowerCase()) || null, r.name]); });
}
// The latest forecast for a year: { 'TRI|m' → { total, tech: { DOD: q… } } }, and the names not mapped to a customer
function forecastOf(year, asOf = null) {
  const at = asOf || db.get('SELECT MAX(as_of) AS a FROM cpm_forecast')?.a;
  // each source as it stood at that time (its latest read on or before it)
  const rows = at ? db.all('SELECT f.* FROM cpm_forecast f WHERE f.year = ? AND f.as_of = (SELECT MAX(g.as_of) FROM cpm_forecast g WHERE g.as_of <= ? AND g.source = f.source)', [year, at]) : [];
  // linked as the customers stand now (a name linked after the read counts straight away); a name not
  // linked to any customer still counts, under '~name'
  const names = nameMap(); const by = new Map(); const unmapped = new Map();
  // each source's total per month, as SITHUB's Database adds them up (Amex: its TOTAL BAU row)
  const sources = {}; for (const r of rows) if (!r.tech) { const x = sources[r.source] || (sources[r.source] = Array(12).fill(0)); x[r.month - 1] += r.qty; }
  for (const r of rows) {
    const tri = r.trigram || names.get(String(r.name || '').trim().toLowerCase()) || null;
    if (!tri) unmapped.set(r.name, (unmapped.get(r.name) || 0) + r.qty);
    const k = `${tri || `~${r.name}`}|${r.month}`; const x = by.get(k) || by.set(k, { total: 0, tech: {} }).get(k);
    if (r.tech) x.tech[r.tech] = (x.tech[r.tech] || 0) + r.qty; else x.total += r.qty;
  }
  return { as_of: at || null, by, sources, unmapped: [...unmapped].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty) };
}

// ---- actuals: DailyPersoData (else the timing runs), technology from the card's type ----------------
function actuals(fromDay, toDay, cards) {
  const pdata = require('./persodata');
  const machines = db.all('SELECT name, types FROM plan_machines');
  const machineTech = new Map(machines.map((m) => [String(m.name).toLowerCase(), String(m.types || '').split(/[,;/]/).map(normTech).filter(Boolean)]));
  const rows = pdata.has()
    ? db.all(`SELECT day, trigram, item, machine, SUM(qty) AS qty FROM perso_output WHERE day >= ? AND day <= ?${pdata.filterSql()} GROUP BY day, trigram, item, machine`, [fromDay, toDay])
    : (() => { try { return db.all("SELECT substr(end_at, 1, 10) AS day, trigram, item, machine, SUM(qty) AS qty FROM prod_runs WHERE source = 'perso' AND remake = 0 AND end_at IS NOT NULL AND job NOT LIKE 'M%' AND end_at >= ? AND end_at <= ? GROUP BY day, trigram, item, machine", [fromDay, `${toDay}T23:59:59`]); } catch { return []; } })();
  return rows.map((r) => {
    const card = cards ? cards.get(planning.axKey(r.item)) : null;
    const mt = machineTech.get(String(r.machine || '').toLowerCase()) || [];
    return { day: r.day, trigram: String(r.trigram || '').toUpperCase() || null, tech: normTech(card?.type) || (mt.length === 1 ? mt[0] : null), qty: r.qty || 0, card: card || null };
  });
}

// ---- cards: what a customer's volume is made of, by a card database column (for machine restrictions)
const CARD_FIELDS = { material: 'Material', name: 'Cardbody name', sides: 'Print sides', tag: 'Tag', provider: 'Provider', type: 'Type' };
const cardVal = (card, f) => String(card?.[f] ?? '').trim();
// the last year persoed: 'TRI|tech' (and '*|tech' for everyone) → Map(signature → share), a signature
// being the card's values for those fields ({ material: 'PVC' } as JSON)
function cardMix(cards, fields) {
  const to = ymd(new Date()); const fromD = new Date(); fromD.setFullYear(fromD.getFullYear() - 1);
  const by = new Map(); const put = (k, sig, q) => { const m = by.get(k) || by.set(k, new Map()).get(k); m.set(sig, (m.get(sig) || 0) + q); };
  for (const a of actuals(ymd(fromD), to, cards)) {
    if (!a.tech || !a.card) continue;
    const sig = JSON.stringify(Object.fromEntries(fields.map((f) => [f, cardVal(a.card, f)])));
    if (a.trigram) put(`${a.trigram}|${a.tech}`, sig, a.qty); put(`*|${a.tech}`, sig, a.qty);
  }
  for (const m of by.values()) { const tot = [...m.values()].reduce((x, y) => x + y, 0); for (const [k, q] of m) m.set(k, q / tot); }
  return by;
}
// a card column's values, the most persoed (last year) first: [{ value, qty }]
function cardValues(cards, field) {
  if (!CARD_FIELDS[field] || !cards) return [];
  const to = ymd(new Date()); const fromD = new Date(); fromD.setFullYear(fromD.getFullYear() - 1);
  const q = new Map(); for (const c of cards.values()) { const v = cardVal(c, field); if (v && !q.has(v)) q.set(v, 0); }
  for (const a of actuals(ymd(fromD), to, cards)) { const v = cardVal(a.card, field); if (v) q.set(v, (q.get(v) || 0) + a.qty); }
  return [...q].map(([value, qty]) => ({ value, qty })).sort((a, b) => b.qty - a.qty || a.value.localeCompare(b.value));
}

// ---- history (earlier years, uploaded) ------------------------------------------------------------
// A sheet with a row of months (JAN … DEC, or dates); a year above them (or given), FORECAST / ACTUAL above
// each month (or given); customers down the side by Trigram or Customer, perhaps a Technology. The CPM
// layout repeats a customer's total on each technology row (with a SPLIT column): taken once.
function parseHistory(buf, { kind = null, year = null } = {}) {
  const book = readBook(buf); const names = nameMap(); const out = [];
  for (const info of book.sheets) {
    if (/scenario/i.test(info.name)) continue; // a scenario copy isn't what happened
    const sh = book.sheet(info.name); const v = (c, r) => sh.cells.get(`${colLetters(c)}${r}`)?.v;
    let head = 0; let monthCols = [];
    // the header row: months, and Trigram or Customer down the side
    for (let r = 1; r <= Math.min(sh.maxRow, 12) && !head; r++) {
      const mc = []; let side = false;
      for (let c = 1; c <= sh.maxCol; c++) { const x = v(c, r); if (/^(trigram|customer)/i.test(String(x ?? '').trim())) side = true;
        const m = typeof x === 'number' && x > 30000 ? dateOf(x)?.m : (typeof x === 'string' && x.length <= 9 ? monthOf(x) : null); if (m) mc.push([c, m, typeof x === 'number' ? dateOf(x).y : null]); }
      // month names win: dates in the same row head worked-out tables beside (e.g. capacity needed)
      const named = mc.filter((x) => x[2] === null); const use = named.length >= 6 ? named : mc;
      if (use.length >= 6 && side) { head = r; monthCols = use; }
    }
    if (!head) continue;
    const label = (re) => { for (let c = 1; c <= sh.maxCol; c++) if (re.test(String(v(c, head) ?? '').trim())) return c; return null; };
    const cTri = label(/^trigram$/i); const cCust = label(/^customer/i); const cTech = label(/^tech/i); const cSplit = label(/^split$/i);
    if (!cTri && !cCust) continue;
    // each month column's year and kind: from the rows above (carried to the right), else as given
    let y = year ? Number(year) : null; let k = kind;
    const colInfo = monthCols.map(([c, m, dy]) => {
      for (let r = head - 1; r >= 1; r--) { const x = v(c, r); if (typeof x === 'number' && x >= 2000 && x <= 2100) { y = x; break; } }
      for (let r = head - 1; r >= 1; r--) { const x = String(v(c, r) ?? '').trim().toLowerCase(); if (/^act/.test(x)) { k = 'actual'; break; } if (/^(fc|forecast)/.test(x)) { k = 'forecast'; break; } }
      return { c, m, y: dy || y, k };
    });
    // a month column whose year rolls back past December belongs to the next year
    for (let i = 1; i < colInfo.length; i++) if (colInfo[i].m < colInfo[i - 1].m && colInfo[i].y === colInfo[i - 1].y) for (let j = i; j < colInfo.length; j++) if (colInfo[j].y === colInfo[i - 1].y) colInfo[j].y += 1;
    const seen = new Set();
    for (let r = head + 1; r <= sh.maxRow; r++) {
      const name = String(v(cCust, r) ?? '').trim(); let tri = String(v(cTri, r) ?? '').trim().toUpperCase();
      if (!tri && name) tri = names.get(name.toLowerCase()) || '';
      if (!tri && !name) continue;
      const tech = cTech && !cSplit ? normTech(v(cTech, r)) : null;
      const key = `${tri || name}|${tech || ''}`; if (cSplit && seen.has(key)) continue; seen.add(key);
      for (const ci of colInfo) { const q = Number(v(ci.c, r)); if (!ci.y || !ci.k || !Number.isFinite(q) || q === 0) continue; out.push({ year: ci.y, month: ci.m, trigram: tri || null, name: name || null, tech, kind: ci.k, qty: q }); }
    }
  }
  return out;
}
function storeHistory(rowsIn, file) {
  const now = new Date().toISOString();
  // the same customer, month and kind twice in one upload (two sheets): the first one counts
  const once = new Set(); const rows = rowsIn.filter((r) => { const k = `${r.year}|${r.month}|${r.trigram || r.name}|${r.tech || ''}|${r.kind}`; if (once.has(k)) return false; once.add(k); return true; }); const covered = new Set(rows.map((r) => `${r.year}|${r.month}|${r.kind}`));
  db.tx(() => {
    for (const k of covered) { const [y, m, kind] = k.split('|'); db.run('DELETE FROM cpm_history WHERE year = ? AND month = ? AND kind = ?', [+y, +m, kind]); }
    for (const r of rows) db.run('INSERT INTO cpm_history (year, month, trigram, name, tech, kind, qty, file, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [r.year, r.month, r.trigram, r.name, r.tech, r.kind, r.qty, file, now]);
  });
  const years = [...new Set(rows.map((r) => r.year))].sort();
  return { rows: rows.length, years, months: covered.size, customers: new Set(rows.map((r) => r.trigram || r.name)).size, unmapped: [...new Set(rows.filter((r) => !r.trigram).map((r) => r.name))] };
}
const historyCoverage = () => db.all('SELECT year, kind, COUNT(DISTINCT month) AS months, COUNT(DISTINCT trigram) AS customers, SUM(qty) AS qty, MAX(file) AS file, MAX(uploaded_at) AS at FROM cpm_history GROUP BY year, kind ORDER BY year, kind');

// ---- flex: actual ÷ forecast, month by month, from the history and the months gone by ----------------
function flex({ cards = null, upTo = null } = {}) {
  const pairs = new Map(); // 'TRI|y|m' → { fc, act }
  const put = (tri, y, m, k, q) => { const key = `${tri}|${y}|${m}`; const x = pairs.get(key) || pairs.set(key, { tri, y, m, fc: 0, act: 0 }).get(key); x[k] += q; };
  for (const r of db.all("SELECT trigram, year, month, kind, SUM(qty) AS q FROM cpm_history WHERE trigram IS NOT NULL GROUP BY trigram, year, month, kind")) put(r.trigram, r.year, r.month, r.kind === 'actual' ? 'act' : 'fc', r.q);
  // the months gone by since the forecast snapshots began: the forecast as it stood then, against what was done
  const uploaded = new Set(db.all('SELECT DISTINCT year, month, kind FROM cpm_history').map((r) => `${r.year}|${r.month}|${r.kind}`));
  const first = db.get('SELECT MIN(as_of) AS a FROM cpm_forecast')?.a;
  const now = upTo || ymd(new Date()).slice(0, 7);
  if (first) {
    for (let d = new Date(`${first}-01T12:00`); ymd(d).slice(0, 7) < now; d.setMonth(d.getMonth() + 1)) {
      const y = d.getFullYear(); const m = d.getMonth() + 1; const key = ym(y, m);
      const f = forecastOf(y, key);
      if (!uploaded.has(`${y}|${m}|forecast`)) for (const [k, x] of f.by) { const [tri, mm] = k.split('|'); if (+mm === m) put(tri, y, m, 'fc', x.total || Object.values(x.tech).reduce((a, b) => a + b, 0)); }
      if (!uploaded.has(`${y}|${m}|actual`)) {
        const last = new Date(y, m, 0).getDate();
        for (const a of actuals(`${key}-01`, `${key}-${pad(last)}`, cards)) if (a.trigram) put(a.trigram, y, m, 'act', a.qty);
      }
    }
  }
  const list = [...pairs.values()].filter((p) => p.fc > 0 && p.act > 0);
  const byCust = new Map();
  for (const p of list) { const c = byCust.get(p.tri) || byCust.set(p.tri, { trigram: p.tri, months: Array.from({ length: 12 }, () => []), years: new Map() }).get(p.tri);
    c.months[p.m - 1].push(p.act / p.fc); const yy = c.years.get(p.y) || c.years.set(p.y, { fc: 0, act: 0 }).get(p.y); yy.fc += p.fc; yy.act += p.act; }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const allMonths = Array.from({ length: 12 }, (_, i) => list.filter((p) => p.m === i + 1));
  const overall = { months: allMonths.map((l) => (l.length ? l.reduce((t, p) => t + p.act, 0) / l.reduce((t, p) => t + p.fc, 0) : null)),
    year: list.length ? list.reduce((t, p) => t + p.act, 0) / list.reduce((t, p) => t + p.fc, 0) : null };
  const customersOut = [...byCust.values()].map((c) => { const yrs = [...c.years].map(([y, x]) => ({ year: y, fc: x.fc, act: x.act, ratio: x.act / x.fc }));
    return { trigram: c.trigram, months: c.months.map(mean), years: yrs, year: mean(yrs.map((x) => x.ratio)), points: c.months.reduce((t, a) => t + a.length, 0) }; }).sort((a, b) => a.trigram.localeCompare(b.trigram));
  const clamp = (x) => Math.max(0.2, Math.min(3, x));
  // the factor used: the customer's for that month, else its year, else everyone's for the month, else 1
  const factor = (tri, m) => { const c = customersOut.find((x) => x.trigram === tri); const v = c?.months[m - 1] ?? c?.year ?? overall.months[m - 1] ?? overall.year; return v ? clamp(v) : 1; };
  return { customers: customersOut, overall, factor, pairs: list.length };
}

// ---- capacity: the calendar, the machines and speeds, the demand, and a scenario over them ----------
// Each technology's speed from Production's speeds (⚙ Setup): its own rule (type only), else the average
// of its rules for a material or print sides, else a rule for any type, else Production's flat rate.
// withFrom: { DOD: { speed, from } } — where it came from, to show.
function speeds(withFrom = false) {
  const rules = db.all('SELECT * FROM plan_speeds').filter((r) => Number(r.speed) > 0);
  const avg = (a) => Math.round(a.reduce((t, r) => t + Number(r.speed), 0) / a.length);
  const any = rules.filter((r) => !r.type && !r.material && !r.sides); const rate = Number(setting('plan_rate', '')) || null;
  const out = {};
  for (const t of TECHS) {
    const own = rules.filter((r) => normTech(r.type) === t);
    const plain = own.filter((r) => !r.material && !r.sides);
    out[t] = plain.length ? { speed: avg(plain), from: `Production's ${t} speed` }
      : own.length ? { speed: avg(own), from: `average of Production's ${own.length} ${t} speeds (by material / sides)` }
      : any.length ? { speed: avg(any), from: 'Production\'s speed for any type' }
      : rate ? { speed: rate, from: 'Production\'s flat rate' } : { speed: null, from: null };
  }
  return withFrom ? out : Object.fromEntries(Object.entries(out).map(([t, x]) => [t, x.speed]));
}
// OEE for a customer with none of its own here or in Production: Production's (⚙ Setup › OEE, when a
// customer has none), else capacity planning's default
function oeeFallback() {
  const p = Number(setting('plan_oee_default', '')); if (p > 0 && p <= 100) return p / 100;
  return Number(setting('cpm_oee_default', '0.35')) || 0.35;
}
const inRange = (month, c) => (!c.from || month >= c.from) && (!c.to || month <= c.to);
function calendarOf(year) {
  const workDays = new Set(String(setting('plan_days', '1,2,3,4,5')).split(',').map(Number));
  const holidays = new Set(String(setting('cpm_holidays', '')).split(/[\s,;]+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)));
  const days = [];
  for (let d = new Date(year, 0, 1, 12); d.getFullYear() === year; d.setDate(d.getDate() + 1)) {
    const k = ymd(d); days.push({ day: k, month: k.slice(0, 7), work: workDays.has(d.getDay()) && !holidays.has(k), dow: d.getDay() });
  }
  return days;
}
// the week a day falls in: Monday-start ISO weeks (W01…), labelled with their Monday
function weekOf(day) {
  const d = new Date(`${day}T12:00`); const dow = (d.getDay() + 6) % 7; const mon = new Date(d); mon.setDate(d.getDate() - dow);
  const th = new Date(mon); th.setDate(mon.getDate() + 3); const jan4 = new Date(th.getFullYear(), 0, 4, 12);
  const wk = 1 + Math.round(((th - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return { key: `${th.getFullYear()}-W${pad(wk)}`, monday: ymd(mon) };
}
/**
 * The plan for a year by month or week: per period and technology the forecast, flexed demand, the
 * capacity needed (÷ OEE), the capacity, the gap and the actual. changes: a scenario's changes.
 */
function compute({ year, period = 'month', changes = [], useFlex = true, cards = null }) {
  const cal = calendarOf(year);
  const shifts0 = Number(setting('cpm_shifts', '3')) || 3; const hours0 = Number(setting('cpm_hours', '6')) || 6;
  const oeeDefault = oeeFallback();
  const sp = speeds();
  const prodOee = new Map(db.all('SELECT customer, oee FROM plan_oee').map((r) => [String(r.customer).toUpperCase(), r.oee]));
  const all = customers(); const custs = all.filter((c) => c.active);
  const fc = forecastOf(year);
  // the forecast counts whether or not its customers are set up here: a trigram not set up takes its
  // learned split and Production's OEE; a name not linked to a customer, the mix of everything persoed
  const known = new Set(all.map((c) => c.trigram));
  for (const k of new Set([...fc.by.keys()].map((x) => x.split('|')[0]))) {
    if (known.has(k)) continue; known.add(k);
    custs.push(k.startsWith('~') ? { trigram: k, name: k.slice(1), unlinked: true, split: null, oee: null } : { trigram: k, name: k, split: null, oee: null });
  }
  let unlinkedQty = 0;
  const fx = useFlex ? flex({ cards }) : null;
  const learned = learnedSplit(cards);
  const warnings = [];
  if (!db.get('SELECT 1 FROM plan_machines WHERE active = 1')) warnings.push('No machines in Production › ⚙ Setup — there\'s no capacity to plan against');
  for (const t of TECHS) if (!sp[t]) warnings.push(`No speed for ${t} in Production › ⚙ Setup › speeds — its capacity can't be worked out`);
  // machines: Production's, with the scenario's changes (dated by month)
  const base = db.all('SELECT * FROM plan_machines WHERE active = 1 ORDER BY sort_order, id').map((m) => ({ name: m.name, techs: String(m.types || '').split(/[,;/]/).map(normTech).filter(Boolean), base: true }));
  for (const m of base) if (!m.techs.length) m.techs = [...TECHS];
  const machines = [...base, ...changes.filter((c) => c.type === 'add_machine').map((c) => ({ name: c.name || 'New machine', techs: (c.techs || []).map(normTech).filter(Boolean), added: c }))];
  // CPM's own per-machine settings: availability (share of its hours for perso) and speed per technology
  const opts = json(setting('cpm_machines', '{}'), {});
  const machineAt = (m, month) => {
    if (m.added && !inRange(month, m.added)) return null;
    if (changes.some((c) => c.type === 'remove_machine' && c.machine === m.name && inRange(month, c))) return null;
    let techs = m.techs;
    for (const c of changes) if (c.type === 'capabilities' && c.machine === m.name && inRange(month, c)) techs = (c.techs || []).map(normTech).filter(Boolean);
    const o = opts[m.name] || {};
    const speed = {}; for (const t of techs) { let s = Number(o.speed?.[t]) || sp[t] || 0; for (const c of changes) if (c.type === 'speed' && (!c.machine || c.machine === m.name) && (!c.tech || normTech(c.tech) === t) && inRange(month, c)) s *= 1 + (Number(c.pct) || 0) / 100; speed[t] = s; }
    const only = changes.filter((c) => c.type === 'restrict' && c.machine === m.name && inRange(month, c))
      .map((c) => ({ customers: (c.customers || []).length ? new Set(c.customers) : null, field: CARD_FIELDS[c.field] && (c.values || []).length ? c.field : null, values: CARD_FIELDS[c.field] && (c.values || []).length ? new Set(c.values) : null }))
      .filter((r) => r.customers || r.values);
    return { techs, speed, only, avail: o.avail === undefined || o.avail === null || o.avail === '' ? 1 : Math.max(0, Math.min(1, Number(o.avail))) };
  };
  const shiftAt = (month) => { let s = shifts0; let h = hours0; for (const c of changes) if (c.type === 'shifts' && inRange(month, c)) { if (Number(c.shifts) >= 0 && c.shifts !== '' && c.shifts !== null && c.shifts !== undefined) s = Number(c.shifts); if (Number(c.hours) > 0) h = Number(c.hours); } return { s, h }; };
  // demand per customer and month: forecast × flex (× the scenario's volume change), split, ÷ OEE
  const wdm = {}; for (const d of cal) if (d.work) wdm[d.month] = (wdm[d.month] || 0) + 1;
  const monthDemand = {}; // month → tech → { fc, demand, need }
  const custSplit = (c, m) => {
    const f = fc.by.get(`${c.trigram}|${m}`); const ft = f && Object.keys(f.tech).length ? f.tech : null;
    const s = c.split && Object.keys(c.split).length ? c.split : ft ? Object.fromEntries(Object.entries(ft).map(([t, q]) => [t, q / Object.values(ft).reduce((a, b) => a + b, 0)])) : learned.get(c.trigram) || learned.get('*') || parkMix;
    if (s === parkMix && parkMix) warnings.push('Nothing persoed with a card type to learn the split from (card database linked?) — customers without a split are spread like the machines\' capacity');
    return s;
  };
  // the last resort for a split: as the machines' hours and speeds spread over the technologies
  const parkMix = (() => { const x = {}; for (const m of base) { const o = opts[m.name] || {}; const a = o.avail === undefined || o.avail === null || o.avail === '' ? 1 : Number(o.avail) || 0;
    for (const t of m.techs) x[t] = (x[t] || 0) + ((Number(o.speed?.[t]) || sp[t] || 0) * a) / m.techs.length; }
    const tot = Object.values(x).reduce((p, q) => p + q, 0); return tot ? Object.fromEntries(Object.entries(x).map(([t, q]) => [t, q / tot])) : null; })();
  const extra = changes.filter((c) => c.type === 'new_customer');
  // machines that may only run some customers / cards: their fields' mix per customer, learned from what ran
  const restricts = changes.filter((c) => c.type === 'restrict' && c.machine);
  const rFields = [...new Set(restricts.filter((c) => c.field && CARD_FIELDS[c.field] && (c.values || []).length).map((c) => c.field))];
  const mixOf = rFields.length ? cardMix(cards, rFields) : new Map();
  if (rFields.length && !cards) warnings.push('A machine is restricted to some cards, but the card database isn\'t linked — its cards can\'t be told apart, so it gets none of that work');
  for (let m = 1; m <= 12; m++) {
    const month = ym(year, m); const md = monthDemand[month] = Object.fromEntries(TECHS.map((t) => [t, { fc: 0, demand: 0, need: 0, buckets: new Map() }]));
    const add = (tri, qty, split, oeeOf) => {
      for (const [t0, share] of Object.entries(split)) { const t = normTech(t0); if (!md[t] || !share) continue;
        let oee = oeeOf(t); for (const c of changes) if (c.type === 'oee' && (!c.customer || c.customer === tri) && (!c.tech || normTech(c.tech) === t) && inRange(month, c)) oee += (Number(c.points) || 0) / 100;
        oee = Math.max(0.05, Math.min(1, oee));
        md[t].demand += qty * share; md[t].need += (qty * share) / oee;
        if (restricts.length) { // by customer and card, for the machines that may only run some
          const mix = mixOf.get(`${tri}|${t}`) || mixOf.get(`*|${t}`) || new Map([['{}', 1]]);
          for (const [sig, f] of mix) { const k = `${tri}\u0001${sig}`; md[t].buckets.set(k, (md[t].buckets.get(k) || 0) + ((qty * share) / oee) * f); }
        } }
    };
    for (const c of custs) {
      const f = fc.by.get(`${c.trigram}|${m}`); if (!f) continue;
      if (c.unlinked) unlinkedQty += f.total || Object.values(f.tech).reduce((a, b) => a + b, 0);
      let qty = f.total || Object.values(f.tech).reduce((a, b) => a + b, 0); if (!qty) continue;
      const split = custSplit(c, m);
      if (!split) { warnings.push(`${c.unlinked ? `“${c.name}”` : c.trigram}: no technology split — set one on Customers`); continue; }
      for (const [t0, share] of Object.entries(split)) { const t = normTech(t0); if (md[t]) md[t].fc += qty * share; }
      if (fx) qty *= fx.factor(c.trigram, m);
      for (const ch of changes) if (ch.type === 'volume' && (!ch.customer || ch.customer === c.trigram) && inRange(month, ch)) qty *= 1 + (Number(ch.pct) || 0) / 100;
      const oeeOf = (t) => Number(c.oee?.[t]) || Number(prodOee.get(c.trigram)) || oeeDefault;
      add(c.trigram, qty, split, oeeOf);
    }
    for (const nc of extra) if (inRange(month, nc)) add(nc.name || 'New', Number(nc.qty) || 0, nc.split || { DOD: 1 }, () => Number(nc.oee) || oeeDefault);
  }
  // per day: demand spread over the month's working days; machine hours; then by period
  const keyOf = (d) => (period === 'week' ? weekOf(d.day).key : d.month);
  const periods = new Map();
  const acts = actuals(`${year}-01-01`, `${year}-12-31`, cards);
  const actBy = new Map(); for (const a of acts) { if (!a.tech) continue; const k = `${a.day}|${a.tech}`; actBy.set(k, (actBy.get(k) || 0) + a.qty); }
  for (const d of cal) {
    const k = keyOf(d);
    const P = periods.get(k) || periods.set(k, { key: k, label: period === 'week' ? `${k.slice(5)} · ${weekOf(d.day).monday.slice(5).split('-').reverse().join('/')}` : new Date(`${d.day}T12:00`).toLocaleDateString('en-GB', { month: 'short' }), start: d.day, end: d.day, workdays: 0,
      techs: Object.fromEntries(TECHS.map((t) => [t, { fc: 0, demand: 0, need: 0, capacity: 0, actual: 0 }])), machines: {} }).get(k);
    P.end = d.day;
    for (const t of TECHS) P.techs[t].actual += actBy.get(`${d.day}|${t}`) || 0;
    if (!d.work) continue;
    P.workdays++;
    const share = 1 / (wdm[d.month] || 1);
    for (const t of TECHS) { const md = monthDemand[d.month][t]; P.techs[t].fc += md.fc * share; P.techs[t].demand += md.demand * share; P.techs[t].need += md.need * share;
      if (md.buckets.size) { const B = P.buckets || (P.buckets = new Map()); for (const [k, q] of md.buckets) { const kk = `${t}\u0001${k}`; B.set(kk, (B.get(kk) || 0) + q * share); } } }
    const { s, h } = shiftAt(d.month);
    for (const m of machines) { const at = machineAt(m, d.month); if (!at) continue; const x = P.machines[m.name] || (P.machines[m.name] = { hours: 0, techs: at.techs, speed: at.speed }); x.hours += s * h * at.avail; x.techs = at.techs; x.speed = at.speed; x.only = at.only; }
  }
  // capacity: one-technology machines first; a machine running several gives its hours where they're short
  const out = [...periods.values()].map((P) => {
    const T = P.techs; const alloc = {};
    if (Object.values(P.machines).some((x) => x.only?.length)) placeWork(P, alloc);
    else {
    for (const [name, x] of Object.entries(P.machines)) if (x.techs.length === 1) { const t = x.techs[0]; if (T[t]) { T[t].capacity += x.hours * (x.speed[t] || 0); alloc[name] = { [t]: x.hours }; } }
    for (const [name, x] of Object.entries(P.machines)) {
      if (x.techs.length < 2) continue;
      const ts = x.techs.filter((t) => T[t] && x.speed[t] > 0); if (!ts.length) continue;
      const short = Object.fromEntries(ts.map((t) => [t, Math.max(0, T[t].need - T[t].capacity) / x.speed[t]])); // hours needed
      const want = Object.values(short).reduce((a, b) => a + b, 0);
      let left = x.hours; alloc[name] = {};
      for (const t of ts) { const hrs = want ? Math.min(short[t], x.hours * (short[t] / want)) : 0; alloc[name][t] = hrs; left -= hrs; }
      for (const t of ts) alloc[name][t] += left / ts.length; // what nobody needs, shared
      for (const t of ts) T[t].capacity += alloc[name][t] * x.speed[t];
    }
    }
    for (const t of TECHS) { const x = T[t]; x.gap = x.capacity - x.need; x.util = x.capacity ? x.need / x.capacity : null;
      if (x.unplaced > 0.005 * x.need) { x.gap = Math.min(x.gap, -x.unplaced); x.util = Math.max(x.util || 0, x.need / Math.max(1, x.need - x.unplaced)); } }
    const tot = { fc: 0, demand: 0, need: 0, capacity: 0, actual: 0 }; for (const t of TECHS) for (const k of Object.keys(tot)) tot[k] += T[t][k];
    tot.gap = tot.capacity - tot.need; tot.util = tot.capacity ? tot.need / tot.capacity : null;
    return { key: P.key, label: P.label, start: P.start, end: P.end, workdays: P.workdays, techs: T, total: tot, machines: Object.entries(P.machines).map(([name, x]) => ({ name, hours: x.hours, techs: x.techs, alloc: alloc[name] || {} })) };
  });
  return { year, period, techs: TECHS, speeds: sp, speed_from: Object.fromEntries(Object.entries(speeds(true)).map(([t, x]) => [t, x.from])), oee_fallback: oeeDefault, oee_fallback_from: Number(setting('plan_oee_default', '')) > 0 ? 'production' : 'cpm', shifts: shifts0, hours: hours0, forecast_as_of: fc.as_of, unmapped: fc.unmapped.slice(0, 30), unmapped_count: fc.unmapped.length, unmapped_qty: unlinkedQty,
    forecast_sources: fc.sources, forecast_counted: Object.fromEntries(Object.entries(monthDemand).map(([k, md]) => [k, TECHS.reduce((t, x) => t + md[x].fc, 0)])),
    forecast_total: [...fc.by.values()].reduce((t, f) => t + (f.total || Object.values(f.tech).reduce((a, b) => a + b, 0)), 0),
    machines: machines.map((m) => ({ name: m.name, techs: m.techs, added: !!m.added, ...(opts[m.name] || {}) })), periods: out, warnings: [...new Set(warnings)], flex: fx ? { overall: fx.overall.year, pairs: fx.pairs } : null };
}
// With machines that may only run some customers / cards: each piece of work (technology, customer,
// card) goes to the machines allowed it — the most restricted first, then those running one technology,
// then those running several — in proportion to what's left. Work no machine may run is 'unplaced'.
// A machine's hours left over are its technologies' capacity, shared evenly.
function placeWork(P, alloc) {
  const T = P.techs;
  const work = [...(P.buckets || new Map())].map(([k, need]) => { const [t, cust, sig] = k.split('\u0001'); return { t, cust, sig: json(sig, {}), rem: need }; });
  const may = (x, b) => x.techs.includes(b.t) && x.speed[b.t] > 0 && (x.only || []).every((r) => (!r.customers || r.customers.has(b.cust)) && (!r.values || r.values.has(String(b.sig[r.field] ?? ''))));
  const list = Object.entries(P.machines).map(([name, x]) => ({ name, x, eligible: work.filter((b) => may(x, b)) }));
  const rank = (m) => (m.x.only?.length ? 0 : m.x.techs.length === 1 ? 1 : 2);
  list.sort((a, b) => rank(a) - rank(b) || a.eligible.reduce((s, w) => s + w.rem, 0) - b.eligible.reduce((s, w) => s + w.rem, 0));
  for (const { name, x, eligible } of list) {
    const ts = x.techs.filter((t) => T[t] && x.speed[t] > 0); alloc[name] = {}; if (!ts.length) continue;
    const hrs = eligible.reduce((s, b) => s + b.rem / x.speed[b.t], 0); const use = Math.min(x.hours, hrs); const f = hrs ? use / hrs : 0;
    for (const t of ts) alloc[name][t] = 0;
    for (const b of eligible) { const done = b.rem * f; b.rem -= done; alloc[name][b.t] += done / x.speed[b.t]; }
    for (const t of ts) { alloc[name][t] += (x.hours - use) / ts.length; T[t].capacity += alloc[name][t] * x.speed[t]; }
  }
  for (const t of TECHS) T[t].unplaced = 0;
  for (const b of work) if (T[b.t]) T[b.t].unplaced += b.rem;
}

// a customer's split by technology from what was persoed over the last year: trigram → { DOD: 0.7, … }
function learnedSplit(cards) {
  const to = ymd(new Date()); const fromD = new Date(); fromD.setFullYear(fromD.getFullYear() - 1);
  const by = new Map();
  for (const a of actuals(ymd(fromD), to, cards)) { if (!a.trigram || !a.tech) continue; const x = by.get(a.trigram) || by.set(a.trigram, {}).get(a.trigram); x[a.tech] = (x[a.tech] || 0) + a.qty; }
  const all = {}; for (const x of by.values()) for (const [t, q] of Object.entries(x)) all[t] = (all[t] || 0) + q;
  if (Object.keys(all).length) by.set('*', all); // the mix of everything persoed: for a forecast name not linked to a customer
  const out = new Map();
  for (const [tri, x] of by) { const tot = Object.values(x).reduce((a, b) => a + b, 0); if (tot) out.set(tri, Object.fromEntries(Object.entries(x).map(([t, q]) => [t, Math.round((q / tot) * 1000) / 1000]))); }
  return out;
}

// The CPM workbook's Config sheet: Customer, the split (DOD / EMB / LAS), the OEE (DOD / EMB / LAS), Trigram.
function parseConfig(buf) {
  const book = readBook(buf); const out = [];
  for (const info of book.sheets) {
    if (!/config/i.test(info.name)) continue;
    const sh = book.sheet(info.name); const v = (c, r) => sh.cells.get(`${colLetters(c)}${r}`)?.v;
    let cTri = null; for (let c = 1; c <= sh.maxCol; c++) if (/^trigram$/i.test(String(v(c, 1) ?? '').trim())) cTri = c;
    if (!cTri) continue;
    const techCols = []; for (let c = 2; c < cTri; c++) { const t = normTech(v(c, 2)); if (t) techCols.push([c, t]); }
    const half = techCols.length / 2; const splitCols = techCols.slice(0, half); const oeeCols = techCols.slice(half);
    for (let r = 3; r <= sh.maxRow; r++) {
      const name = String(v(1, r) ?? '').trim(); const tri = String(v(cTri, r) ?? '').trim().toUpperCase(); if (!name || !tri) continue;
      const split = {}; for (const [c, t] of splitCols) { const x = Number(v(c, r)); if (x) split[t] = x; }
      const oee = {}; for (const [c, t] of oeeCols) { const x = Number(v(c, r)); if (x) oee[t] = x; }
      out.push({ trigram: tri, name, split, oee });
    }
    if (out.length) return { sheet: info.name, customers: out };
  }
  throw new Error('No Config sheet with a Trigram column');
}

module.exports = { TECHS, CARD_FIELDS, cardValues, oeeFallback, forecastStatus, normTech, customers, nameMap, parseBenelux, parseAmex, refreshForecasts, remapForecasts, forecastOf, actuals, parseHistory, storeHistory, historyCoverage, flex, speeds, compute, learnedSplit, parseConfig, weekOf };
