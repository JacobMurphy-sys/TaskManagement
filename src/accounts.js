'use strict';
// 👤 Accounts for the shared SITHUB. Off until the first account is made: until then everyone
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
// Each module is one or more areas of the app (what pages and API paths check): Management, for one,
// is Projects and Reporting.
const MODULES = [
  { key: 'basic', label: 'Basic pack', icon: '📋', what: 'Home, Tasks, Calendar, Library, 📥 My work, quick notes and search', always: true, areas: [] },
  { key: 'management', label: 'Management', icon: '🗂', what: 'Projects (the board, project pages and charters, the projects list in the sidebar), 👥 People (each person\'s open work and next action) and 💶 CAPEX (planned investments)', areas: ['projects', 'team', 'capex'] },
  { key: 'ci', label: 'Continuous Improvement', icon: '💡', what: 'Ideas: the ideas, their notes and the pipeline', areas: ['ideas'] },
  { key: 'production', label: 'Prod Management', icon: '🏭', what: 'Production: perso, Matching, Insights (🔬 Learned, 📆 D+ due out, ⏱ Timing) and 🔍 search; 📐 Capacity planning (forecasts, flex, scenarios); 📊 Reporting\'s Weekly SC Report (the A3), its Database, 🏭 Operations and ▶ Prepare this week', areas: ['planning', 'cpm', 'kpi'] },
  { key: 'quality', label: 'Quality', icon: '🛡', what: '📊 Reporting\'s 🧪 Quality (customer complaints, from the Salesforce export) and ⛑ EHS (safety concern forms), month by month', areas: ['quality'] },
  { key: 'despatch', label: 'Despatch', icon: '🚚', what: '📊 Reporting\'s 🚚 OTD: logging late deliveries against the planner\'s work orders (internal or external, and why)', areas: ['otd'] },
  { key: 'archive', label: 'Archive', icon: '🗄', what: 'the archived status report', areas: ['report'] },
  { key: 'admin', label: 'Admin', icon: '📇', what: 'Contacts, to edit the lists (names can still be picked as owners without it), and 📊 Reporting\'s Sources: where every source file is (changing them takes the setup right)', areas: ['contacts', 'kpi_sources'] },
];
const MODULE_KEYS = MODULES.map((m) => m.key);
const AREAS = MODULES.flatMap((m) => m.areas);
// modules ticked before they were grouped
const LEGACY = { projects: 'management', kpi: 'production', ideas: 'ci', planning: 'production', report: 'archive', contacts: 'admin' };
const keysOf = (list) => new Set((Array.isArray(list) ? list : String(list || '').split(',')).map((k) => String(k).trim()).map((k) => LEGACY[k] || k));
// the API paths each area owns (refused to an account without it): the first rule that matches decides,
// and a rule open to several areas lets in an account with any of them
const MODULE_API = [
  [/^\/kpi\/(quality|ehs)(\/|$)/, ['quality']], // 🧪 Quality and ⛑ EHS
  [/^\/kpi\/otd-from$/, ['kpi_sources']], // where OTD is counted from: Sources
  [/^\/kpi\/otd(\/|$)/, ['otd']], // 🚚 OTD (Despatch)
  [/^\/kpi\/calc(\/import|\/weekends)?$/, ['kpi', 'kpi_sources']], // the source files: Database and Sources both show them
  [/^\/kpi(\/|$)/, ['kpi']], // the Weekly SC Report, its Database, Operations and Prepare
  [/^\/people\/(overview|focus)(\/|$)/, ['team']], [/^\/capex(\/|$)/, ['capex']], [/^\/(ideas|idea-notes)(\/|$)/, ['ideas']],
  [/^\/(plan|prod)(\/|$)/, ['planning']], [/^\/cpm(\/|$)/, ['cpm']], [/^\/report(\/|$)/, ['report']], [/^\/contacts(\/|$)/, ['contacts']],
];
function modulesOf(a) {
  // 🎓 a training account shows the department view picked for the session (none picked: everything)
  if (a?.training) return a.training_view === null || a.training_view === undefined ? [...MODULE_KEYS] : MODULE_KEYS.filter((k) => keysOf(a.training_view).has(k) || MODULES.find((m) => m.key === k).always);
  if (!a || a.role === 'admin' || a.owner || a.modules === null || a.modules === undefined) return [...MODULE_KEYS];
  const set = keysOf(a.modules);
  return MODULE_KEYS.filter((k) => set.has(k) || MODULES.find((m) => m.key === k).always);
}
const areasOf = (a) => { const mods = modulesOf(a); return MODULES.filter((m) => mods.includes(m.key)).flatMap((m) => m.areas); };
const cleanModules = (list) => { const set = keysOf(list); return MODULE_KEYS.filter((k) => set.has(k) || MODULES.find((m) => m.key === k).always).join(','); };
const moduleOfArea = (area) => MODULES.find((m) => m.areas.includes(area));
// with accounts on, can this request's account use the area (projects, kpi, ideas, planning, report, contacts)? (accounts off: everyone can)
const canUse = (req, area) => !req.account || areasOf(req.account).includes(area);
function moduleGate(req, res, next) {
  if (!req.account) return next();
  const rule = MODULE_API.find(([re]) => re.test(req.path));
  if (rule && !rule[1].some((area) => canUse(req, area))) {
    const m = moduleOfArea(rule[1][0]);
    return res.status(403).json({ error: `Your account doesn't include ${m.label} — ask an admin`, module: m.key });
  }
  return next();
}

