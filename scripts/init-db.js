// Creates the database file (if missing) and applies the schema.
// Optional — the server does this itself at start-up. Usage: npm run init-db
const config = require('../src/config');
const db = require('../src/db');

db.migrate();
console.log(`Database ready: ${config.dbFile}`);
