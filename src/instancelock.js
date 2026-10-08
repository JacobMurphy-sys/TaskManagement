'use strict';
// One app at a time on a database: a lock file beside it says which computer, user and process
// has it open, refreshed every 20 seconds. A second copy started on the same database — e.g.
// two people running the planner from the same shared folder — stops with a message naming who
// has it, instead of both writing to one SQLite file (which can corrupt it). A lock not
// refreshed for 90 seconds (the app was killed, the computer went off) is taken over.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BEAT_MS = 20 * 1000;
const STALE_MS = 90 * 1000;
let held = null; // { file, me }

const lockFileOf = (dbFile) => `${dbFile}.lock`;
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

// Who holds the lock now (null when free or stale).
function holder(dbFile, now = Date.now()) {
  const l = read(lockFileOf(dbFile));
  if (!l || !l.beat) return null;
  if (now - new Date(l.beat).getTime() > STALE_MS) return null;
  // the same computer: a process that's gone doesn't hold it
  if (l.host === os.hostname() && l.pid !== process.pid && !alive(l.pid)) return null;
  return l;
}

// Takes the lock or returns { ok: false, by } naming who has the database open.
function acquire(dbFile, { port = null, url = null } = {}) {
  const file = lockFileOf(dbFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const other = holder(dbFile);
  if (other && !(other.host === os.hostname() && other.pid === process.pid)) return { ok: false, by: other, file };
  const me = { host: os.hostname(), user: os.userInfo().username, pid: process.pid, port, url, started: new Date().toISOString(), beat: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(me, null, 2));
  // two starting at once: whoever wrote last has it
  const check = read(file);
  if (!check || check.host !== me.host || check.pid !== me.pid) return { ok: false, by: check, file };
  held = { file, me };
  const timer = setInterval(() => {
    const now = read(file);
    if (now && (now.host !== me.host || now.pid !== me.pid)) return; // taken over (we were stale): leave it
    me.beat = new Date().toISOString();
    try { fs.writeFileSync(file, JSON.stringify(me, null, 2)); } catch { /* share briefly unreachable: try again */ }
  }, BEAT_MS);
  timer.unref();
  const release = () => { try { const now = read(file); if (now && now.host === me.host && now.pid === me.pid) fs.unlinkSync(file); } catch { /* already gone */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { release(); process.exit(0); });
  return { ok: true, file };
}

const info = () => (held ? { ...held.me } : null);
module.exports = { acquire, holder, info, lockFileOf, STALE_MS };