// ---- admin rights ---------------------------------------------------------------------------------
// The host account (the owner: the first account made) has everything and is the one that hands out
// admin rights. An admin has all the rights; another account can be given some of them, so day-to-day
// fixing can be done from your own PC rather than on the server.
const RIGHTS = [
  { key: 'setup', label: 'Change the setup', icon: '⚙', what: 'Settings, Planning setup and modifiers, applying learned speeds, KPI sources, importing the library, the team pack' },
  { key: 'accounts', label: 'Manage accounts', icon: '👤', what: 'add, turn off and remove accounts, set new passwords and choose their modules (not the host\'s, and not admin rights)' },
  { key: 'backups', label: 'Backups', icon: '💾', what: 'make a backup and restore one — from any PC, not only on the server' },
  { key: 'server', label: 'Server', icon: '🖥', what: 'read the server\'s log and restart it (picking up an update) from any PC' },
  { key: 'tickets', label: 'Handle tickets', icon: '🎫', what: 'set the status of bug reports and feature requests, and answer them' },
  { key: 'poke', label: 'Poke people', icon: '👉', what: 'send anyone a ✉ nudge about a task given to them (project leaders and sponsors can always on their own projects)' },
];
const RIGHT_KEYS = RIGHTS.map((r) => r.key);
function rightsOf(a) {
  if (!a) return [];
  if (a.owner || a.role === 'admin') return [...RIGHT_KEYS];
  const set = new Set(String(a.rights || '').split(',').map((k) => k.trim()));
  return RIGHT_KEYS.filter((k) => set.has(k));
}
const cleanRights = (list) => { const set = new Set((Array.isArray(list) ? list : String(list || '').split(',')).map((k) => String(k).trim())); return RIGHT_KEYS.filter((k) => set.has(k)).join(',') || null; };
// with accounts on, does this request's account have the right? (accounts off: whoever is here does)
const hasRight = (req, key) => (req.account ? rightsOf(req.account).includes(key) : !enabled());
const isOwner = (req) => !!req.account?.owner || !enabled();
// an existing install: the longest-standing active admin is the host
let ownerChecked = false;
function ensureOwner() {
  if (ownerChecked) return; ownerChecked = true;
  if (db.get('SELECT 1 FROM accounts WHERE owner = 1')) return;
  const a = db.get("SELECT id FROM accounts WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1");
  if (a) db.run('UPDATE accounts SET owner = 1 WHERE id = ?', [a.id]);
}

// ---- setup is for admins ---------------------------------------------------------------------------
// With accounts on, changing how the app is set up — Settings, areas, project lists, the charter template,
// the team pack, Planning's machines/speeds/OEE/modifiers/setup, the KPI weekend split, importing or removing
// library notes, backups — is for admins. Using the app (tasks, the A3, loading and reading files, pins…) isn't.
const SETUP_API = [
  /^\/settings(\/|$)/, /^\/(areas|lookups|charter-template|team-pack)(\/|$)/,
  /^\/plan\/(machines|speeds|oee|otto\/speeds|otto\/machines|modifiers|mod-shifts|card-tags|setup|volume-rules|auto)(\/|$)/,
  /^\/kpi\/calc\/weekends$/, /^\/kpi\/history$/, /^\/kpi\/operations\/config$/, /^\/library(\/import|\/folder|\/excluded|\/docs\/\d+$|$)/,
];
// settings anyone may write: when the report was last sent
const OPEN_SETTINGS = new Set(['report_last_sent']);
function setupGate(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || !req.account) return next();
  if (/^\/backups(\/|$)/.test(req.path)) return hasRight(req, 'backups') ? next() : res.status(403).json({ error: 'Backups need the Backups right — ask the host', admin: true });
  if (hasRight(req, 'setup')) return next();
  if (!SETUP_API.some((re) => re.test(req.path))) return next();
  if (req.path === '/settings' && req.body && typeof req.body === 'object' && Object.keys(req.body).length && Object.keys(req.body).every((k) => OPEN_SETTINGS.has(k))) return next();
  return res.status(403).json({ error: 'Changing the setup needs the setup right — ask the host', admin: true });
}

