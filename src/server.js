const path = require('path');
const zlib = require('zlib');
const express = require('express');
const config = require('./config');
const log = require('./logger');
// a frozen app is logged (what it was doing) and, after a few minutes, ended so its port is free
const dog = require('./watchdog').start();
// One app at a time on a database — before anything opens it.
const lock = require('./instancelock').acquire(config.dbFile, { port: config.port });
if (!lock.ok) {
  const by = lock.by || {};
  const msg = `The ${config.mode === 'planner' ? 'planner' : 'SITHUB'} database ${config.dbFile} is already in use`
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
app.use((req, res, next) => { dog.doing(`${req.method} ${req.originalUrl}`); next(); });
// Vault imports send attachments in batches, and an A3 export sends chart pictures, so they get a larger limit.
const jsonSmall = express.json({ limit: '1mb' });
const jsonLarge = express.json({ limit: '80mb' });
// Routes that read their own (larger) body — the planning setup + history, a plan sheet, the team
// pack — are left alone here: once a body is read, their own limit would never get a say.
const OWN_BODY = /^\/api\/(plan\/setup|plan\/sheet|team-pack|kpi\/history)$/;
app.use((req, res, next) => (OWN_BODY.test(req.path) ? next() : (req.path.startsWith('/api/library/import') || (req.path === '/api/tickets' && req.method === 'POST') || /^\/api\/kpi\/snapshots\/\d+\/export$/.test(req.path) ? jsonLarge : jsonSmall)(req, res, next)));

// Large answers (the planning list runs to megabytes) go compressed: a fraction of the data to
// move, which matters most for the shared planner over the network.
app.use('/api', (req, res, next) => {
  if (!/\bgzip\b/.test(req.get('Accept-Encoding') || '')) return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    const text = JSON.stringify(body);
    if (text === undefined || text.length < 64 * 1024) return json(body);
    res.set('Content-Encoding', 'gzip');
    res.set('Vary', 'Accept-Encoding');
    res.type('application/json');
    return res.send(zlib.gzipSync(text, { level: 4 }));
  };
  next();
});

// Lets the launcher check that the app is already up.
const collab = require('./collab');
// shared: one copy several people use over the network; local: this browser is on the server itself
app.get('/api/health', (req, res) => res.json({ app: 'taskmanager', ok: true, mode: config.mode, shared: config.shared, local: collab.isLocal(req), lock: require('./instancelock').info() }));

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
    if (res.statusCode < 400 && !req.account?.training && /^\/(plan|settings)(\/|$)/.test(req.path) && !/^\/plan\/upload/.test(req.path)) {
      lastChange = { at: new Date().toISOString(), by: who || req.ip, client: String(req.get('X-Client-Id') || '').slice(0, 60), what: `${req.method} ${req.path}` };
    }
  });
  next();
});
// 👤 accounts (off until the first is made): who's signed in, and the sign-in gate (accounts.js)
const accounts = require('./accounts');
app.use('/api', accounts.gate);
app.use('/api', accounts.router);
// 🎓 a training account works in the training copy (db.js): everything after this runs against it. What would
// change something outside the database (files on the share, the server, the Library) isn't done in training.
app.use('/api', (req, res, next) => (req.account?.training ? db.asTraining(next) : next()));
const NOT_IN_TRAINING = [
  [/^\/backups(\/|$)/, 'Backups'], [/^\/server(\/|$)/, 'The server controls'], [/^\/library\/(import|folder|excluded)/, 'Changing the Library'],
  [/^\/plan\/upload/, 'Uploading planning exports'], [/^\/plan\/auto\/[^/]+\/run$/, 'Running an automatic plan (it saves a file)'],
  [/^\/kpi\/(load|load-path|history)$/, 'Loading the workbook or importing weeks'], [/^\/charter-template/, 'Changing the charter template'],
  [/^\/tickets\/\d+$/, 'Removing a ticket', 'DELETE'], [/^\/settings\/shared\/apply$/, 'Applying shared paths'],
];
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || !db.inTraining()) return next();
  const hit = NOT_IN_TRAINING.find(([re, , method]) => re.test(req.path) && (!method || method === req.method));
  if (hit) return res.status(403).json({ error: `🎓 ${hit[1]} isn't done in training: it would change the real SITHUB` });
  // the A3 saved to its folder on the share: downloading it is fine
  if (/^\/kpi\/snapshots\/\d+\/export$/.test(req.path) && req.body?.save) return res.status(403).json({ error: '🎓 Saving the A3 to its folder isn\'t done in training: download it instead' });
  next();
});
// 🧩 modules: an account without one can't use its part of the API
app.use('/api', accounts.moduleGate);
// 🔒 changing the setup is for admins
app.use('/api', accounts.setupGate);
// who made each change, the feed of changes for open pages, and no silent overwrites (collab.js)
app.use('/api', collab.changes);
// 📅 every move of a due date or a meeting's time, logged with the record (reschedule.js)
app.use('/api', require('./reschedule').middleware);

