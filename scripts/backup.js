// Takes a backup immediately. Usage: npm run backup
const backup = require('../src/backup');

try {
  const b = backup.runBackup('manual (CLI)');
  console.log('Backup written:', b);
  // wait for the compression (and its check) before exiting
  b.compressed?.then((r) => { if (r) console.log('Compressed:', r.map((x) => (x.ok ? x.file : `${x.file} (kept uncompressed: ${x.error})`)).join(', ')); });
} catch (err) {
  console.error('Backup failed:', err.message);
  process.exit(1);
}
