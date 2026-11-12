'use strict';
// 🌐 Files on network shares without freezing the app. Reading a file is done in one go (statSync,
// readFileSync), which holds the whole app until the share answers. Over a VPN, or with the share
// gone, that can be minutes: nobody gets an answer, and the watchdog ends the app as frozen.
//
// So the background jobs (reading the exports and reports every few minutes, the shared team pack
// and setup) first call `await prefetch(file)`: in the background, it checks the share answers
// (its \\server\share, or drive), and reads the file when it has changed. The readers then use
// `statSync` / `readFileSync` from here, which hand over what was read already. While a share isn't
// answering, its files are skipped at once (an error saying so) instead of waiting, and it's tried
// again a minute later. The app's own data is on this computer and never goes through here.

const fs = require('fs');
const log = require('./logger');

const PROBE_MS = Number(process.env.NET_PROBE_MS) || 8000; // a share that hasn't answered in this long is "not answering"
const RECHECK_MS = 60 * 1000; // how long an answer counts
const roots = new Map(); // root → { ok, at, started, pending }
const files = new Map(); // file → { sig, stat, at, buf }
const consumed = new Map(); // file → the sig last handed to a reader

// \\server\share, or X:\ ; elsewhere (Linux, Mac) the top folder
function rootOf(file) {
  const f = String(file || '');
  const unc = f.match(/^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+/); if (unc) return unc[0];
  const drive = f.match(/^[A-Za-z]:/); if (drive) return `${drive[0].toUpperCase()}\\`;
  return null;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms).unref())]);

// does its share answer? (a minute's answer is kept; one check at a time)
function reach(file) {
  const root = rootOf(file); if (!root) return Promise.resolve(true);
  const r = roots.get(root);
  if (r?.pending) return r.pending;
  if (r && Date.now() - r.at < RECHECK_MS) return Promise.resolve(r.ok);
  const started = Date.now();
  // the share root with its slash (as Windows wants it); refused (no right to look at the top) still means it answered
  const target = /[\\/]$/.test(root) ? root : `${root}${root.startsWith('//') ? '/' : '\\'}`;
  const pending = withTimeout(fs.promises.stat(target), PROBE_MS).then(() => true, (err) => ['EPERM', 'EACCES', 'EISDIR', 'ENOTDIR', 'EBUSY'].includes(err.code)).then((ok) => {
    const was = roots.get(root);
    if (was && was.ok !== undefined && was.ok !== ok) log[ok ? 'info' : 'warn'](ok ? `${root} is answering again` : `Can't reach ${root} right now (slow network or VPN?): its files are skipped until it answers`);
    else if (!was?.seen && !ok) log.warn(`Can't reach ${root} (slow network or VPN?): its files are skipped until it answers`);
    roots.set(root, { ok, at: Date.now(), seen: true });
    return ok;
  });
  roots.set(root, { ...(r || {}), started, pending });
  return pending;
}
// known not to answer (or still being asked after PROBE_MS)
function down(file) {
  const r = roots.get(rootOf(file)); if (!r) return false;
  if (r.pending) return Date.now() - r.started > PROBE_MS || r.ok === false;
  return r.ok === false;
}
const unreachable = (file) => Object.assign(new Error(`Can't reach ${rootOf(file)} right now (slow network or VPN?); trying again shortly`), { code: 'EUNREACH' });
const sigOf = (file, st) => `${file}|${st.mtimeMs}|${st.size}`;

// in the background: the share answers, and the file, when it's changed since a reader last had it
async function prefetch(file) {
  if (!file) return false;
  if (!(await reach(file))) return false;
  try {
    const st = await withTimeout(fs.promises.stat(file), PROBE_MS * 2);
    const sig = sigOf(file, st); const have = files.get(file);
    if (consumed.get(file) === sig || have?.sig === sig) { files.set(file, { ...(have || {}), sig, stat: st, at: Date.now() }); return true; }
    const buf = await fs.promises.readFile(file);
    files.set(file, { sig, stat: st, at: Date.now(), buf });
    return true;
  } catch { files.delete(file); return false; } // not there: the reader says so
}

// for the readers, in place of fs.statSync / fs.readFileSync
function statSync(file) {
  if (down(file)) throw unreachable(file);
  const c = files.get(file);
  if (c?.stat && Date.now() - c.at < 30 * 1000) return c.stat;
  return fs.statSync(file);
}
function readFileSync(file) {
  if (down(file)) throw unreachable(file);
  const c = files.get(file);
  if (c?.buf) {
    let fresh = Date.now() - c.at < 30 * 1000;
    if (!fresh) { try { fresh = sigOf(file, fs.statSync(file)) === c.sig; } catch { fresh = false; } }
    if (fresh) { files.set(file, { sig: c.sig, stat: c.stat, at: c.at }); consumed.set(file, c.sig); return c.buf; }
  }
  const buf = fs.readFileSync(file);
  try { consumed.set(file, sigOf(file, fs.statSync(file))); } catch { /* fine */ }
  return buf;
}

module.exports = { rootOf, reach, down, prefetch, statSync, readFileSync };