// On the shared server some things are done on the server itself only: switching it off, showing
// a folder in File Explorer (it would open on the server, not on your PC: the path is copied
// instead) and restoring a backup (it replaces everyone's data).
app.use('/api', (req, res, next) => {
  if (!config.shared || collab.isLocal(req) || req.method === 'GET') return next();
  if (req.path === '/open-path') return res.json({ opened: false, remote: true });
  // restoring replaces everyone's data: on the server itself, or by an account with the Backups right
  if (/^\/backups\/(restore|[^/]+\/[^/]+\/restore)$/.test(req.path) && !(req.account && accounts.hasRight(req, 'backups'))) return res.status(403).json({ error: 'Restoring replaces everyone\'s data, so on the shared server it\'s done on the server itself, or by an account with the Backups right' });
  next();
});

// 👥 Who has the app open (each browser says so every 20 s; gone after a minute), and the last
// change to the planning setup — so people sharing the planner don't overwrite each other unawares.
let lastChange = null;
app.post('/api/presence', (req, res) => res.json({ ...collab.here(req.body, req), last_change: lastChange }));

// Used by the "Stop server" button and stop-server.vbs (the app may have no console window).
app.post('/api/shutdown', (req, res, next) => {
  // on a server several people use, nobody can switch it off from a browser
  if (config.shared && !collab.isLocal(req)) return res.status(403).json({ error: `The shared ${config.mode === 'planner' ? 'planner' : 'SITHUB'} can only be stopped on the server itself` });
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
// A request the app couldn't read (too large, or not valid JSON): a plain message, not an HTML page.
app.use((err, req, res, next) => {
  if (!err || res.headersSent || !(err.type === 'entity.too.large' || err.type === 'entity.parse.failed')) return next(err);
  const mb = (b) => `${Math.round(b / 1048576)} MB`;
  res.status(err.status || 400).json({ error: err.type === 'entity.too.large' ? `Too large to send (${mb(err.length || 0)}; the limit here is ${mb(err.limit || 0)})` : 'That wasn\'t valid JSON' });
});

const server = app.listen(config.port, config.host, () => {
  log.info(`${config.mode === 'planner' ? 'SITHUB Planner' : 'SITHUB'} running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  log.info(`Database file: ${config.dbFile}`);
  dog.doing('starting up: reading the shared files (team pack, planning setup, shared paths)');
  sharedAtStart().catch((err) => log.warn('Reading the shared files', err.message)).finally(() => dog.doing('waiting for requests'));
});
// the shared folder's files, once it answers (over a VPN it may not: then they're read the next time)
async function sharedAtStart() {
  const nf = require('./netfile');
  if (!(await nf.reach(config.sharedDir)) || (config.defaultsFile && !(await nf.reach(config.defaultsFile)))) return;
  if (config.mode !== 'planner') {
    const team = api.applySharedTeam();
    if (team?.error) log.warn(`Team pack: ${team.error}`);
    else if (team) log.info(`Team pack ${team.file}: added ${team.added.lists} lists, ${team.added.names} names (${team.added.filled} filled in), ${team.added.lookups} project list entries`);
  }
  const sharedSetup = api.applySharedSetup();
  if (sharedSetup?.error) log.warn(`Planning: shared setup file: ${sharedSetup.error}`);
  else if (sharedSetup) log.info(`Planning: shared setup ${sharedSetup.file}: ${sharedSetup.setup ? 'setup applied' : 'setup kept (this install has its own)'}${sharedSetup.history ? `, history added (${sharedSetup.history.reads} exports, ${sharedSetup.history.jobs} jobs, ${sharedSetup.history.prod_runs} production runs)` : ''}`);
  const shared = api.applySharedDefaults();
  if (shared?.error) log.warn(`Shared defaults ${shared.file}: ${shared.error}`);
  else if (shared) log.info(`Shared defaults ${shared.file}: ${shared.changed.length ? `filled in ${shared.changed.join(', ')}` : 'nothing new'}${shared.kept.length ? ` (kept your own ${shared.kept.join(', ')})` : ''}`);
  const inside = (p) => !path.relative(config.ROOT, p).startsWith('..') && !path.isAbsolute(path.relative(config.ROOT, p));
  if (inside(config.dbFile) || inside(config.backup.dir)) {
    log.warn('Your database or backups are inside the app folder, where replacing or re-cloning the code could '
      + 'remove them. Remove DB_FILE / BACKUP_DIR / LOG_DIR from .env to use the default data folder.');
  }
}
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') { log.error(err.message); process.exit(1); }
  // which it is: the app already running (fine), a copy that's frozen, or another program
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  const said = (msg) => { log.error(msg); process.exit(1); };
  const req = require('http').get({ host, port: config.port, path: '/api/health', timeout: 4000 }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; });
    res.on('end', () => said(body.includes('taskmanager')
      ? `Port ${config.port} is in use: SITHUB is already running — open http://localhost:${config.port} in your browser.`
      : `Port ${config.port} is in use by another program (not SITHUB). Close it, or set PORT=3001 (say) in the .env file in the app folder.`));
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => said(e.message === 'timeout'
    ? `Port ${config.port} is held by a copy of SITHUB (or another program) that isn't answering — probably frozen. `
      + 'Double-click stop-server.vbs in the app folder: it offers to end it. (Or Task Manager > Details > node.exe > End task.) Then start again.'
    : `Port ${config.port} is already in use — is SITHUB already running? (Or set PORT in .env.)`));
});

