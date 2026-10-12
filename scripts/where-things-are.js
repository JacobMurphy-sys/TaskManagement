// Writes "READ ME - where things are" for an install, with this computer's real paths:
// a .txt for Notepad and a .md for Obsidian (or any Markdown reader). Run by CIManager-Setup.bat:
//   node scripts/where-things-are.js <folder> [--inplace]
// <folder> is where the files go (the folder CIManager-Setup.bat installed into). The data folder,
// port and shared paths file come from the app's own settings (.env), as the app itself sees them.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const inplace = args.includes('--inplace');
const base = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const NAME = 'READ ME - where things are';

// The app's view of things (reads app\.env). LOCALAPPDATA decides the default data folder.
const config = require('../src/config');
const app = config.ROOT;
const local = process.env.LOCALAPPDATA;
const plannerDir = local ? path.join(local, 'CIPlanner') : path.join(require('os').homedir(), '.ciplanner');
const repo = 'https://github.com/JacobMurphy-sys/TaskManagement';

let version = 'unknown';
try { version = execFileSync('git', ['-C', app, 'log', '-1', '--format=%h, %cs'], { encoding: 'utf8' }).trim(); } catch { /* not a clone */ }
const now = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// The installer makes a CI Manager shortcut with the CI Manager icon, here and on the desktop.
const launch = 'the CI Manager shortcut (on the desktop, or in this folder)';
const planner = inplace ? 'planner.bat' : 'app\\planner.bat';

// The content once; rendered as plain text and as Markdown below.
// Blocks: { p }, { list: [] }, { files: [[name, what], ...] } (a folder's contents), { note } (a callout).
const doc = [
  { h: 'Day to day', blocks: [
    { files: [
      ['Start', `Double-click ${launch}. It runs in the background and opens http://localhost:${config.port} in your browser. Double-click it again to just open the browser.`],
      ['Stop', 'In the app: the top bar\'s ⋯ menu › Stop server.'],
      ['Update', 'Automatic: each time the CI Manager shortcut starts the app, it checks for a newer version first, and if there is one, updates in a window (backing up your data first) and then starts. To update straight away, stop the app and double-click CIManager-Setup.bat. AUTO_UPDATE=0 in .env turns the automatic check off.'],
      ['Taskbar', 'Right-click the CI Manager shortcut › Pin to taskbar (on Windows 11: Show more options › Pin to taskbar). Or, with the app open in Edge or Chrome: ⋯ menu › Apps › Install CI Manager, which gives it a window and taskbar icon of its own (it needs the app running, so start it with the shortcut or at log-in).'],
      ['At log-in', `Optional: press Win+R, type shell:startup, and copy the CI Manager shortcut into the folder that opens.`],
    ] },
  ] },
  { h: 'What is kept where', blocks: [
    { folder: base, files: inplace ? [
      ['(this folder)', `A copy of the program from GitHub (${repo}). Updates replace its files, so don't keep your own files in it. The only file of yours in it is .env (optional settings, below).`],
      [`${NAME}.txt / .md`, 'This file, rewritten on every update.'],
    ] : [
      ['CI Manager', 'Shortcut: updates the app if there\'s a newer version, starts it and opens it (the desktop shortcut does the same).'],
      ['CIManager-Setup.bat', 'Install and update (the shortcut runs it when there\'s an update). Refreshes itself on each run.'],
      [`${NAME}.txt / .md`, 'This file, rewritten on every update.'],
      ['app\\', 'The program, downloaded from GitHub. Replaced on every update, so don\'t keep your own files in it. The only file of yours in it is app\\.env (optional settings, below).'],
    ] },
    { folder: config.dataDir, intro: 'Your data. Never touched by installing or updating, and the only thing that needs backing up.', files: [
      [path.basename(config.dbFile), 'The database: projects, tasks, meetings, ideas, contacts, KPIs, the planning setup and every setting, including the file paths below.'],
      ['backups\\', 'Automatic backups (daily, the last 30 kept), plus one before every update. backups\\db\\ has whole-database copies.'],
      ['attachments\\', 'Files attached to tasks and meetings.'],
      ['logs\\', 'The app\'s log files. Look at the newest one if something goes wrong.'],
    ] },
    { folder: plannerDir, intro: `Only if Planning is run on its own for several people (${planner}): its own database (planner.db), backups and logs.` },
    { p: 'Your own files stay where they are. The app only reads them, from the paths set in the app:' },
    { list: [
      'KPIs › Sources: the CI workbook, the source exports, the forecasts, and the folder the A3 is saved to.',
      'Planning › Setup: the open work orders export, the Otto export and the card database.',
      'Settings: the project charter template and the report options.',
    ] },
  ] },
  { h: 'Shared file paths', blocks: config.defaultsFile ? [
    { p: `Read from ${config.defaultsFile} each time the app starts.` },
    { p: 'It fills in the KPI workbook, sources, forecasts and A3 folder, and Planning\'s export paths, where they are blank or still as the file last set them. A path you change yourself is kept. See KPIs › Sources › Shared paths.' },
  ] : [
    { p: 'None set up. To give everyone the same network paths: on KPIs › Sources › Shared paths, click Export these paths for everyone, and save the file as cimanager-defaults.json next to CIManager-Setup.bat on the network. Installs and updates run from there then use it.' },
  ] },
  { h: 'Optional settings', blocks: [
    { p: `To change the port, the data folder, the backup schedule or the shared paths file, copy .env.example to .env in ${app} and edit it (PORT, DATA_DIR, BACKUP_INTERVAL_HOURS, BACKUP_KEEP, DEFAULTS_FILE, AUTO_UPDATE). Restart the app afterwards.` },
    { note: 'Keep the data folder on this computer\'s own disk, not a network drive or a synced (OneDrive) folder.' },
  ] },
  { h: 'Moving to another computer', blocks: [
    { steps: [
      'Stop the app and copy the whole data folder above.',
      'On the new computer, run CIManager-Setup.bat.',
      'Stop the app, replace the new data folder with your copy, and start it again.',
    ] },
    { p: 'Planning\'s Setup can also be moved on its own: Planning › Setup › Export setup / Import setup.' },
  ] },
  { h: 'If something goes wrong', blocks: [
    { list: [
      `Nothing opens: run start.bat in ${app} to see the error in a window.`,
      'An update failed: the messages say why, and the version you had keeps working. If you edited a file in the program folder, undo that and run CIManager-Setup.bat again.',
      'Data looks wrong after an update: Backups (top bar, ⋯ menu) restores an earlier copy.',
      `Full documentation: README.md in ${app}, or ${repo}`,
    ] },
  ] },
];

