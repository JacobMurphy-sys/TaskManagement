const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const config = require('./config');

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of local-midnight Date objects.
types.setTypeParser(1082, (v) => v);

const pool = new Pool(config.db);

async function query(text, params) {
  return pool.query(text, params);
}

// Runs fn(client) inside a transaction.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(config.ROOT, 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, query, tx, migrate };