backup.schedule();

// Run by server-run.bat (the shared server): each night at UPDATE_HOUR (default 3) it checks for a
// newer version and, when nobody has the app open, stops with code 75 for server-run.bat to update
// it and start it again (it waits for an hour nobody is on, up to 6 in the morning, then tries
// the next night). AUTO_UPDATE=0 in .env turns it off (check-update.js says no).
if (process.env.CIM_SERVER === '1') {
  const hour = Number.isInteger(Number(process.env.UPDATE_HOUR)) ? Number(process.env.UPDATE_HOUR) : 3;
  setInterval(() => {
    const h = new Date().getHours();
    if (h < hour || h > Math.max(hour, 6) || collab.peopleHere()) return;
    require('child_process').execFile(process.execPath, [path.join(config.ROOT, 'scripts', 'check-update.js')], { timeout: 60000 }, (err) => {
      if (err?.code !== 10) return;
      log.info('A newer version is available and nobody is on: stopping to install it');
      server.close(() => process.exit(75));
      setTimeout(() => process.exit(75), 5000).unref();
    });
  }, 20 * 60 * 1000).unref();
}

process.on('unhandledRejection', (err) => log.error('Unhandled error', err && (err.stack || err.message)));
// Never stop without a word: an error nobody caught is written to the log. One from the computer or network (a file
// share gone, a connection dropped: a system error) is survivable, so the app carries on; anything else stops it,
// as it may be left in a bad state, and the log says why.
process.on('uncaughtException', (err) => {
  if (err && (err.syscall || typeof err.errno === 'number') && !/^ERR_/.test(String(err.code || ''))) { log.error(`An error from the network or a file (${err.code}), carrying on`, err.stack || err.message); return; }
  log.error('Stopping after an error nobody caught', err && (err.stack || err.message));
  process.exit(1);
});
process.on('exit', (code) => { try { log.info(`SITHUB stopped (exit code ${code})`); } catch { /* the log can't be written */ } });
