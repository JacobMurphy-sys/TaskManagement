'use strict';
// 🧵 The big reads in a thread of their own: the production reports (the timing reports and DailyPersoData, hundreds
// of thousands of rows) and Reporting's source workbooks. Reading and parsing them took the app a minute or more,
// and over a VPN, with the files on a network share, several: all that time it answered nobody, and the watchdog
// ended it as frozen. Here they're read beside the app, which keeps answering; the rows go into the same database
// (its own connection; SQLite lets one write at a time, and the writing itself is quick).
//
//   await bg.run('prod', { pdata, perso, otto })   the production reports (as readProdReports did)
//   await bg.run('prodOne', { source, file, force }) · bg.run('pdata', { file, force })
//   await bg.run('kpi', importSources options)      Reporting's sources
//   await bg.within(promise, ms)                    the result, or null if it takes longer (it carries on)
//
// One job at a time, in order; the same job asked for again while it's waiting is done once. Without threads
// (they couldn't start), the job is done in the app as before.

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const TASKS = {
  prod({ pdata, perso, otto }) {
    const out = [];
    const pd = require('./persodata').readLinked(pdata || null); out.push({ source: 'pdata', ...pd });
    const prod = require('./prodactual');
    const files = { perso, otto };
    for (const source of Object.keys(prod.SOURCES)) out.push(prod.readLinked(source, files[source] || null));
    return out;
  },
  prodOne: ({ source, file, force }) => require('./prodactual').readLinked(source, file || null, { force: !!force }),
  pdata: ({ file, force }) => require('./persodata').readLinked(file || null, { force: !!force }),
  kpi: (opts) => require('./kpidata').importSources(opts),
  cards: (opts) => require('./planning').readCardsNow(opts), // a big card database (planning.js)
};

if (!isMainThread && workerData?.bgread) {
  // ---- the reading thread
  // what the app plugs into kpidata (api.js), from the same settings
  {
    const db = require('./db'); const kd = require('./kpidata');
    const setting = (k) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value;
    kd.useScrapPref(() => { const p = setting('kpi_scrap_from') || 'auto'; return p === 'auto' && !String(setting('kpi_src_consumption') || '').trim() ? 'remakes' : p; });
    kd.useOtdEntered(() => setting('kpi_otd_from') === 'entered');
  }
  parentPort.on('message', ({ id, task, args }) => {
    let msg;
    try { msg = { id, ok: true, result: TASKS[task](args) }; } catch (err) { msg = { id, ok: false, error: err.message }; }
    parentPort.postMessage(msg);
  });
} else {
  let worker = null; let nextId = 1;
  const waiting = new Map(); // id → { resolve, reject }
  const queue = []; // { key, task, args, done: Promise, resolve, reject }
  let busy = null;

  const startWorker = () => {
    if (worker || process.env.BGREAD === '0') return worker;
    try {
      worker = new Worker(__filename, { workerData: { bgread: true } });
      worker.unref();
      worker.on('message', ({ id, ok, result, error }) => { const w = waiting.get(id); waiting.delete(id); if (w) (ok ? w.resolve(result) : w.reject(new Error(error))); });
      const gone = (err) => { worker = null; for (const w of waiting.values()) w.reject(err || new Error('the reading thread stopped')); waiting.clear(); };
      worker.on('error', gone); worker.on('exit', () => gone());
    } catch { worker = null; }
    return worker;
  };
  const exec = (task, args) => {
    const w = startWorker();
    if (!w) return Promise.resolve().then(() => TASKS[task](args)); // no thread: in the app, as before
    return new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); w.postMessage({ id, task, args }); });
  };
  const pump = () => {
    if (busy || !queue.length) return;
    busy = queue.shift();
    exec(busy.task, busy.args).then(busy.resolve, busy.reject).finally(() => { busy = null; pump(); });
  };
  module.exports = {
    run(task, args = {}) {
      const key = `${task}|${JSON.stringify(args)}`;
      const same = queue.find((j) => j.key === key); if (same) return same.done; // already waiting: once is enough
      const job = { key, task, args }; job.done = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      queue.push(job); pump();
      return job.done;
    },
    // the result, or null when it takes longer than ms (the job carries on, and its rows are there next time)
    within: (p, ms) => Promise.race([p.catch((err) => ({ status: 'error', error: err.message })), new Promise((r) => setTimeout(() => r(null), ms).unref())]),
    busy: () => !!busy || queue.length > 0,
  };
}
