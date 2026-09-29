// Creates the database (if missing) and applies the schema.
// Usage: npm run init-db
const { Client } = require('pg');
const config = require('../src/config');

(async () => {
  const admin = new Client({ ...config.db, database: 'postgres' });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.db.database]);
  if (!rowCount) {
    await admin.query(`CREATE DATABASE "${config.db.database.replace(/"/g, '""')}"`);
    console.log(`Created database "${config.db.database}".`);
  } else {
    console.log(`Database "${config.db.database}" already exists.`);
  }
  await admin.end();

  const db = require('../src/db');
  await db.migrate();
  await db.pool.end();
  console.log('Schema is up to date.');
})().catch((err) => {
  console.error('init-db failed:', err.message);
  process.exit(1);
});
