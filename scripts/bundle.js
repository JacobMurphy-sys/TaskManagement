#!/usr/bin/env node
'use strict';
// 📦 SITHUB as a ready-to-run bundle, for a server with no internet, no Node.js and no Git installed.
//
//   GitHub → sync machine (sync-gitea.bat: git + this "build") → Gitea release → office server ("check" / "fetch")
//
// build   (on the sync machine, which has internet, Git and Node.js — Windows, the server's kind of machine):
//         node scripts/bundle.js build --mirror <bare mirror> --work <this checkout> --out <folder>
//              [--gitea <https://gitea.office/OWNER/REPO>] [--token-file <file>] [--copy-to <folder>] [--keep 5]
//         [--branch server]  The checkout (of the server branch, made by sync-gitea.bat) gets its dependencies (npm ci, the production ones,
//         built for this machine), the commits per day for the timeline, runtime\node.exe (this Node.js)
//         and BUILD.json; then it's zipped as SITHUB-<commit>.zip in --out, published as a release on
//         Gitea (when --gitea is given) and/or copied, with latest.json, to a folder (--copy-to).
// check   (on the server, run with the bundled node.exe): exit 10 when a newer bundle is published, else 0.
// fetch   --to <folder>: downloads the newest bundle and unpacks it there, ready to be copied over the app
//         (server-run.bat does that while the app is stopped).
// Where the server looks: UPDATE_FROM in .env — the Gitea repository's address (its releases) or a folder
// (a share with latest.json); UPDATE_TOKEN — a Gitea access token, when the repository isn't public.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2); const cmd = args[0];
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(msg); process.exit(1); };
const short = (c) => String(c || '').slice(0, 7);

// .env of this app (UPDATE_FROM, UPDATE_TOKEN), without loading the app's config
function env() {
  const out = { ...process.env }; const f = path.join(ROOT, '.env');
  if (fs.existsSync(f)) for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && out[m[1]] === undefined) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
  return out;
}
// a Gitea repository address → its API base (https://gitea.office/IT/SITHUB(.git) → …/api/v1/repos/IT/SITHUB)
function giteaApi(url) {
  const u = new URL(String(url).replace(/\.git$/, '').replace(/\/+$/, ''));
  const [owner, repo] = u.pathname.split('/').filter(Boolean).slice(-2); if (!owner || !repo) throw new Error(`not a repository address: ${url}`);
  const base = u.pathname.split('/').filter(Boolean).slice(0, -2).join('/');
  return `${u.origin}${base ? `/${base}` : ''}/api/v1/repos/${owner}/${repo}`;
}
const isUrl = (s) => /^https?:\/\//i.test(String(s || ''));
const headers = (token) => (token ? { Authorization: `token ${token}` } : {});

// ---- the zip (the app's own reader and writer: src/xlsx.js) -------------------------------------------------
const { zip, readZip } = require(path.join(ROOT, 'src', 'xlsx.js'));
function walk(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name); const rel = path.relative(base, p).split(path.sep).join('/');
    if (e.isDirectory()) { if (rel === '.git') continue; walk(p, base, out); } else if (e.isFile()) out[rel] = fs.readFileSync(p);
  }
  return out;
}
function unpack(buf, to) {
  const files = readZip(buf); let n = 0;
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    const dest = path.resolve(to, ...name.split('/'));
    if (!dest.startsWith(path.resolve(to) + path.sep)) throw new Error(`a file outside the folder: ${name}`); // never outside it
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data); n++;
  }
  return n;
}

