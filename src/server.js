const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const backup = require('./backup');
const log = require('./logger');
const api = require('./api');

async function main() {
  try {
    await db.migrate();
  } catch (err) {
    log.error(`Could not connect to / set up PostgreSQL database "${config.db.database}" on ` +
      `${config.db.host}:${config.db.port}. Check your .env settings.`, err.message);
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

  app.listen(config.port, config.host, () => {
    log.info(`Task Manager running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  });

  backup.schedule();
}

process.on('unhandledRejection', (err) => log.error('Unhandled error', err && (err.stack || err.message)));

main();
