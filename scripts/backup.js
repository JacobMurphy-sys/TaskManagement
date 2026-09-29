// Takes a backup immediately. Usage: npm run backup
const backup = require('../src/backup');

try {
  console.log('Backup written:', backup.runBackup('manual (CLI)'));
} catch (err) {
  console.error('Backup failed:', err.message);
  process.exit(1);
}