// ---- build (sync machine) ----------------------------------------------------------------------------------
async function build() {
  const mirror = opt('mirror'); const work = path.resolve(opt('work', ROOT)); const out = path.resolve(opt('out', path.join(work, '..', 'bundles')));
  if (!mirror) fail('--mirror <the bare mirror of the repository> is needed');
  const anyPlatform = args.includes('--any-platform'); // (for trying it out elsewhere than Windows)
  if (process.platform !== 'win32' && !anyPlatform) fail('Build the bundle on Windows (the server\'s kind of machine): its dependencies and node.exe are Windows\'.');
  const [maj, min] = process.versions.node.split('.').map(Number); if (maj < 22 || (maj === 22 && min < 13)) fail(`Node.js ${process.version} is too old: SITHUB needs 22.13 or later`);
  const git = (...a) => execFileSync('git', ['--git-dir', mirror, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
  const branch = opt('branch', 'server'); // the office server's branch: live (main) + what the server needs
  const commit = git('rev-parse', branch); const date = git('log', '-1', '--format=%cI', branch); const subject = git('log', '-1', '--format=%s', branch);
  log(`Bundling ${branch} ${short(commit)} (${date.slice(0, 10)}) — ${subject}`);
  // the dependencies, as the lock file has them, for this machine (production only)
  log('Installing the dependencies (npm ci)…');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: work, stdio: 'inherit', shell: process.platform === 'win32' });
  // the timeline's commits per day (the server has no git history)
  const counts = {}; for (const d of git('log', branch, '--format=%ad', '--date=short').split('\n').filter(Boolean)) counts[d] = (counts[d] || 0) + 1;
  const dataJs = path.join(work, 'docs', 'data.js');
  if (fs.existsSync(dataJs)) fs.writeFileSync(dataJs, fs.readFileSync(dataJs, 'utf8').replace(/\/\*activity\*\/[\s\S]*?\/\*end\*\//, `/*activity*/${JSON.stringify(Object.fromEntries(Object.keys(counts).sort().map((d) => [d, counts[d]])))}/*end*/`));
  // Node.js itself
  fs.mkdirSync(path.join(work, 'runtime'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(work, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
  const info = { branch, commit, short: short(commit), date, subject, built: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch };
  fs.writeFileSync(path.join(work, 'BUILD.json'), JSON.stringify(info, null, 2));
  // zipped
  log('Packing…'); const files = walk(work); const buf = zip(files);
  fs.mkdirSync(out, { recursive: true }); const name = `SITHUB-${short(commit)}.zip`; fs.writeFileSync(path.join(out, name), buf);
  log(`${name}: ${Object.keys(files).length} files, ${(buf.length / 1048576).toFixed(1)} MB`);
  const keep = Math.max(1, Number(opt('keep', 5)) || 5);
  for (const [f] of fs.readdirSync(out).filter((f) => /^SITHUB-[0-9a-f]{7}\.zip$/.test(f) && f !== name).map((f) => [f, fs.statSync(path.join(out, f)).mtimeMs]).sort((a, b) => b[1] - a[1]).slice(keep - 1)) fs.unlinkSync(path.join(out, f)); // the newest few kept
  // in a folder (a share the server can read): the zip and latest.json; the oldest beyond --keep removed
  const copyTo = opt('copy-to');
  if (copyTo) {
    fs.mkdirSync(copyTo, { recursive: true }); fs.copyFileSync(path.join(out, name), path.join(copyTo, name));
    fs.writeFileSync(path.join(copyTo, 'latest.json'), JSON.stringify({ ...info, file: name }, null, 2));
    const old = fs.readdirSync(copyTo).filter((f) => /^SITHUB-[0-9a-f]{7}\.zip$/.test(f)).map((f) => [f, fs.statSync(path.join(copyTo, f)).mtimeMs]).sort((a, b) => b[1] - a[1]).slice(keep);
    for (const [f] of old) fs.unlinkSync(path.join(copyTo, f));
    log(`Copied to ${copyTo}`);
  }
  // on Gitea: a release (tag bundle-<commit>) with the zip attached; the oldest bundle releases beyond --keep removed
  const gitea = opt('gitea');
  if (gitea) {
    const tokenFile = opt('token-file'); const token = (tokenFile && fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : process.env.GITEA_TOKEN || '').trim();
    if (!token) fail('A Gitea token is needed to publish: --token-file <file> (or GITEA_TOKEN)');
    const api = giteaApi(gitea); const h = headers(token); const tag = `bundle-${short(commit)}`;
    const ok = async (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.status} ${await r.text().catch(() => '')}`.slice(0, 400)); return r; };
    let rel = await fetch(`${api}/releases/tags/${tag}`, { headers: h });
    if (rel.status === 404) {
      rel = await ok(await fetch(`${api}/releases`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: `SITHUB ${short(commit)} — ${date.slice(0, 10)}`, body: `${subject}\n\nBuilt ${info.built} with Node.js ${info.node} (${info.platform}-${info.arch}) for an office server with no internet: unzip, or let server-run.bat update to it.` }) }), 'making the release');
    } else await ok(rel, 'reading the release');
    const R = await rel.json();
    if (!(R.assets || []).some((a) => a.name === name)) {
      const form = new FormData(); form.append('attachment', new Blob([buf], { type: 'application/zip' }), name);
      await ok(await fetch(`${api}/releases/${R.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: h, body: form }), 'attaching the bundle (is it bigger than Gitea allows? [attachment] MAX_SIZE)');
    }
    log(`Published on Gitea: ${tag}`);
    const all = await (await ok(await fetch(`${api}/releases?limit=50`, { headers: h }), 'listing the releases')).json();
    for (const r of all.filter((x) => /^bundle-/.test(x.tag_name)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(keep)) {
      await fetch(`${api}/releases/${r.id}`, { method: 'DELETE', headers: h }); await fetch(`${api}/tags/${encodeURIComponent(r.tag_name)}`, { method: 'DELETE', headers: h });
      log(`Removed the old ${r.tag_name}`);
    }
  }
}

// ---- the newest bundle published (server) --------------------------------------------------------------------
async function newest() {
  const E = env(); const from = E.UPDATE_FROM; if (!from) return null;
  if (!isUrl(from)) {
    const f = path.join(from, 'latest.json'); if (!fs.existsSync(f)) return null;
    const L = JSON.parse(fs.readFileSync(f, 'utf8')); return { commit: L.commit, name: L.file, get: async () => fs.readFileSync(path.join(from, L.file)) };
  }
  const api = giteaApi(from); const h = headers(E.UPDATE_TOKEN);
  const r = await fetch(`${api}/releases?limit=20`, { headers: h, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`Gitea said ${r.status}`);
  const rel = (await r.json()).filter((x) => /^bundle-[0-9a-f]{7}$/.test(x.tag_name) && !x.draft && (x.assets || []).some((a) => /\.zip$/.test(a.name)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!rel) return null;
  const asset = rel.assets.find((a) => /\.zip$/.test(a.name));
  return { commit: rel.tag_name.slice(7), name: asset.name, get: async () => { const d = await fetch(asset.browser_download_url, { headers: h, signal: AbortSignal.timeout(600000) }); if (!d.ok) throw new Error(`download: ${d.status}`); return Buffer.from(await d.arrayBuffer()); } };
}
const installed = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'BUILD.json'), 'utf8')); } catch { return null; } };

