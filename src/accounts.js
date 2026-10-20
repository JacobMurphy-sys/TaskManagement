'use strict';
// 👤 Accounts for the shared CI Manager. Off until the first account is made: until then everyone
// who can reach the app uses it as before. Once there's one, every browser signs in.
// - Each account is linked to a person (a name in the contacts lists), the name used as task owner,
//   project leader, sponsor or team member: their work is gathered for them (📥 My work, in api.js).
// - Passwords are kept as scrypt hashes; a sign-in is a random token in an HttpOnly cookie, kept here
//   as its SHA-256, valid for 30 days from last use.
// - Admins manage the accounts. A forgotten admin password: scripts/reset-password.js on the server.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const log = require('./logger');

const COOKIE = 'cim_session';
const DAYS = 30;
const nowIso = () => new Date().toISOString();

// ---- passwords ---------------------------------------------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [kind, n, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: Number(n) || 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
const passwordProblem = (pw) => (String(pw || '').length < 8 ? 'Passwords need at least 8 characters' : null);

// ---- modules: what each account can see and use ------------------------------------------------
// The basic pack is always there; the rest an admin ticks for each account (admins have them all).
// An account with none set (made before modules) has them all. Kept as a comma list in accounts.modules.
const MODULES = [
  { key: 'basic', label: 'Basic pack', icon: '📋', what: 'Dashboard, Tasks, Calendar, Library, 📥 My work, quick notes and search', always: true },
  { key: 'projects', label: 'Projects', icon: '🗂', what: 'the projects board, project pages and charters, and the projects list in the sidebar' },
  { key: 'ideas', label: 'Ideas', icon: '💡', what: 'Ideation: the ideas, their notes and the pipeline' },
  { key: 'kpi', label: 'KPIs', icon: '📊', what: 'the weekly A3, KPI database and sources, and ⏱ production timing' },
  { key: 'planning', label: 'Planning', icon: '🏭', what: 'production planning: the open work orders, plan, history, 🧠 Learned and 🔍 search' },
  { key: 'report', label: 'Report', icon: '📰', what: 'the report page' },
  { key: 'contacts', label: 'Contacts', icon: '📇', what: 'the Contacts page, to edit the lists (names can still be picked as owners without it)' },
];
const MODULE_KEYS = MODULES.map((m) => m.key);
// the API paths each module owns (refused to an account without it)
const MODULE_API = { ideas: /^\/(ideas|idea-notes)(\/|$)/, kpi: /^\/(kpi|prod)(\/|$)/, planning: /^\/plan(\/|$)/, report: /^\/report(\/|$)/, contacts: /^\/contacts(\/|$)/ };
function modulesOf(a) {
  if (!a || a.role === 'admin' || a.modules === null || a.modules === undefined) return [...MODULE_KEYS];
  const set = new Set(String(a.modules).split(',').map((k) => k.trim()).filter((k) => MODULE_KEYS.includes(k)));
  return MODULE_KEYS.filter((k) => set.has(k) || MODULES.find((m) => m.key === k).always);
}
const cleanModules = (list) => { const set = new Set((Array.isArray(list) ? list : String(list || '').split(',')).map((k) => String(k).trim())); return MODULE_KEYS.filter((k) => set.has(k) || MODULES.find((m) => m.key === k).always).join(','); };
// with accounts on, can this request's account use the module? (accounts off: everyone can)
const canUse = (req, key) => !req.account || modulesOf(req.account).includes(key);
function moduleGate(req, res, next) {
  if (!req.account) return next();
  for (const [key, re] of Object.entries(MODULE_API)) {
    if (re.test(req.path) && !canUse(req, key)) return res.status(403).json({ error: `Your account doesn't include ${MODULES.find((m) => m.key === key).label} — ask an admin`, module: key });
  }
  return next();
}

// ---- accounts and sessions ---------------------------------------------------------------------
const enabled = () => !!db.get('SELECT 1 FROM accounts WHERE active = 1 LIMIT 1');
const publicAccount = (a) => (a ? { id: a.id, username: a.username, person: a.person, role: a.role, must_change: !!a.must_change, active: !!a.active, last_login: a.last_login, created_at: a.created_at,
  modules: modulesOf(a), modules_set: a.modules !== null && a.modules !== undefined } : null);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
