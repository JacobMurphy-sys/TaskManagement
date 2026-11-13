'use strict';
// 📈 Forecast: the customer forecasts (the BeNeLux and Amex workbooks) sent in, kept with who sent them and when.
// The newest of each kind, when it's newer than the file linked in Reporting › Sources, is what 📐 Capacity planning
// reads (api.js's cpmRefresh). Two ways in:
//  - the 📈 Forecast tab (the Forecast module): the list, uploading one, downloading any, and the link below;
//  - the upload link (/forecast-submit/<token>): no account, no sign-in, for the people who send forecasts. It can
//    only send a forecast and see what was sent before from that browser. One link for everyone; an admin (the
//    setup right) switches it on or off and makes a new one (the old one then stops working).

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const log = require('./logger');
const cpm = require('./cpm');

const KINDS = { benelux: 'BeNeLux forecast', amex: 'Amex forecast' };
const MAX_BYTES = 30 * 1024 * 1024;
const setting = (k) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value ?? null;
const put = (k, v) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v]);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const h = (fn) => (req, res) => { try { const out = fn(req, res); if (out && out.catch) out.catch((err) => res.status(err.status || 500).json({ error: err.message })); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };
const header = (req, name, max = 200) => { let v = String(req.get(name) || ''); try { v = decodeURIComponent(v); } catch { /* as sent */ } return v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max); };

// what Capacity planning does after a new forecast (api.js plugs it in)
let refresh = () => {};
const useRefresh = (fn) => { refresh = fn; };

// ---- storing one -------------------------------------------------------------------------------------
const LIST_COLS = 'id, kind, file_name, size, submitter, note, via, account_id, rows, summary, created_at';
const shape = (r) => ({ ...r, kind_label: KINDS[r.kind] || r.kind, summary: (() => { try { return JSON.parse(r.summary || '{}'); } catch { return {}; } })() });
// buf: the workbook. Refused (nothing kept) when it isn't one of the two forecasts.
function store(buf, { fileName, submitter, note = null, via, sender = null, accountId = null }) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('No file received');
  if (buf.length > MAX_BYTES) throw bad('That file is over 30 MB');
  const name = String(fileName || 'forecast.xlsx').split(/[\\/]/).pop().slice(0, 200) || 'forecast.xlsx';
  if (!/\.(xlsx|xlsm)$/i.test(name)) throw bad('Send the forecast as an Excel workbook (.xlsx or .xlsm)');
  if (!String(submitter || '').trim()) throw bad('Say who you are (your name)');
  let got; try { got = cpm.detectForecast(buf); } catch (err) { throw bad(err.message); }
  // verified for everything that reads it: the sheet the A3 reads it from (by name), as well as Capacity's rows
  const need = require('./kpidata').FORECASTS[got.kind].sheet;
  if (!got.sheets.some((n) => n.toLowerCase() === need.toLowerCase())) throw bad(`The ${KINDS[got.kind]} needs its "${need}" sheet (this file has: ${got.sheets.join(', ')}). Send the workbook as it comes, without renaming the sheet.`);
  // per month (YYYY-MM) the total
  const by = {}; for (const r of got.rows) { const k = `${r.year}-${String(r.month).padStart(2, '0')}`; by[k] = (by[k] || 0) + (Number(r.qty) || 0); }
  const now = new Date().toISOString();
  const r = db.run('INSERT INTO forecast_uploads (kind, file_name, size, data, submitter, note, via, sender, account_id, rows, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [got.kind, name, buf.length, buf, String(submitter).trim().slice(0, 80), note ? String(note).slice(0, 500) : null, via, sender, accountId, got.rows.length, JSON.stringify(by), now]);
  const row = shape(db.get(`SELECT ${LIST_COLS} FROM forecast_uploads WHERE id = ?`, [Number(r.lastInsertRowid)]));
  log.info(`📈 ${row.kind_label} received: ${name} from ${row.submitter} (${via}, ${got.rows.length} rows)`);
  try { refresh(); } catch (err) { log.warn('📈 Forecast: updating Capacity planning', err.message); }
  return row;
}
// the newest of a kind (api.js's currentForecast: what the A3, Capacity planning and the rest read), and its workbook
const latestInfo = (kind) => db.get('SELECT id, kind, file_name, submitter, created_at FROM forecast_uploads WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT 1', [kind]) || null;
const dataOf = (id) => { const r = db.get('SELECT data FROM forecast_uploads WHERE id = ?', [id]); return r ? Buffer.from(r.data) : null; };

// ---- the link ----------------------------------------------------------------------------------------
const linkToken = () => setting('fc_link_token');
const linkOn = () => !!linkToken() && setting('fc_link_on') === '1';
function linkOk(token) {
  const t = linkToken(); const s = String(token || '');
  return linkOn() && s.length === t.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(t));
}
const newToken = () => crypto.randomBytes(18).toString('base64url');
const linkInfo = (canEdit) => ({ on: linkOn(), path: linkToken() ? `/forecast-submit/${linkToken()}` : null, can_edit: canEdit });