// ---- accounts and sessions ---------------------------------------------------------------------
const enabled = () => !!db.get('SELECT 1 FROM accounts WHERE active = 1 LIMIT 1');
const publicAccount = (a) => (a ? { id: a.id, username: a.username, person: a.person, role: a.role, must_change: !!a.must_change, active: !!a.active, last_login: a.last_login, created_at: a.created_at,
  modules: modulesOf(a), areas: areasOf(a), modules_set: a.modules !== null && a.modules !== undefined, theme: a.theme || null, nav_order: navOrderOf(a), rights: rightsOf(a), owner: !!a.owner, training: !!a.training, training_view: a.training ? a.training_view ?? null : undefined, see_all: a.role === 'admin' && !!a.see_all } : null);
// the order of the top bar's pages, chosen by the person: ['dashboard', 'tasks', …] or null (the standard order)
function navOrderOf(a) { try { const o = JSON.parse(a.nav_order || 'null'); return Array.isArray(o) ? o : null; } catch { return null; } }
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
  ensureOwner();
  req.account = accountOf(req);
  if (req.account || OPEN.has(req.path)) return next();
  if (!enabled()) return next();
  // the launcher's Stop on the server itself, and making the first account (only when there's none)
  if (req.path === '/shutdown' && isLocal(req)) return next();
  return res.status(401).json({ error: 'Sign in to SITHUB', signin: true });
}
const needRight = (req, key) => { if (enabled() && !hasRight(req, key)) { const e = new Error(`That needs the “${RIGHTS.find((r) => r.key === key).label}” right — ask the host`); e.status = 403; throw e; } };

