// Timestamped logging to console and to a daily file in LOG_DIR.
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(config.logDir, { recursive: true });

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function write(level, message, extra) {
  const line = `${new Date().toISOString()} [${level}] ${message}` +
    (extra !== undefined ? ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : '');
  (level === 'ERROR' ? console.error : console.log)(line);
  try {
    fs.appendFileSync(path.join(config.logDir, `app-${localDate()}.log`), line + '\n');
  } catch (err) {
    console.error('Could not write log file:', err.message);
  }
}

module.exports = {
  info: (msg, extra) => write('INFO', msg, extra),
  warn: (msg, extra) => write('WARN', msg, extra),
  error: (msg, extra) => write('ERROR', msg, extra),
};

// Result of moving the data folder to its new name (see config.js), logged once.
if (config.dataDirNote) write(/^Moved/.test(config.dataDirNote) ? 'INFO' : 'WARN', config.dataDirNote);
