'use strict';
// 🖼 SIM's automatic picture (📣 SIM › ⋯): the SIM of the last working day drawn as a PNG on a schedule, like the
// automatic production plans. It's saved in a folder (e.g. on the share, for a screen at the briefing board) and each
// run overwrites the same file, so whatever shows it always has the latest. The reports SIM is fed from are read
// first, so the picture has the day's figures.
//
// Kept in settings: sim_auto ({ enabled, times, days, folder, file }) and sim_auto_state (the last run). Checked every
// minute; a time is only run in the quarter of an hour after it, so a restart doesn't make a pile of old pictures.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { simPictureSvg } = require('../public/simsvg');

const LATE_WINDOW_MIN = 15;
const kv = (k) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value;
const setKv = (k, v) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v]);
const json = (s, d) => { try { const v = JSON.parse(s || ''); return v ?? d; } catch { return d; } };
const pad = (n) => String(n).padStart(2, '0');
const localKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const err400 = (msg) => Object.assign(new Error(msg), { status: 400 });
const DEFAULT = { enabled: false, times: ['06:00'], days: [1, 2, 3, 4, 5], folder: '', file: 'SIM' };

const config = () => ({ ...DEFAULT, ...json(kv('sim_auto'), {}) });
const state = () => json(kv('sim_auto_state'), {});
const saveState = (st) => { const all = { ...state(), ...st }; setKv('sim_auto_state', JSON.stringify(all)); return all; };

// the set-up, checked and tidied (throws a 400 with what's wrong)
function clean(x = {}) {
  const enabled = !!x.enabled;
  const times = [...new Set(String(Array.isArray(x.times) ? x.times.join(',') : x.times || '').split(/[\s,;]+/).filter(Boolean).map((t) => {
    const m = t.match(/^(\d{1,2})[:.h]?(\d{2})$/); if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw err400(`${t} isn't a time (e.g. 06:00, 14:30)`);
    return `${pad(Number(m[1]))}:${m[2]}`;
  }))].sort();
  if (enabled && !times.length) throw err400('Give at least one time it runs');
  const days = [...new Set((Array.isArray(x.days) ? x.days : String(x.days ?? '1,2,3,4,5').split(',')).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const folder = String(x.folder || '').trim().replace(/^"|"$/g, '');
  if (enabled && !folder) throw err400('Say which folder the picture is saved in');
  if (folder && !path.isAbsolute(folder) && !/^\\\\/.test(folder)) throw err400('The folder needs a full path, e.g. S:\\Production\\SIM or \\\\server\\share\\SIM');
  const file = String(x.file || '').trim().replace(/\.png$/i, '').replace(/[<>:"/\\|?*]/g, '').slice(0, 120) || 'SIM';
  return { enabled, times, days: days.length ? days : [1, 2, 3, 4, 5], folder, file };
}
const save = (x) => { const c = clean(x); setKv('sim_auto', JSON.stringify(c)); return c; };
const target = (c) => (c.folder ? path.join(c.folder, `${c.file}.png`) : null);

let deps = null; // { simData(day), refresh(), log }
const useDeps = (d) => { deps = d; };

// the picture of a day (the last working day unless one is given), as PNG bytes
let Resvg = null;
function renderPng(svg) {
  if (!Resvg) {
    try { ({ Resvg } = require('@resvg/resvg-js')); } catch { throw new Error('The picture maker isn\'t installed yet: run update.bat (or npm install) on the server'); }
  }
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' }, background: '#ffffff' }).render().asPng();
}
function picture(day, now = new Date()) {
  const d = deps.simData(day);
  const stamp = `Made ${now.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  return { png: renderPng(simPictureSvg(d, { stamp })), day: d.day };
}

let running = false;
async function run({ slot = null, now = new Date() } = {}) {
  const c = config(); const at = now.toISOString();
  const file = target(c);
  if (!file) return saveState({ ok: false, at, error: 'Say which folder the picture is saved in' });
  if (running) return { ...state(), ok: false, error: 'It\'s being made already' };
  running = true;
  try {
    try { await deps.refresh?.(); } catch { /* the figures already read */ }
    const { png, day } = picture(null, now);
    const tmp = `${file}.sithub-tmp`;
    try { fs.writeFileSync(tmp, png); fs.renameSync(tmp, file); } catch (e1) {
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      try { fs.writeFileSync(file, png); } catch (e2) {
        throw new Error(e2.code === 'EBUSY' || e2.code === 'EPERM' ? `${file} is open on a PC and couldn't be replaced: the next run tries again` : e2.code === 'ENOENT' ? `Can't reach the folder ${c.folder}` : e2.message);
      }
    }
    deps.log?.info(`SIM picture: ${file} (${day})`);
    return saveState({ ok: true, at, slot: slot || undefined, file, day, bytes: png.length, error: null });
  } catch (err) {
    deps.log?.warn(`SIM picture: ${err.message}`);
    return saveState({ ok: false, at, slot: slot || undefined, error: err.message });
  } finally { running = false; }
}

// every minute: is a time due (on one of its days, within the quarter of an hour after it)?
async function tick(now = new Date()) {
  const c = config(); if (!c.enabled || !c.days.includes(now.getDay())) return;
  const key = localKey(now); const st = state();
  for (const t of c.times) {
    const slot = `${key.slice(0, 10)}T${t}`;
    const [h, m] = t.split(':').map(Number);
    const due = new Date(now); due.setHours(h, m, 0, 0);
    const late = (now - due) / 60000;
    if (late < 0 || late > LATE_WINDOW_MIN || (st.slot && st.slot >= slot)) continue;
    await run({ slot, now });
    return;
  }
}
function start() {
  const go = () => tick().catch((err) => deps?.log?.warn(`SIM picture: ${err.message}`));
  setTimeout(go, 25 * 1000).unref();
  setInterval(go, 60 * 1000).unref();
}
function nextRun(c, now = new Date()) {
  if (!c.enabled) return null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    if (!c.days.includes(d.getDay())) continue;
    for (const t of c.times) { const [h, m] = t.split(':').map(Number); const at = new Date(d); at.setHours(h, m, 0, 0); if (at > now) return localKey(at); }
  }
  return null;
}
const overview = (now = new Date()) => { const c = config(); return { ...c, path: target(c), last: Object.keys(state()).length ? state() : null, next: nextRun(c, now) }; };

module.exports = { config, save, clean, run, tick, start, overview, picture, useDeps, nextRun, target };