// the browser sending through the link: a cookie of its own, so it sees what it sent before (and no one else's)
const SENDER = 'fc_sender';
function senderOf(req, res) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)fc_sender=([A-Za-z0-9_-]{20,64})/);
  let id = m?.[1];
  if (!id) { id = crypto.randomBytes(24).toString('base64url'); res.setHeader('Set-Cookie', `${SENDER}=${id}; Path=/api/fc-submit; HttpOnly; SameSite=Lax; Max-Age=${2 * 365 * 86400}`); }
  return crypto.createHash('sha256').update(id).digest('hex');
}
// a few uploads an hour from one address is plenty
const tries = new Map();
function slowDown(ip) {
  const now = Date.now(); const list = (tries.get(ip) || []).filter((t) => now - t < 3600000);
  if (list.length >= 20) throw bad('That\'s a lot of forecasts in an hour — wait a while and try again', 429);
  list.push(now); tries.set(ip, list);
  if (tries.size > 500) for (const [k, v] of tries) if (!v.some((t) => now - t < 3600000)) tries.delete(k);
}

// mounted at /api/fc-submit before the sign-in gate: the token is the only key
const publicRouter = express.Router();
const linkGone = () => bad('This forecast link isn\'t active (it may have been replaced). Ask for the current link.', 404);
publicRouter.get('/:token', h((req, res) => {
  if (!linkOk(req.params.token)) throw linkGone();
  const me = senderOf(req, res);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, kinds: KINDS, mine: db.all(`SELECT ${LIST_COLS} FROM forecast_uploads WHERE sender = ? ORDER BY created_at DESC LIMIT 50`, [me]).map(shape).map(({ account_id, ...x }) => x) });
}));
publicRouter.post('/:token', express.raw({ type: () => true, limit: MAX_BYTES }), h((req, res) => {
  if (!linkOk(req.params.token)) throw linkGone();
  slowDown(req.ip);
  const me = senderOf(req, res);
  const row = store(req.body, { fileName: header(req, 'X-File-Name'), submitter: header(req, 'X-Submitter', 80), note: header(req, 'X-Note', 500) || null, via: 'link', sender: me });
  const { account_id, ...out } = row;
  res.status(201).json(out);
}));

// ---- the 📈 Forecast tab (the Forecast module; accounts.js's MODULE_API) -------------------------------
const router = express.Router();
function needSetup(req) {
  const accounts = require('./accounts');
  if (accounts.enabled() && !accounts.hasRight(req, 'setup')) throw bad('Changing the link needs the “Change the setup” right — ask an admin', 403);
}
const canSetup = (req) => { const accounts = require('./accounts'); return !accounts.enabled() || accounts.hasRight(req, 'setup'); };
router.get('/forecasts', h((req, res) => {
  const list = db.all(`SELECT ${LIST_COLS} FROM forecast_uploads ORDER BY created_at DESC, id DESC LIMIT 300`).map(shape);
  const newest = {}; for (const k of Object.keys(KINDS)) newest[k] = list.find((x) => x.kind === k)?.id ?? null;
  res.json({ kinds: KINDS, link: linkInfo(canSetup(req)), uploads: list, newest, capacity: cpm.forecastStatus() });
}));
router.get('/forecasts/:id/file', h((req, res) => {
  const r = db.get('SELECT file_name, data FROM forecast_uploads WHERE id = ?', [Number(req.params.id)]);
  if (!r) throw bad('No such forecast', 404);
  res.set('Content-Type', /\.xlsm$/i.test(r.file_name) ? 'application/vnd.ms-excel.sheet.macroEnabled.12' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(r.file_name)}`);
  res.send(Buffer.from(r.data));
}));
router.post('/forecasts/upload', express.raw({ type: () => true, limit: MAX_BYTES }), h((req, res) => {
  const a = req.account;
  res.status(201).json(store(req.body, { fileName: header(req, 'X-File-Name'), submitter: a?.person || header(req, 'X-Submitter', 80) || 'SITHUB', note: header(req, 'X-Note', 500) || null, via: 'account', accountId: a?.id ?? null }));
}));
router.delete('/forecasts/:id', h((req, res) => {
  needSetup(req);
  const r = db.get('SELECT file_name, submitter FROM forecast_uploads WHERE id = ?', [Number(req.params.id)]);
  if (!r) throw bad('No such forecast', 404);
  db.run('DELETE FROM forecast_uploads WHERE id = ?', [Number(req.params.id)]);
  log.info(`📈 Forecast ${r.file_name} (from ${r.submitter}) removed by ${req.account?.username || 'this PC'}`);
  try { refresh(); } catch (err) { log.warn('📈 Forecast: updating Capacity planning', err.message); }
  res.status(204).end();
}));
// { on }: switch the link on (made the first time) or off
router.put('/forecasts/link', h((req, res) => {
  needSetup(req);
  if (req.body?.on && !linkToken()) put('fc_link_token', newToken());
  put('fc_link_on', req.body?.on ? '1' : '0');
  log.info(`📈 The forecast upload link switched ${req.body?.on ? 'on' : 'off'} by ${req.account?.username || 'this PC'}`);
  res.json(linkInfo(true));
}));
// a new link: the old one stops working
router.post('/forecasts/link/renew', h((req, res) => {
  needSetup(req);
  put('fc_link_token', newToken()); put('fc_link_on', '1');
  log.info(`📈 A new forecast upload link made by ${req.account?.username || 'this PC'} (the old one stops working)`);
  res.json(linkInfo(true));
}));

module.exports = { KINDS, store, latestInfo, dataOf, publicRouter, router, useRefresh, linkOk };
