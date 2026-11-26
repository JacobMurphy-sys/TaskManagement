// Is a newer version on GitHub? Used by start-hidden.vbs when the app starts.
// Exit code 10: yes (behind the remote branch), 0: no, or it couldn't tell (offline, not a
// clone, AUTO_UPDATE=0 in .env) - starting the app is never held up by this.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile) && /^\s*AUTO_UPDATE\s*=\s*(0|false|no|off)\s*$/im.test(fs.readFileSync(envFile, 'utf8'))) process.exit(0);
if (!fs.existsSync(path.join(root, '.git'))) process.exit(0);

const git = (...args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'],
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // never stop to ask for a password
}).trim();
try {
  git('fetch', '--quiet');
  const behind = Number(git('rev-list', '--count', 'HEAD..@{u}'));
  process.exit(behind > 0 ? 10 : 0);
} catch {
  process.exit(0);
}
