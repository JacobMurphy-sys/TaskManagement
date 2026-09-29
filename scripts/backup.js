// Takes a backup immediately. Usage: npm run backup
const backup = require('../src/backup');
const db = require('../src/db');

backup.runBackup('manual (CLI)')
  .then((r) => { console.log('Backup written:', r); return db.pool.end(); })
  .catch((err) => { console.error('Backup failed:', err.message); process.exit(1); });
