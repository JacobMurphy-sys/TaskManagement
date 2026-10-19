// Sets a CI Manager account's password, on the server, e.g. when the only admin has forgotten theirs:
//   node scripts/reset-password.js <username> <new password>
// (run in the app folder; the app can keep running). The new password must be changed at the next
// sign-in. Without arguments it lists the accounts.
const db = require('../src/db');
db.migrate();
const { hashPassword } = require('../src/accounts');
const [username, password] = process.argv.slice(2);
if (!username) {
  const list = db.all('SELECT username, person, role, active FROM accounts ORDER BY username');
  console.log(list.length ? list.map((a) => `${a.username}  (${a.person}, ${a.role}${a.active ? '' : ', inactive'})`).join('\n') : 'No accounts: sign-in is off.');
  process.exit(0);
}
if (!password || password.length < 8) { console.error('Give a new password of at least 8 characters.'); process.exit(1); }
const a = db.get('SELECT id FROM accounts WHERE username = ?', [username]);
if (!a) { console.error(`There's no account called ${username}.`); process.exit(1); }
db.run('UPDATE accounts SET password_hash = ?, must_change = 1, active = 1 WHERE id = ?', [hashPassword(password), a.id]);
db.run('DELETE FROM sessions WHERE account_id = ?', [a.id]);
console.log(`${username}'s password is set (and the account active). It must be changed at the next sign-in.`);
