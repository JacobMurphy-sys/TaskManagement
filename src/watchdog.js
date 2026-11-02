'use strict';
// 🐕 A frozen app holds its port without answering: the browser waits, stop-server.vbs gets no
// answer, and a new start fails with "port already in use". This watches from a separate thread.
// When the app hasn't ticked for STUCK_S seconds it writes to the log what it was doing (the
// request it was last handling). After KILL_S seconds it ends the app, which frees the port.
// server-run.bat then starts it again; on a PC the CI Manager shortcut starts it again.
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
  let warned = false;
  setInterval(() => {
    const quiet = Math.floor(Date.now() / 1000) - Atomics.load(tick, 0) - Atomics.load(tick, 1);
    if (quiet < stuckS) { if (warned) log.info(`The app is answering again after being stuck for a while (it was busy with: ${doing()})`); warned = false; return; }
    if (!warned) { warned = true; log.warn(`The app has been stuck for ${quiet} s, not answering anyone. It was last busy with: ${doing()}`); }
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