// ---- routes ------------------------------------------------------------------------------------
const router = express.Router();
const h = (fn) => (req, res) => { try { const out = fn(req, res); if (out && out.catch) out.catch((err) => res.status(err.status || 500).json({ error: err.message })); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

router.get('/auth/me', h((req, res) => res.json({ enabled: enabled(), account: publicAccount(req.account), modules: MODULES, areas: AREAS, rights: RIGHTS })));

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

// your own preferences, kept with your account so they follow you to any PC:
// { theme: auto | light | dark, nav_order: ['dashboard', 'tasks', …] | null (the standard order) }
router.patch('/auth/prefs', h((req, res) => {
  const a = req.account;
  if (!a) throw bad('Sign in first', 401);
  if ('theme' in (req.body || {})) {
    const t = ['auto', 'light', 'dark'].includes(req.body.theme) ? req.body.theme : null;
    db.run('UPDATE accounts SET theme = ? WHERE id = ?', [t, a.id]);
  }
  if ('nav_order' in (req.body || {})) {
    const o = req.body.nav_order;
    if (o !== null && (!Array.isArray(o) || o.length > 40 || o.some((k) => typeof k !== 'string' || !/^[a-z][a-z0-9_-]{0,30}$/.test(k)))) throw bad('The top bar order is a list of page names');
    db.run('UPDATE accounts SET nav_order = ? WHERE id = ?', [o ? JSON.stringify([...new Set(o)]) : null, a.id]);
  }
  res.json(publicAccount(db.get('SELECT * FROM accounts WHERE id = ?', [a.id])));
}));

router.get('/accounts', h((req, res) => { needRight(req, 'accounts'); res.json(db.all('SELECT * FROM accounts ORDER BY person COLLATE NOCASE').map(publicAccount)); }));
// { username, person, role, password } — the very first account is made by whoever's there, as an
// admin, and that browser is signed in with it
router.post('/accounts', h((req, res) => {
  const first = !enabled();
  if (!first) needRight(req, 'accounts');
  const username = String(req.body?.username || '').trim();
  const person = String(req.body?.person || '').trim();
  if (!/^[A-Za-z0-9._@-]{2,40}$/.test(username)) throw bad('A username is 2–40 letters, numbers or . _ @ -');
  if (!person) throw bad('Pick the person this account is for');
  if (db.get('SELECT 1 FROM accounts WHERE username = ?', [username])) throw bad(`There's already an account called ${username}`);
  const p = passwordProblem(req.body?.password); if (p) throw bad(p);
  // admin rights are the host's to give
  const role = first ? 'admin' : req.body?.role === 'admin' && isOwner(req) ? 'admin' : 'user';
  const modules = role === 'admin' || !('modules' in (req.body || {})) ? null : cleanModules(req.body.modules);
  const rights = role === 'user' && isOwner(req) && 'rights' in (req.body || {}) ? cleanRights(req.body.rights) : null;
  db.run('INSERT INTO accounts (username, person, role, password_hash, must_change, modules, rights, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [username, person, role, hashPassword(req.body.password), first ? 0 : 1, modules, rights, first ? 1 : 0]);
  const a = db.get('SELECT * FROM accounts WHERE username = ?', [username]);
  log.info(`Account ${username} (${person}, ${role}) made${req.account ? ` by ${req.account.username}` : ' — accounts are on'}`);
  if (first) startSession(res, a);
  res.status(201).json(publicAccount(a));
}));
// { person, role, active, password } — a new password must be changed at the next sign-in
router.patch('/accounts/:id', h((req, res) => {
  needRight(req, 'accounts');
  const a = db.get('SELECT * FROM accounts WHERE id = ?', [Number(req.params.id)]);
  if (!a) throw bad('No such account', 404);
  const self = req.account?.id === a.id;
  // the host's account is changed by the host only; admin rights are given by the host only
  if (a.owner && !self) throw bad('Only the host can change the host account', 403);
  if (('role' in req.body || 'rights' in req.body) && !isOwner(req)) throw bad('Only the host account can give or take admin rights', 403);
  if (a.owner && (('role' in req.body && req.body.role !== 'admin') || ('active' in req.body && !req.body.active))) throw bad('The host account stays an active admin');
  if (!a.owner && a.role === 'admin' && !isOwner(req) && ('password' in req.body || 'active' in req.body)) throw bad('Only the host can set an admin\'s password or turn them off', 403);
  const f = {};
  if ('person' in req.body) { f.person = String(req.body.person || '').trim(); if (!f.person) throw bad('Pick the person this account is for'); }
  if ('role' in req.body) f.role = req.body.role === 'admin' ? 'admin' : 'user';
  if ('active' in req.body) f.active = req.body.active ? 1 : 0;
  if ('modules' in req.body) f.modules = cleanModules(req.body.modules);
  if ('rights' in req.body) f.rights = cleanRights(req.body.rights);
  // 🎓 a training account (the host's call): works in the training copy only
  if ('training' in req.body) {
    if (!isOwner(req)) throw bad('Only the host account can make a training account', 403);
    if (a.owner) throw bad('The host account can\'t be a training account');
    f.training = req.body.training ? 1 : 0;
  }
  if ('password' in req.body) { const p = passwordProblem(req.body.password); if (p) throw bad(p); f.password_hash = hashPassword(req.body.password); f.must_change = 1; }
  const after = { ...a, ...f };
  if (after.training && after.role === 'admin') throw bad('A training account can\'t be an admin: give it the rights it should show instead');
  const admins = db.get("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND active = 1 AND id <> ?", [a.id]).n;
  if ((after.role !== 'admin' || !after.active) && a.role === 'admin' && a.active && !admins) throw bad('There has to be at least one active admin');
  const keys = Object.keys(f);
  if (keys.length) db.run(`UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map((k) => f[k]), nowIso(), a.id]);
  if (f.password_hash || f.active === 0 || 'training' in f) db.run('DELETE FROM sessions WHERE account_id = ?', [a.id]); // signed out: in (or out of) training from the next sign-in
  log.info(`Account ${a.username} changed by ${req.account?.username || '?'}: ${keys.map((k) => (k === 'password_hash' ? 'new password' : k)).join(', ')}`);
  res.json(publicAccount(db.get('SELECT * FROM accounts WHERE id = ?', [a.id])));
}));
router.delete('/accounts/:id', h((req, res) => {
  needRight(req, 'accounts');
  const a = db.get('SELECT * FROM accounts WHERE id = ?', [Number(req.params.id)]);
  if (!a) throw bad('No such account', 404);
  if (a.owner) throw bad('The host account can\'t be removed');
  if (a.role === 'admin' && !isOwner(req)) throw bad('Only the host can remove an admin', 403);
  if (a.role === 'admin' && !db.get("SELECT 1 FROM accounts WHERE role = 'admin' AND active = 1 AND id <> ?", [a.id])) throw bad('There has to be at least one active admin');
  db.run('DELETE FROM accounts WHERE id = ?', [a.id]);
  log.info(`Account ${a.username} removed by ${req.account?.username || '?'}`);
  res.status(204).end();
}));

// ---- 🎓 training: a copy of live a training account works in, shown as a department sees it --------------
// The view (which modules) is switched by the training account itself; the copy is made again from live by it
// or by anyone with the Accounts right. These run on live (before db.asTraining), and write to it.
const trainingNeed = (req) => { if (!req.account?.training && !hasRight(req, 'accounts')) throw bad('That\'s for the training account', 403); };
router.get('/training', h((req, res) => {
  trainingNeed(req);
  if (req.account?.training) db.ensureTraining(); // the training account: its copy, made the first time
  res.json({ ...db.trainingInfo(), accounts: db.all('SELECT id, username, person FROM accounts WHERE training = 1 AND active = 1 ORDER BY username'),
    views: [{ key: '', label: 'Everything', modules: null }, ...MODULES.filter((m) => !m.always).map((m) => ({ key: m.key, label: `${m.icon} ${m.label}`, modules: [m.key] }))] });
}));
router.put('/training/view', h((req, res) => {
  if (!req.account?.training) throw bad('Only a training account switches its view', 403);
  const v = req.body?.modules === null || req.body?.modules === undefined ? null : cleanModules(req.body.modules);
  db.asLive(() => db.run('UPDATE accounts SET training_view = ? WHERE id = ?', [v, req.account.id]));
  res.json({ training_view: v, modules: modulesOf({ ...req.account, training_view: v }) });
}));
router.post('/training/reset', h((req, res) => {
  trainingNeed(req);
  db.asLive(() => db.resetTraining());
  log.info(`Training copy made again from live by ${req.account?.username || '?'}`);
  res.json(db.asLive(() => db.trainingInfo()));
}));

// ---- 🖥 the server, from any PC (the Server right) ------------------------------------------------
// its log (today's, the last lines), and a restart: under server-run.bat, stopping with code 75 makes
// it check for an update, install it if there is one, and start again
// with accounts on: the Server right; with them off: only on the server itself
const needServer = (req) => { if (enabled()) needRight(req, 'server'); else if (!isLocal(req)) throw bad('Only on the server itself — or turn accounts on and give someone the Server right', 403); };
router.get('/server/log', h((req, res) => {
  needServer(req);
  const config = require('./config'); const fs = require('fs'); const path = require('path');
  const files = fs.existsSync(config.logDir) ? fs.readdirSync(config.logDir).filter((f) => /^app-.*\.log$/.test(f)).sort() : [];
  const file = files[files.length - 1];
  const lines = file ? fs.readFileSync(path.join(config.logDir, file), 'utf8').split('\n').filter(Boolean) : [];
  res.json({ file: file || null, lines: lines.slice(-Math.min(2000, Math.max(50, Number(req.query.lines) || 400))), runner: process.env.CIM_SERVER === '1' });
}));
router.post('/server/restart', h((req, res) => {
  needServer(req);
  if (process.env.CIM_SERVER !== '1') throw bad('This SITHUB wasn\'t started as the server (by server-run.bat), so it can\'t restart itself. On the server PC: ⋯ › Stop server, then start it again with the SITHUB shortcut (or server-start.vbs)');
  log.info(`Restart asked for by ${req.account?.username || req.ip}`);
  res.json({ ok: true });
  setTimeout(() => process.exit(75), 300).unref();
}));

// ---- 🔑 the server PC's Windows password -----------------------------------------------------------
// The shared server runs as a Windows account (the "SITHUB server" scheduled task keeps its password).
// If that password expires or is changed, the task can't start SITHUB after the next restart and the
// network folders can stop answering. So every few weeks (server_pw_weeks, default 8, 0 = off) everyone
// with the Server right gets a ✉ reminder to check it, again each week until someone ticks it off.
const DAY = 86400000;
const kv = (k) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value ?? null;
const setKv = (k, v) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v == null ? null : String(v)]);
const windowsAccount = () => (process.env.USERNAME ? `${process.env.USERDOMAIN && process.env.USERDOMAIN !== process.env.COMPUTERNAME ? `${process.env.USERDOMAIN}\\` : ''}${process.env.USERNAME}` : null);
function pwState(now = new Date()) {
  const w = kv('server_pw_weeks');
  const weeks = w == null || w === '' ? 8 : Math.max(0, Math.round(Number(w) || 0));
  let checked = kv('server_pw_checked_at');
  if (!checked) { checked = now.toISOString(); setKv('server_pw_checked_at', checked); } // the clock starts when it's first looked at
  const due = weeks ? new Date(new Date(checked).getTime() + weeks * 7 * DAY) : null;
  return { weeks, checked_at: checked, checked_by: kv('server_pw_checked_by'), due_at: due ? due.toISOString() : null,
    due: !!due && now >= due, reminded_at: kv('server_pw_reminded_at'), account: windowsAccount(), computer: process.env.COMPUTERNAME || null };
}
// the people (names) of the active accounts with a right: admins and the host have them all; none with accounts off
const peopleWithRight = (right) => {
  if (!enabled()) return [];
  const seen = new Map();
  for (const a of db.all('SELECT * FROM accounts WHERE active = 1')) if (rightsOf(a).includes(right) && a.person?.trim()) seen.set(a.person.trim().toLowerCase(), a.person.trim());
  return [...seen.values()];
};
// everyone who looks after the server: active accounts with the Server right
const serverPeople = () => peopleWithRight('server');
// sends the reminder when it's due (and a week has passed since the last one); returns how many went out
function pwRemind(now = new Date()) {
  if (!enabled()) return 0;
  const s = pwState(now);
  if (!s.due || (s.reminded_at && now - new Date(s.reminded_at) < 7 * DAY)) return 0;
  const people = serverPeople(); if (!people.length) return 0;
  const acct = s.account ? `the Windows account ${s.account}` : 'a Windows account';
  const body = `SITHUB runs on the server PC${s.computer ? ` (${s.computer})` : ''} under ${acct}, and the "SITHUB server" scheduled task keeps its password. `
    + 'If that password expires or is changed, SITHUB won\'t start after the next restart, and reading the network folders can stop. '
    + 'Check when it expires; after a change, give the task the new password (Task Scheduler › SITHUB server › Properties › OK, or run server-install.bat again). '
    + 'Then tick it off in ⚙ Settings › 🖥 Server.';
  db.tx(() => {
    db.run("DELETE FROM messages WHERE topic = 'server-password'"); // one at a time: the latest
    for (const p of people) db.run('INSERT INTO messages (to_person, kind, title, body, topic, link) VALUES (?, ?, ?, ?, ?, ?)',
      [p, 'message', '🔑 Time to check the server PC\'s password', body, 'server-password', '#/settings/accounts']);
    setKv('server_pw_reminded_at', now.toISOString());
  });
  log.info(`Server password reminder sent to ${people.join(', ')}`);
  return people.length;
}
const pwRemindSafe = () => { try { pwRemind(); } catch (err) { log.warn('Server password reminder: ' + err.message); } };
setTimeout(pwRemindSafe, 60 * 1000).unref();
setInterval(pwRemindSafe, 6 * 60 * 60 * 1000).unref();

router.get('/server/password', h((req, res) => {
  needServer(req);
  pwRemind();
  res.json({ ...pwState(), people: serverPeople() });
}));
// { checked: true } it's been checked (now, by you): the reminders go; { weeks } how often (0: never)
router.post('/server/password', h((req, res) => {
  needServer(req);
  const b = req.body || {};
  if (b.weeks !== undefined) {
    const w = Number(b.weeks);
    if (!Number.isInteger(w) || w < 0 || w > 52) throw bad('Every 1 to 52 weeks (0: no reminders)');
    setKv('server_pw_weeks', w);
  }
  if (b.checked) {
    const by = req.account?.person || null;
    db.tx(() => {
      setKv('server_pw_checked_at', nowIso()); setKv('server_pw_checked_by', by); setKv('server_pw_reminded_at', null);
      db.run("DELETE FROM messages WHERE topic = 'server-password'");
    });
    log.info(`Server password checked (${by || req.ip})`);
  }
  res.json({ ...pwState(), people: serverPeople() });
}));

module.exports = { gate, router, moduleGate, setupGate, hasRight, rightsOf, peopleWithRight, RIGHTS, canUse, modulesOf, MODULES, hashPassword, checkPassword, enabled, accountOf, publicAccount };