function cookieToken(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
}
function accountOf(req) {
  const t = cookieToken(req);
  if (!t) return null;
  const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', [sha(t)]);
  if (!s) return null;
  if (s.expires_at < nowIso()) { db.run('DELETE FROM sessions WHERE id = ?', [s.id]); return null; }
  const a = db.get('SELECT * FROM accounts WHERE id = ? AND active = 1', [s.account_id]);
  if (!a) return null;
  // used: valid for another 30 days (written at most every 10 minutes)
  if (Date.now() - new Date(s.last_seen).getTime() > 10 * 60000) db.run('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?', [nowIso(), new Date(Date.now() + DAYS * 86400000).toISOString(), s.id]);
  return a;
}
function startSession(res, account) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.run('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)', [sha(token), account.id, new Date(Date.now() + DAYS * 86400000).toISOString()]);
  db.run('UPDATE accounts SET last_login = ? WHERE id = ?', [nowIso(), account.id]);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}`);
}

// ---- the gate: with accounts on, the API needs a signed-in browser -------------------------------
const OPEN = new Set(['/health', '/auth/me', '/auth/login']);
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
function gate(req, res, next) {
  req.account = accountOf(req);
  if (req.account || OPEN.has(req.path)) return next();
  if (!enabled()) return next();
  // the launcher's Stop on the server itself, and making the first account (only when there's none)
  if (req.path === '/shutdown' && isLocal(req)) return next();
  return res.status(401).json({ error: 'Sign in to the CI Manager', signin: true });
}
const needAdmin = (req) => { if (enabled() && req.account?.role !== 'admin') { const e = new Error('Only an admin can do this'); e.status = 403; throw e; } };

// ---- routes ------------------------------------------------------------------------------------
const router = express.Router();
const h = (fn) => (req, res) => { try { const out = fn(req, res); if (out && out.catch) out.catch((err) => res.status(err.status || 500).json({ error: err.message })); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

router.get('/auth/me', h((req, res) => res.json({ enabled: enabled(), account: publicAccount(req.account), modules: MODULES })));

// a few wrong passwords in a row from one address wait a minute
const attempts = new Map();
router.post('/auth/login', h((req, res) => {
  const ip = req.ip; const now = Date.now();
  const a0 = attempts.get(ip) || { n: 0, at: now };
  if (now - a0.at > 60000) { a0.n = 0; a0.at = now; }
  if (a0.n >= 8) throw bad('Too many tries — wait a minute and try again', 429);
  const a = db.get('SELECT * FROM accounts WHERE username = ? AND active = 1', [String(req.body?.username || '').trim()]);
  if (!a || !checkPassword(req.body?.password || '', a.password_hash)) {
    a0.n++; attempts.set(ip, a0);
    log.warn(`Sign-in failed for "${String(req.body?.username || '').slice(0, 60)}" from ${ip}`);
    throw bad('Wrong username or password', 401);
  }
  attempts.delete(ip);
  startSession(res, a);
  log.info(`${a.username} (${a.person}) signed in from ${ip}`);
  res.json({ account: publicAccount(a) });
}));
router.post('/auth/logout', h((req, res) => {
  const t = cookieToken(req);
  if (t) db.run('DELETE FROM sessions WHERE token_hash = ?', [sha(t)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}));
// your own password: { current, next }
router.post('/auth/password', h((req, res) => {
  const a = req.account;
  if (!a) throw bad('Sign in first', 401);
  if (!checkPassword(req.body?.current || '', a.password_hash)) throw bad('Your current password isn\'t right');
  const p = passwordProblem(req.body?.next); if (p) throw bad(p);
  db.run('UPDATE accounts SET password_hash = ?, must_change = 0, updated_at = ? WHERE id = ?', [hashPassword(req.body.next), nowIso(), a.id]);
  // signed out everywhere else
  const t = cookieToken(req);
  db.run('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?', [a.id, t ? sha(t) : '']);
  log.info(`${a.username} changed their password`);
  res.json({ ok: true });
}));

router.get('/accounts', h((req, res) => { needAdmin(req); res.json(db.all('SELECT * FROM accounts ORDER BY person COLLATE NOCASE').map(publicAccount)); }));
// { username, person, role, password } — the very first account is made by whoever's there, as an
// admin, and that browser is signed in with it
router.post('/accounts', h((req, res) => {
  const first = !enabled();
  if (!first) needAdmin(req);
  const username = String(req.body?.username || '').trim();
  const person = String(req.body?.person || '').trim();
  if (!/^[A-Za-z0-9._@-]{2,40}$/.test(username)) throw bad('A username is 2–40 letters, numbers or . _ @ -');
  if (!person) throw bad('Pick the person this account is for');
  if (db.get('SELECT 1 FROM accounts WHERE username = ?', [username])) throw bad(`There's already an account called ${username}`);
  const p = passwordProblem(req.body?.password); if (p) throw bad(p);
  const role = first ? 'admin' : req.body?.role === 'admin' ? 'admin' : 'user';
  const modules = role === 'admin' || !('modules' in (req.body || {})) ? null : cleanModules(req.body.modules);
  db.run('INSERT INTO accounts (username, person, role, password_hash, must_change, modules) VALUES (?, ?, ?, ?, ?, ?)', [username, person, role, hashPassword(req.body.password), first ? 0 : 1, modules]);
  const a = db.get('SELECT * FROM accounts WHERE username = ?', [username]);
  log.info(`Account ${username} (${person}, ${role}) made${req.account ? ` by ${req.account.username}` : ' — accounts are on'}`);
  if (first) startSession(res, a);
  res.status(201).json(publicAccount(a));
}));
// { person, role, active, password } — a new password must be changed at the next sign-in
router.patch('/accounts/:id', h((req, res) => {
  needAdmin(req);
  const a = db.get('SELECT * FROM accounts WHERE id = ?', [Number(req.params.id)]);
  if (!a) throw bad('No such account', 404);
  const f = {};
  if ('person' in req.body) { f.person = String(req.body.person || '').trim(); if (!f.person) throw bad('Pick the person this account is for'); }
  if ('role' in req.body) f.role = req.body.role === 'admin' ? 'admin' : 'user';
  if ('active' in req.body) f.active = req.body.active ? 1 : 0;
  if ('modules' in req.body) f.modules = cleanModules(req.body.modules);
  if ('password' in req.body) { const p = passwordProblem(req.body.password); if (p) throw bad(p); f.password_hash = hashPassword(req.body.password); f.must_change = 1; }
  const after = { ...a, ...f };
  const admins = db.get("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND active = 1 AND id <> ?", [a.id]).n;
  if ((after.role !== 'admin' || !after.active) && a.role === 'admin' && a.active && !admins) throw bad('There has to be at least one active admin');
  const keys = Object.keys(f);
  if (keys.length) db.run(`UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map((k) => f[k]), nowIso(), a.id]);
  if (f.password_hash || f.active === 0) db.run('DELETE FROM sessions WHERE account_id = ?', [a.id]);
  log.info(`Account ${a.username} changed by ${req.account?.username || '?'}: ${keys.map((k) => (k === 'password_hash' ? 'new password' : k)).join(', ')}`);
  res.json(publicAccount(db.get('SELECT * FROM accounts WHERE id = ?', [a.id])));
}));
router.delete('/accounts/:id', h((req, res) => {
  needAdmin(req);
  const a = db.get('SELECT * FROM accounts WHERE id = ?', [Number(req.params.id)]);
  if (!a) throw bad('No such account', 404);
  if (a.role === 'admin' && !db.get("SELECT 1 FROM accounts WHERE role = 'admin' AND active = 1 AND id <> ?", [a.id])) throw bad('There has to be at least one active admin');
  db.run('DELETE FROM accounts WHERE id = ?', [a.id]);
  log.info(`Account ${a.username} removed by ${req.account?.username || '?'}`);
  res.status(204).end();
}));

module.exports = { gate, router, moduleGate, canUse, modulesOf, MODULES, hashPassword, checkPassword, enabled, accountOf, publicAccount };
