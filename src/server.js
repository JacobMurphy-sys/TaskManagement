const path = require('path');
const express = require('express');
const config = require('./config');
const log = require('./logger');
// One app at a time on a database — before anything opens it.
const lock = require('./instancelock').acquire(config.dbFile, { port: config.port });
if (!lock.ok) {
  const by = lock.by || {};
  const msg = `The ${config.mode === 'planner' ? 'planner' : 'CI Manager'} database ${config.dbFile} is already in use`
    + `${by.user ? ` by ${by.user}` : ''}${by.host ? ` on ${by.host}` : ''}${by.started ? ` (since ${new Date(by.started).toLocaleString()})` : ''}.`
    + `${by.host && by.port ? ` Open http://${by.host}:${by.port} in a browser instead of starting another copy.` : ''}`
    + ` If that copy has really stopped, wait two minutes and try again (or delete ${lock.file}).`;
  log.error(msg);
  process.exit(3);
}
const db = require('./db');
const backup = require('./backup');
const api = require('./api');

try {
  db.migrate();
} catch (err) {
  log.error(`Could not open or set up the database file ${config.dbFile}`, err.message);
  process.exit(1);
}

const app = express();
// Vault imports send attachments in batches, and an A3 export sends chart pictures, so they get a larger limit.
const jsonSmall = express.json({ limit: '1mb' });
const jsonLarge = express.json({ limit: '80mb' });
app.use((req, res, next) => (req.path.startsWith('/api/library/import') || /^\/api\/kpi\/snapshots\/\d+\/export$/.test(req.path) ? jsonLarge : jsonSmall)(req, res, next));

// Lets the launcher check that the app is already up.
app.get('/api/health', (req, res) => res.json({ app: 'taskmanager', ok: true, mode: config.mode, lock: require('./instancelock').info() }));

app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  // Changes must carry this header. Browsers won't let other websites send it to
  // localhost without permission, so a random web page can't edit or stop the app.
  if (req.get('X-Requested-With') !== 'TaskManager') {
    return res.status(403).json({ error: 'Missing X-Requested-With: TaskManager header' });
  }
  // Log every change request with a timestamp (and who, when the browser says).
  let who = String(req.get('X-User-Name') || '');
  try { who = decodeURIComponent(who); } catch { /* as sent */ }
  who = who.slice(0, 60);
  res.on('finish', () => {
    log.info(`${req.method} ${req.originalUrl} -> ${res.statusCode}${who ? ` (${who})` : ''}`);
    // the last change to the planning setup, so others looking at it can be told
    if (res.statusCode < 400 && /^\/(plan|settings)(\/|$)/.test(req.path) && !/^\/plan\/upload/.test(req.path)) {
      lastChange = { at: new Date().toISOString(), by: who || req.ip, client: String(req.get('X-Client-Id') || '').slice(0, 60), what: `${req.method} ${req.path}` };
    }
  });
  next();
});

// 👥 Who has the app open (each browser says so every 20 s; gone after a minute), and the last
// change to the planning setup — so people sharing the planner don't overwrite each other unawares.
const presence = new Map();
let lastChange = null;
app.post('/api/presence', (req, res) => {
  const id = String(req.body?.id || '').slice(0, 60);
  const now = Date.now();
  for (const [k, v] of presence) if (now - v.at > 60000) presence.delete(k);
  if (id) presence.set(id, { name: String(req.body.name || '').slice(0, 60) || 'Someone', view: String(req.body.view || '').slice(0, 30), at: now, since: presence.get(id)?.since || now, ip: req.ip });
  res.json({ others: [...presence.entries()].filter(([k]) => k !== id).map(([, v]) => ({ name: v.name, view: v.view, since: new Date(v.since).toISOString() })), last_change: lastChange });
});

// Used by the "Stop server" button and stop-server.vbs (the app may have no console window).
app.post('/api/shutdown', (req, res, next) => {
  // on a server several people use, nobody can switch it off from a browser
  if (config.mode === 'planner' && config.host !== '127.0.0.1' && config.host !== 'localhost') return res.status(403).json({ error: 'The shared planner can only be stopped on the server itself' });
  next();
}, (req, res) => {
  log.info('Shutdown requested');
  res.json({ ok: true });
  setTimeout(() => server.close(() => process.exit(0)), 200).unref();
  setTimeout(() => process.exit(0), 3000).unref();
});

// The planner on its own answers only what Planning needs.
const PLANNER_API = /^\/(plan|settings|presence|audit|backups|info|health)(\/|$|\?)/;
if (config.mode === 'planner') app.use('/api', (req, res, next) => (PLANNER_API.test(req.path) ? next() : res.status(404).json({ error: 'Not part of the planner' })));
app.use('/api', api);
app.use(express.static(path.join(config.ROOT, 'public')));

const server = app.listen(config.port, config.host, () => {
  log.info(`${config.mode === 'planner' ? 'CI Planner' : 'CI Manager'} running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  log.info(`Database file: ${config.dbFile}`);
  const inside = (p) => !path.relative(config.ROOT, p).startsWith('..') && !path.isAbsolute(path.relative(config.ROOT, p));
  if (inside(config.dbFile) || inside(config.backup.dir)) {
    log.warn('Your database or backups are inside the app folder, where replacing or re-cloning the code could '
      + 'remove them. Remove DB_FILE / BACKUP_DIR / LOG_DIR from .env to use the default data folder.');
  }
});
server.on('error', (err) => {
  log.error(err.code === 'EADDRINUSE'
    ? `Port ${config.port} is already in use — is the CI Manager already running? (Or set PORT in .env.)`
    : err.message);
  process.exit(1);
});

backup.schedule();

process.on('unhandledRejection', (err) => log.error('Unhandled error', err && (err.stack || err.message)));
