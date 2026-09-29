// Restores ALL data from a backup (.db or .json), replacing what is in the database.
// A safety backup of the current data is taken first.
// Usage: npm run restore -- backups/db/taskmgr-YYYYMMDD-HHMMSS.db
const fs = require('fs');
const readline = require('readline');
const db = require('../src/db');
const backup = require('../src/backup');
const { dropTriggersSql, TABLE_NAMES } = require('../src/schema');

function readBackup(file) {
  if (file.endsWith('.json')) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { created: data.created_at, tables: data.tables };
  }
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(file, { readOnly: true });
  const tables = backup.exportTables(src);
  src.close();
  return { created: fs.statSync(file).mtime.toISOString(), tables };
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: npm run restore -- <backup file (.db or .json)>\n\nAvailable backups (newest first):');
    for (const b of backup.listBackups()) console.log(`  ${b.path}`);
    return;
  }
  const data = readBackup(file);
  console.log(`Backup from ${data.created}\n  ${TABLE_NAMES.map((t) => `${t}: ${(data.tables[t] || []).length}`).join(', ')}`);

  if (!process.argv.includes('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question('This REPLACES all current data. Type "restore" to continue: ', r));
    rl.close();
    if (answer.trim() !== 'restore') { console.log('Cancelled.'); return; }
  }

  db.migrate();
  const safety = backup.runBackup('pre-restore safety copy');
  console.log('Safety backup of current data:', safety.db);

  // Triggers are dropped during the load so original timestamps are kept and the
  // restore doesn't flood the audit log; migrate() puts them back afterwards.
  db.conn.exec('PRAGMA foreign_keys = OFF');
  try {
    db.tx(() => {
      db.conn.exec(dropTriggersSql());
      for (const table of TABLE_NAMES) db.run(`DELETE FROM ${table}`);
      db.run(`DELETE FROM sqlite_sequence WHERE name IN (${TABLE_NAMES.map(() => '?').join(', ')})`, TABLE_NAMES);
      for (const table of TABLE_NAMES) {
        for (const row of data.tables[table] || []) {
          const cols = Object.keys(row);
          db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            cols.map((c) => row[c]));
        }
      }
    });
  } finally {
    db.migrate();
    db.conn.exec('PRAGMA foreign_keys = ON');
  }
  const problems = db.all('PRAGMA foreign_key_check');
  if (problems.length) console.warn(`Warning: ${problems.length} row(s) reference missing records.`);
  console.log('Restore complete.');
}

main().catch((err) => { console.error('Restore failed:', err.message); process.exit(1); });
