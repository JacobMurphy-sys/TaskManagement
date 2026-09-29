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

// Log every change request with a timestamp.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => log.info(`${req.method} ${req.originalUrl} -> ${res.statusCode}`));
  }
  next();
});
app.use('/api', api);
app.use(express.static(path.join(config.ROOT, 'public')));

const server = app.listen(config.port, config.host, () => {
  log.info(`Task Manager running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  log.info(`Database file: ${config.dbFile}`);
});
server.on('error', (err) => {
  log.error(err.code === 'EADDRINUSE'
    ? `Port ${config.port} is already in use — is the Task Manager already running? (Or set PORT in .env.)`
    : err.message);
  process.exit(1);
});

backup.schedule();

process.on('unhandledRejection', (err) => log.error('Unhandled error', err && (err.stack || err.message)));
