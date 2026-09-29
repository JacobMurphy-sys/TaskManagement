// Restores ALL data from a JSON backup, replacing what is in the database.
// A safety backup of the current data is taken first.
// Usage: npm run restore -- backups/json/taskmgr-YYYYMMDD-HHMMSS.json
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const db = require('../src/db');
const backup = require('../src/backup');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: npm run restore -- <backup.json>\n\nAvailable JSON backups:');
    for (const b of backup.listBackups().filter((x) => x.kind === 'json')) {
      console.log(`  ${path.join(backup.JSON_DIR, b.file)}`);
    }
    return db.pool.end();
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const counts = backup.TABLES.map((t) => `${t}: ${(data.tables[t] || []).length}`).join(', ');
  console.log(`Backup from ${data.created_at}\n  ${counts}`);

  if (!process.argv.includes('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question('This REPLACES all current data. Type "restore" to continue: ', r));
    rl.close();
    if (answer.trim() !== 'restore') { console.log('Cancelled.'); return db.pool.end(); }
  }

  await db.migrate();
  const safety = await backup.runBackup('pre-restore safety copy');
  console.log('Safety backup of current data:', safety.json);

  const triggerTables = ['projects', 'tasks', 'notes', 'reminders'];
  await db.tx(async (c) => {
    // User triggers are off during the restore so the original timestamps are kept
    // and the restore itself does not flood the audit log.
    for (const t of triggerTables) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    await c.query(`TRUNCATE ${backup.TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    for (const table of backup.TABLES) {
      for (const row of data.tables[table] || []) {
        // Subtask links are restored in a second pass so row order never matters.
        const r = table === 'tasks' ? { ...row, parent_id: null } : row;
        const cols = Object.keys(r);
        const values = cols.map((k) => (r[k] !== null && typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k]));
        await c.query(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, values);
      }
      await c.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), coalesce((SELECT max(id) FROM ${table}), 0) + 1, false)`);
    }
    for (const row of data.tables.tasks || []) {
      if (row.parent_id) await c.query('UPDATE tasks SET parent_id = $2 WHERE id = $1', [row.id, row.parent_id]);
    }
    for (const t of triggerTables) await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  });
  console.log('Restore complete.');
  await db.pool.end();
}

main().catch((err) => { console.error('Restore failed:', err.message); process.exit(1); });