async function check() {
  if (/^\s*(0|false|no|off)\s*$/i.test(env().AUTO_UPDATE || '')) process.exit(0);
  try { const n = await newest(); const me = installed(); process.exit(n && me && short(n.commit) !== short(me.commit) ? 10 : 0); } catch { process.exit(0); } // offline: never in the way
}

async function fetchTo() {
  const to = path.resolve(opt('to', path.join(ROOT, '..', 'SITHUB-update')));
  const n = await newest(); if (!n) fail('No bundle published (UPDATE_FROM in .env: the Gitea repository, or the folder with latest.json)');
  log(`Downloading ${n.name}…`); const buf = await n.get();
  fs.rmSync(to, { recursive: true, force: true }); fs.mkdirSync(to, { recursive: true });
  const count = unpack(buf, to);
  const B = JSON.parse(fs.readFileSync(path.join(to, 'BUILD.json'), 'utf8'));
  if (!fs.existsSync(path.join(to, 'src', 'server.js')) || !fs.existsSync(path.join(to, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'))) fail('The bundle is incomplete — not installed');
  log(`Unpacked ${count} files of ${B.short} (${String(B.date).slice(0, 10)}) to ${to}`);
}

(async () => {
  try {
    if (cmd === 'build') await build();
    else if (cmd === 'check') await check();
    else if (cmd === 'fetch') await fetchTo();
    else fail('node scripts/bundle.js build | check | fetch — see the top of the file');
  } catch (err) { fail(err.message); }
})();
