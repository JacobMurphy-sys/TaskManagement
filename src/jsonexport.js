'use strict';
// The JSON export of a backup: every table, written table by table and row by row (one string of the
// whole database would outgrow what Node can hold once it's a few hundred MB). Run in a worker thread
// from the database snapshot just taken (src/backup.js), so a large export never holds the app up and
// matches the .db backup exactly. Written to <file>.part and renamed when complete.
const fs = require('fs');
const { TABLE_NAMES } = require('./schema');

function writeJson(file, conn) {
  const part = `${file}.part`;
  const fd = fs.openSync(part, 'w');
  try {
    fs.writeSync(fd, `{"created_at":${JSON.stringify(new Date().toISOString())},"format":2,"tables":{`);
    const have = new Set(conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    TABLE_NAMES.forEach((t, i) => {
      fs.writeSync(fd, `${i ? ',' : ''}\n${JSON.stringify(t)}:[`);
      let buf = ''; let first = true;
      if (have.has(t)) {
        for (const r of conn.prepare(`SELECT * FROM ${t} ORDER BY id`).iterate()) {
          buf += `${first ? '\n' : ',\n'}${JSON.stringify({ ...r })}`; first = false;
          if (buf.length > 1 << 20) { fs.writeSync(fd, buf); buf = ''; }
        }
      }
      fs.writeSync(fd, `${buf}]`);
    });
    fs.writeSync(fd, '\n}}\n');
  } finally { fs.closeSync(fd); }
  fs.renameSync(part, file);
}

// in a worker: { db: the snapshot to read, json: the file to write }
const { isMainThread, parentPort, workerData } = require('worker_threads');
if (!isMainThread && workerData?.db && workerData?.json) {
  const { DatabaseSync } = require('node:sqlite');
  let conn;
  try {
    conn = new DatabaseSync(workerData.db, { readOnly: true });
    writeJson(workerData.json, conn);
    parentPort.postMessage({ ok: true });
  } catch (err) {
    try { fs.rmSync(`${workerData.json}.part`, { force: true }); } catch { /* fine */ }
    parentPort.postMessage({ ok: false, error: err.message });
  } finally { conn?.close(); }
}

module.exports = { writeJson };
