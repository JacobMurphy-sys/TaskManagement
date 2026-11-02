'use strict';
// Is SITHUB's port free, in use by a working copy, or held by a copy that's frozen?
// Used by stop-server.vbs and start-hidden.vbs only when something is wrong (a stop that got no answer,
// a start that didn't come up). It finds the frozen copy from the app's own lock file (written next to
// the database with the process id) — no netstat, no PowerShell — and ends only that process.
//
//   node scripts/free-port.js          -> says what it found
//   node scripts/free-port.js --end    -> also ends a frozen SITHUB
//
// Exit codes: 0 the port is free · 1 SITHUB is running and answering · 10 a frozen SITHUB
// (process id on the output) · 11 another program has the port · 12 the frozen copy was ended ·
// 13 it couldn't be ended

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const config = require('../src/config');

const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
const port = config.port;
const say = (code, msg) => { console.log(msg); process.exit(code); };

// try the port: free when we can listen on it for a moment
const portFree = () => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, host, () => s.close(() => resolve(true)));
});
const answers = () => new Promise((resolve) => {
  const req = http.get({ host, port, path: '/api/health', timeout: 4000 }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve(body.includes('taskmanager') ? 'app' : 'other'));
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => resolve(null));
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (await portFree()) say(0, `Port ${port} is free: SITHUB isn't running.`);
  const who = await answers();
  if (who === 'app') say(1, `SITHUB is running on port ${port} and answering.`);
  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(`${config.dbFile}.lock`, 'utf8')); } catch { /* none */ }
  const ours = lock && lock.host === os.hostname() && Number(lock.pid) > 0 && Number(lock.port) === port && alive(Number(lock.pid));
  if (!ours) say(11, `Port ${port} is in use by another program (not SITHUB).`);
  const pid = Number(lock.pid);
  if (!process.argv.includes('--end')) say(10, String(pid));
  try { process.kill(pid, 'SIGKILL'); } catch (err) { say(13, `Couldn't end process ${pid}: ${err.message}`); }
  for (let i = 0; i < 20; i++) { await wait(250); if (!alive(pid) && await portFree()) say(12, `Ended the frozen SITHUB (process ${pid}). Port ${port} is free.`); }
  say(13, `Process ${pid} was asked to end but port ${port} is still in use.`);
})();
