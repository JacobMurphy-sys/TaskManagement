// Restores ALL data from a backup (.db or .json), replacing what is in the database.
// A safety backup of the current data is taken first. (The Backups page in the app
// has a Restore button that does the same.)
// Usage: npm run restore -- backups/db/taskmgr-YYYYMMDD-HHMMSS.db
const readline = require('readline');
const db = require('../src/db');
const backup = require('../src/backup');
const { readBackup, restoreData } = require('../src/restore');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: npm run restore -- <backup file (.db or .json)>\n\nAvailable backups (newest first):');
    for (const b of backup.listBackups()) console.log(`  ${b.path}`);
    return;
  }
  const data = readBackup(file);
  console.log(`Backup from ${data.created}\n  ${Object.entries(data.counts).map(([t, n]) => `${t}: ${n}`).join(', ')}`);

  if (!process.argv.includes('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question('This REPLACES all current data. Type "restore" to continue: ', r));
    rl.close();
    if (answer.trim() !== 'restore') { console.log('Cancelled.'); return; }
  }

  db.migrate();
  const result = restoreData(data, 'restore script');
  console.log('Safety backup of current data:', result.safety);
  if (result.problems) console.warn(`Warning: ${result.problems} row(s) reference missing records.`);
  console.log('Restore complete.');
}

main().catch((err) => { console.error('Restore failed:', err.message); process.exit(1); });
