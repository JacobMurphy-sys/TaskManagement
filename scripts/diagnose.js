// 🩺 Why has SITHUB stopped? Run diagnose.bat (or `node scripts/diagnose.js`) the moment it seems to have
// stopped: it writes what it finds to a text file in the logs folder and opens it. Is a copy of the app
// still running, does it answer (on 127.0.0.1 and on localhost), where are its data and logs, is a proxy
// or VPN in the way, and the last lines of the logs. Nothing is changed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dns = require('dns');
const { execFileSync } = require('child_process');

const out = [];
const say = (s = '') => out.push(s);
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (err) { return `(couldn't: ${err.message.split('\n')[0]})`; } };
const get = (host, port, family) => new Promise((resolve) => {
  const t0 = Date.now();
  const req = http.get({ host, port, family, path: '/api/health', timeout: 4000 }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve(`answered ${res.statusCode} in ${Date.now() - t0} ms${body.includes('taskmanager') ? ' (it is SITHUB)' : ` (not SITHUB: ${body.slice(0, 80)})`}`));
  });
  req.on('timeout', () => req.destroy(new Error('no answer within 4 s (running but stuck?)')));
  req.on('error', (e) => resolve(`no: ${e.code || ''} ${e.message}`.trim()));
});
const tail = (file, n) => { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n).join('\n'); } catch (err) { return `(can't read: ${err.code || err.message})`; } };

(async () => {
  say(`SITHUB check, ${new Date().toString()}`);
  say(`Computer ${os.hostname()}, user ${os.userInfo().username}, Node ${process.version}, ${os.platform()} ${os.release()}`);
  say(`App folder: ${path.resolve(__dirname, '..')}`);
  let config = null;
  try { config = require('../src/config'); } catch (err) { say(`!! The app's settings couldn't be read: ${err.message}`); }
  const port = config?.port || 3000;
  if (config) {
    say(`Data folder: ${config.dataDir}`); say(`Database: ${config.dbFile}`); say(`Logs: ${config.logDir}`);
    say(`Port ${port}, listening on ${config.host}`);
    const envFile = path.join(path.resolve(__dirname, '..'), '.env');
    if (fs.existsSync(envFile)) say(`.env sets: ${fs.readFileSync(envFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split('=')[0]).join(', ') || 'nothing'}`);
  }

  say(''); say('== Is a copy running? ==');
  if (config) {
    const lockFile = `${config.dbFile}.lock`;
    let lock = null; try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* none */ }
    if (!lock) say('No lock file: no copy has the database open (it stopped, or never started).');
    else {
      const age = Math.round((Date.now() - new Date(lock.beat).getTime()) / 1000);
      let alive = false; if (lock.host === os.hostname()) { try { process.kill(lock.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
      say(`Lock: process ${lock.pid} on ${lock.host} (user ${lock.user}), started ${lock.started}, last sign of life ${age} s ago${age > 60 ? ' (should be under 20 s: stuck or gone)' : ''}`);
      if (lock.host === os.hostname()) say(alive ? 'That process is still running.' : 'That process has gone: the app stopped without tidying up (ended from outside, or crashed).');
    }
  }
  if (process.platform === 'win32') say(`node.exe running: ${run('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH']).split(/\r?\n/).filter((l) => /node/i.test(l)).length} (this check is one of them)`);

  say(''); say('== Does it answer? ==');
  say(`http://127.0.0.1:${port}  ${await get('127.0.0.1', port, 4)}`);
  say(`http://[::1]:${port}  ${await get('::1', port, 6)}`);
  say(`http://localhost:${port}  ${await get('localhost', port)}`);
  try { say(`"localhost" means: ${(await dns.promises.lookup('localhost', { all: true })).map((a) => a.address).join(', ')}`); } catch (err) { say(`"localhost" doesn't resolve: ${err.code}`); }

  say(''); say('== Network and proxy ==');
  say(`Network adapters up: ${Object.entries(os.networkInterfaces()).filter(([, a]) => a.some((x) => !x.internal)).map(([n, a]) => `${n} (${a.filter((x) => !x.internal).map((x) => x.address).join(', ')})`).join('; ') || 'none'}`);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy']) if (process.env[k]) say(`${k}=${process.env[k]}`);
  if (process.platform === 'win32') {
    const reg = run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']);
    for (const k of ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL']) { const m = reg.match(new RegExp(`${k}\\s+REG_\\w+\\s+(.*)`)); if (m) say(`Windows ${k}: ${m[1].trim()}`); }
    say(`WinHTTP proxy: ${run('netsh', ['winhttp', 'show', 'proxy']).replace(/\s+/g, ' ')}`);
  }

  say(''); say('== The logs ==');
  if (config) {
    let logs = []; try { logs = fs.readdirSync(config.logDir).map((f) => ({ f, t: fs.statSync(path.join(config.logDir, f)).mtimeMs })).sort((a, b) => b.t - a.t); } catch (err) { say(`Can't list ${config.logDir}: ${err.code || err.message}`); }
    say(`Newest: ${logs.slice(0, 5).map((x) => `${x.f} (${new Date(x.t).toLocaleString()})`).join(', ') || 'none'}`);
    const app = logs.find((x) => /^app-/.test(x.f)); if (app) { say(''); say(`-- last lines of ${app.f} --`); say(tail(path.join(config.logDir, app.f), 40)); }
    const con = path.join(config.logDir, 'console.log'); if (fs.existsSync(con)) { say(''); say('-- last lines of console.log (what the app printed, crashes too) --'); say(tail(con, 25)); }
  }

  const dir = config?.logDir && fs.existsSync(config.logDir) ? config.logDir : os.tmpdir();
  const file = path.join(dir, `diagnose-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`);
  fs.writeFileSync(file, out.join('\r\n'));
  console.log(out.join('\n')); console.log(`\nWritten to ${file}`);
  if (process.platform === 'win32' && !process.argv.includes('--no-open')) { try { require('child_process').spawn('notepad', [file], { detached: true, stdio: 'ignore' }).unref(); } catch { /* shown above */ } }
})();
