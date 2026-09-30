const path = require('path');
const express = require('express');
const config = require('./config');
const log = require('./logger');
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
app.use(express.json({ limit: '1mb' }));

// Lets the launcher check that the app is already up.
app.get('/api/health', (req, res) => res.json({ app: 'taskmanager', ok: true }));

app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  // Changes must carry this header. Browsers won't let other websites send it to
  // localhost without permission, so a random web page can't edit or stop the app.
  if (req.get('X-Requested-With') !== 'TaskManager') {
    return res.status(403).json({ error: 'Missing X-Requested-With: TaskManager header' });
  }
  // Log every change request with a timestamp.
  res.on('finish', () => log.info(`${req.method} ${req.originalUrl} -> ${res.statusCode}`));
  next();
});

// Used by the "Stop server" button and stop-server.vbs (the app may have no console window).
app.post('/api/shutdown', (req, res) => {
  log.info('Shutdown requested');
  res.json({ ok: true });
  setTimeout(() => server.close(() => process.exit(0)), 200).unref();
  setTimeout(() => process.exit(0), 3000).unref();
});

app.use('/api', api);
app.use(express.static(path.join(config.ROOT, 'public')));

const server = app.listen(config.port, config.host, () => {
  log.info(`Task Manager running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  log.info(`Database file: ${config.dbFile}`);
  const inside = (p) => !path.relative(config.ROOT, p).startsWith('..') && !path.isAbsolute(path.relative(config.ROOT, p));
  if (inside(config.dbFile) || inside(config.backup.dir)) {
    log.warn('Your database or backups are inside the app folder, where replacing or re-cloning the code could '
      + 'remove them. Remove DB_FILE / BACKUP_DIR / LOG_DIR from .env to use the default data folder.');
  }
});
server.on('error', (err) => {
  log.error(err.code === 'EADDRINUSE'
    ? `Port ${config.port} is already in use — is the Task Manager already running? (Or set PORT in .env.)`
    : err.message);
  process.exit(1);
});

backup.schedule();

process.on('unhandledRejection', (err) => log.error('Unhandled error', err && (err.stack || err.message)));
