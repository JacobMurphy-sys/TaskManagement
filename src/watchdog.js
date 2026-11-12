'use strict';
// 🐕 A frozen app holds its port without answering: the browser waits, stop-server.vbs gets no
// answer, and a new start fails with "port already in use". This watches from a separate thread.
// When the app hasn't ticked for STUCK_S seconds it writes to the log what it was doing (the
// request it was last handling). After KILL_S seconds it ends the app, which frees the port.
// server-run.bat then starts it again; on a PC the SITHUB shortcut starts it again.
//
//   const dog = require('./watchdog').start({ log });   dog.doing('GET /api/…')   // what's being handled

const { Worker, isMainThread, workerData } = require('worker_threads');

const STUCK_S = Number(process.env.WATCHDOG_STUCK_S) || 30;
const KILL_S = Number(process.env.WATCHDOG_KILL_S) || 300; // 0: never end it, only log
const TEXT = 400; // bytes kept of what's being handled

if (!isMainThread && workerData?.watchdog) {
  // ---- the watching thread
  const { beat, text, pid, stuckS, killS } = workerData;
  const tick = new Int32Array(beat); const bytes = new Uint8Array(text);
  const log = require('./logger');
  const doing = () => { const n = bytes.indexOf(0); return Buffer.from(bytes.subarray(0, n < 0 ? bytes.length : n)).toString('utf8') || 'starting up'; };
  // 🔬 where it's stuck: the main thread's debugger, switched on now while it's free, lets this thread pause it even
  // while it's busy, read the functions it's in (file and line) and let it carry on. That goes in the log.
  let stackOf = null;
  if (process.env.WATCHDOG_STACK !== '0') {
    try {
      const inspector = require('inspector'); const path = require('path');
      const s = new inspector.Session(); s.connectToMainThread();
      const post = (m, p) => new Promise((res, rej) => s.post(m, p || {}, (e, r) => (e ? rej(e) : res(r))));
      const urls = new Map(); s.on('Debugger.scriptParsed', ({ params }) => { if (params.url) urls.set(params.scriptId, params.url); });
      let enabled = false; post('Debugger.enable').then(() => { enabled = true; }, () => {});
      const root = path.resolve(__dirname, '..');
      const top = root.replace(/\\/g, '/').toLowerCase();
      const where = (f) => { let u = String(f.url || urls.get(f.location?.scriptId) || '').replace(/^file:\/\//, ''); try { u = decodeURIComponent(u); } catch { /* as is */ } u = u.replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1');
        const rel = u.toLowerCase().startsWith(top) ? u.slice(top.length + 1) : u.replace(/^node:/, '').split('/').slice(-1)[0];
        return `${f.functionName || '(anonymous)'} ${rel}:${f.location.lineNumber + 1}`; };
      stackOf = () => new Promise((resolve) => {
        if (!enabled) return resolve(null);
        const timer = setTimeout(() => resolve('(no answer: it is waiting on something outside the app, a file, the network or the database)'), 10000);
        s.once('Debugger.paused', ({ params }) => {
          clearTimeout(timer);
          resolve(params.callFrames.slice(0, 14).map(where).join(' <- '));
          post('Debugger.resume').catch(() => {});
        });
        post('Debugger.pause').catch(() => { clearTimeout(timer); resolve(null); });
      });
    } catch { stackOf = null; }
  }
  let warned = false; let lastStack = 0;
  const logStack = () => { if (!stackOf || Date.now() - lastStack < 60000) return; lastStack = Date.now(); stackOf().then((st) => { if (st) log.warn(`Stuck in: ${st}`); }); };
  setInterval(() => {
    const quiet = Math.floor(Date.now() / 1000) - Atomics.load(tick, 0) - Atomics.load(tick, 1);
    if (quiet < stuckS) { if (warned) log.info(`The app is answering again after being stuck for a while (it was busy with: ${doing()})`); warned = false; return; }
    if (!warned) { warned = true; log.warn(`The app has been stuck for ${quiet} s, not answering anyone. It was last busy with: ${doing()} (memory in use: ${Math.round(process.memoryUsage().rss / 1048576)} MB)`); }
    logStack();
    if (killS > 0 && quiet >= killS) {
      log.error(`Still stuck after ${quiet} s (busy with: ${doing()}). Ending it so the port is free and it can be started again`);
      process.kill(pid, 'SIGKILL'); // the whole app, not just this thread
    }
  }, 5000);
} else {
  module.exports.start = function start() {
    if (process.env.WATCHDOG === '0') return { doing() {} };
    // seconds since BASE in [1], set by the main thread every second; [0] holds BASE (the Int32 range)
    const beat = new SharedArrayBuffer(8); const tick = new Int32Array(beat);
    const BASE = Math.floor(Date.now() / 1000); Atomics.store(tick, 0, BASE);
    const now = () => Atomics.store(tick, 1, Math.floor(Date.now() / 1000) - BASE);
    now(); setInterval(now, 1000).unref();
    const text = new SharedArrayBuffer(TEXT); const bytes = new Uint8Array(text);
    try {
      const w = new Worker(__filename, { workerData: { watchdog: true, beat, text, pid: process.pid, stuckS: STUCK_S, killS: KILL_S } });
      w.unref(); w.on('error', () => { /* without it, the app just isn't watched */ });
    } catch { /* ditto */ }
    return {
      doing(what) {
        const b = Buffer.from(String(what).slice(0, TEXT), 'utf8').subarray(0, TEXT - 1);
        bytes.set(b); bytes.fill(0, b.length);
      },
    };
  };
}