// ---- plain text for Notepad (ASCII-friendly, wrapped, CRLF)
function wrap(text, width, first = '', rest = first) {
  const out = []; let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (line + ' ' + word).length > width) { out.push(line); line = rest + word; } else line = line ? `${line} ${word}` : (out.length ? rest : first) + word;
  }
  if (line) out.push(line);
  return out;
}
const plain = (s) => s.replace(/›/g, '>').replace(/⋯/g, '...');
function toText() {
  const L = ['CI MANAGER - WHERE THINGS ARE', '=============================',
    `Written by CIManager-Setup.bat on ${now}. Version installed: ${version}.`,
    'This file is rewritten every time the setup runs, so don\'t keep notes in it.', ''];
  for (const s of doc) {
    L.push('', s.h.toUpperCase(), '-'.repeat(s.h.length));
    for (const b of s.blocks) {
      if (b.p) L.push(...wrap(plain(b.p), 96));
      if (b.note) L.push(...wrap(`NOTE: ${plain(b.note)}`, 96, '', '      '));
      if (b.list) for (const t of b.list) L.push(...wrap(`- ${plain(t)}`, 96, '  ', '    '));
      if (b.steps) b.steps.forEach((t, i) => L.push(...wrap(`${i + 1}. ${plain(t)}`, 96, '  ', '     ')));
      if (b.folder) {
        L.push('', b.folder);
        if (b.intro) L.push(...wrap(plain(b.intro), 96, '  '));
      }
      if (b.files) {
        const w = Math.max(...b.files.map(([n]) => n.length)) + 3;
        for (const [n, what] of b.files) {
          const lines = wrap(plain(what), 96 - w - 2);
          L.push(`  ${n.padEnd(w)}${lines[0]}`, ...lines.slice(1).map((x) => `  ${' '.repeat(w)}${x}`));
        }
      }
      L.push('');
    }
  }
  return L.join('\r\n').replace(/(\r\n){3,}/g, '\r\n\r\n');
}

// ---- Markdown for Obsidian: front matter, tables, callouts, links that open the folders
const fileUrl = (p) => (/^\\\\/.test(p) ? `file:${encodeURI(p.replace(/\\/g, '/'))}` : `file:///${encodeURI(p.replace(/\\/g, '/').replace(/^\/+/, ''))}`);
const md = (s) => s.replace(/([\\|*_`[\]])/g, '\\$1');
function toMarkdown() {
  const L = ['---', 'tags: [ci-manager]', `updated: ${new Date().toISOString().slice(0, 10)}`, `version: "${version}"`, '---',
    '# CI Manager: where things are', '',
    `> [!info] Written by CIManager-Setup.bat on ${now} (version ${md(version)}).`,
    '> It is rewritten every time the setup runs. To keep notes, copy it into your vault and edit the copy.', ''];
  for (const s of doc) {
    L.push(`## ${s.h}`, '');
    for (const b of s.blocks) {
      if (b.p) L.push(md(b.p), '');
      if (b.note) L.push(`> [!warning] ${md(b.note)}`, '');
      if (b.list) L.push(...b.list.map((t) => `- ${md(t)}`), '');
      if (b.steps) L.push(...b.steps.map((t, i) => `${i + 1}. ${md(t)}`), '');
      if (b.folder) {
        L.push(`### \`${b.folder}\``, '', `[Open the folder](${fileUrl(b.folder)})`, '');
        if (b.intro) L.push(md(b.intro), '');
      }
      if (b.files) L.push(b.folder ? '| In it | What |' : '| | |', '|---|---|', ...b.files.map(([n, what]) => `| **${md(n)}** | ${md(what)} |`), '');
    }
  }
  return L.join('\n');
}

fs.writeFileSync(path.join(base, `${NAME}.txt`), toText());
fs.writeFileSync(path.join(base, `${NAME}.md`), toMarkdown());
console.log(`      Wrote "${NAME}.txt" (Notepad) and ".md" (Obsidian) in ${base}`);
