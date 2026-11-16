'use strict';
// 🗂 Adding cards to the card database (Access, the Cards table) from SITHUB, for people without Access or an inventory
// management account. The file stays an ordinary Access database where it is (Power BI and Production keep reading
// it); SITHUB writes the new row into it.
//  - What the table is: read from the file itself (mdb-reader, as Production reads it): its columns, their types and
//    sizes, which are required, and the values already used in each (offered as suggestions, so entries match).
//  - Writing: on Windows, through Microsoft's Access Database Engine (ACE OLEDB, the free "Access Database Engine
//    2016 Redistributable" on the server: no Access needed), driven by PowerShell's System.Data.OleDb. One row in a
//    transaction: the AX Ref checked again inside it, then inserted; any error and nothing is written. If the engine
//    isn't there for the 64-bit PowerShell, the 32-bit one is tried (the engine comes in one or the other).
//  - Before the first write of the hour, a copy of the database is kept (DATA_DIR/card-db-backups, the last 20).
//  - test(): opens the file for writing and makes a change that touches no row, then rolls it back: proves the engine,
//    its bitness and write access to the file without changing anything.
// CARDWRITE_TEST_LOG (the smoke test only): instead of writing, each request is appended to that file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');
const log = require('./logger');

// mdb-reader's column types → what the form shows and the OLE DB type the value is sent as (null: not written)
const TYPES = {
  text: ['text', 'VarWChar'], memo: ['memo', 'LongVarWChar'], boolean: ['boolean', 'Boolean'],
  byte: ['integer', 'UnsignedTinyInt'], integer: ['integer', 'SmallInt'], long: ['integer', 'Integer'], bigint: ['integer', 'BigInt'],
  float: ['number', 'Single'], double: ['number', 'Double'], currency: ['number', 'Currency'], numeric: ['number', 'Decimal'],
  datetime: ['date', 'Date'],
};
const RANGE = { byte: [0, 255], integer: [-32768, 32767], long: [-2147483648, 2147483647] };

// The table as it is: columns (name, kind, size, required, auto) and, for text columns, the values used most (≤ 60).
// Run in the reading thread for a big database (bgread.js 'cardSchema').
function schemaNow({ file, table = 'Cards' }) {
  const MDBReader = require('mdb-reader').default || require('mdb-reader');
  const nf = require('./netfile');
  const reader = new MDBReader(nf.readFileSync(file));
  const names = reader.getTableNames();
  const name = names.find((n) => n.toLowerCase() === String(table).toLowerCase());
  if (!name) throw new Error(`There's no table called "${table}" (it has ${names.join(', ')})`);
  const t = reader.getTable(name);
  const columns = t.getColumns().map((c) => {
    const ty = TYPES[c.type];
    return { name: c.name, type: c.type, kind: ty ? ty[0] : null, oledb: ty ? ty[1] : null, size: c.size, required: !c.nullable, auto: !!(c.autoLong || c.autoUUID), writable: !!ty && !c.autoLong && !c.autoUUID };
  });
  const texts = columns.filter((c) => c.writable && (c.kind === 'text')).map((c) => c.name);
  const counts = Object.fromEntries(texts.map((n) => [n, new Map()]));
  const data = texts.length ? t.getData({ columns: texts }) : [];
  for (const row of data) for (const n of texts) { const v = row[n]; if (v === null || v === undefined || String(v).trim() === '') continue; const k = String(v).trim(); counts[n].set(k, (counts[n].get(k) || 0) + 1); }
  // suggestions only for columns that repeat (types, materials…), not ones every row has its own of (names, refs)
  const suggestions = {};
  for (const n of texts) { const m = counts[n]; if (!m.size || m.size > Math.max(60, data.length * 0.5)) continue; suggestions[n] = [...m].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([v]) => v); }
  return { table: name, rows: t.rowCount, columns, suggestions };
}

// a value from the form, as the column takes it (or an error)
function clean(col, raw) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { value: null };
  const v = typeof raw === 'string' ? raw.trim() : raw;
  switch (col.kind) {
    case 'text': case 'memo': {
      const s = String(v); const max = col.kind === 'text' ? Math.max(1, Math.floor((col.size || 510) / 2)) : 65000; // (Access counts a text field's size in bytes, 2 a character)
      return s.length > max ? { error: `${col.name} takes at most ${max} characters` } : { value: s };
    }
    case 'boolean': return { value: v === true || /^(1|true|yes|y|ja|oui)$/i.test(String(v)) };
    case 'integer': { const n = Number(String(v).replace(',', '.')); const r = RANGE[col.type]; if (!Number.isInteger(n) || (r && (n < r[0] || n > r[1]))) return { error: `${col.name} is a whole number${r ? ` from ${r[0]} to ${r[1]}` : ''}` }; return { value: n }; }
    case 'number': { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? { value: n } : { error: `${col.name} is a number` }; }
    case 'date': { const d = new Date(v); return Number.isNaN(d.getTime()) ? { error: `${col.name} is a date` } : { value: d.toISOString().slice(0, 19) }; }
    default: return { error: `${col.name} can't be written from SITHUB` };
  }
}
// the form's values checked against the table: { fields: [{ name, oledb, value }], errors: [] }
function prepare(schema, values, keyCol) {
  const fields = []; const errors = [];
  for (const c of schema.columns) {
    if (!c.writable) continue;
    const r = clean(c, values?.[c.name]);
    if (r.error) { errors.push(r.error); continue; }
    if (r.value === null) { if (c.required || c.name === keyCol) errors.push(`${c.name} is needed`); continue; }
    fields.push({ name: c.name, oledb: c.oledb, value: r.value });
  }
  return { fields, errors };
}

// ---- writing through the Access Database Engine (PowerShell + System.Data.OleDb) ----------------------
const PS = String.raw`param([string]$In)
$ErrorActionPreference = 'Stop'
$p = Get-Content -Raw -Encoding UTF8 -LiteralPath $In | ConvertFrom-Json
$out = [ordered]@{ ok = $false; bits = [IntPtr]::Size * 8 }
$conn = $null
function Q([string]$n) { '[' + $n.Replace(']', ']]') + ']' }
function V($f) {
  if ($null -eq $f.value) { return [DBNull]::Value }
  switch ($f.oledb) {
    'Date' { return [datetime]::Parse([string]$f.value, [Globalization.CultureInfo]::InvariantCulture) }
    'Boolean' { return [bool]$f.value }
    'Double' { return [double]$f.value } 'Single' { return [single]$f.value } 'Currency' { return [decimal]$f.value } 'Decimal' { return [decimal]$f.value }
    'Integer' { return [int]$f.value } 'SmallInt' { return [int16]$f.value } 'UnsignedTinyInt' { return [byte]$f.value } 'BigInt' { return [int64]$f.value }
    default { return [string]$f.value }
  }
}
function P($cmd, $f) { $x = $cmd.CreateParameter(); $x.OleDbType = [System.Data.OleDb.OleDbType]::($f.oledb); $x.Value = (V $f); [void]$cmd.Parameters.Add($x) }
try {
  $last = ''
  foreach ($pv in @('Microsoft.ACE.OLEDB.16.0', 'Microsoft.ACE.OLEDB.12.0')) {
    try { $c = New-Object System.Data.OleDb.OleDbConnection("Provider=$pv;Data Source=$($p.file);Mode=ReadWrite;Persist Security Info=False;"); $c.Open(); $conn = $c; $out.provider = $pv; break }
    catch { $last = $_.Exception.Message }
  }
  if ($null -eq $conn) { throw "NOENGINE: $last" }
  $tx = $conn.BeginTransaction()
  $t = Q $p.table
  if ($p.mode -eq 'test') {
    $cmd = $conn.CreateCommand(); $cmd.Transaction = $tx
    $cmd.CommandText = "UPDATE $t SET $(Q $p.key) = $(Q $p.key) WHERE 1 = 0"
    [void]$cmd.ExecuteNonQuery()
    $cnt = $conn.CreateCommand(); $cnt.Transaction = $tx; $cnt.CommandText = "SELECT COUNT(*) FROM $t"; $out.rows = [int]$cnt.ExecuteScalar()
    $tx.Rollback(); $out.ok = $true
  } else {
    $kf = $p.fields | Where-Object { $_.name -eq $p.key } | Select-Object -First 1
    $chk = $conn.CreateCommand(); $chk.Transaction = $tx; $chk.CommandText = "SELECT COUNT(*) FROM $t WHERE $(Q $p.key) = ?"; P $chk $kf
    if ([int]$chk.ExecuteScalar() -gt 0) { $tx.Rollback(); throw "EXISTS: $($kf.value)" }
    $cmd = $conn.CreateCommand(); $cmd.Transaction = $tx
    $cmd.CommandText = "INSERT INTO $t ($(($p.fields | ForEach-Object { Q $_.name }) -join ', ')) VALUES ($(($p.fields | ForEach-Object { '?' }) -join ', '))"
    foreach ($f in $p.fields) { P $cmd $f }
    [void]$cmd.ExecuteNonQuery()
    $tx.Commit(); $out.ok = $true
  }
} catch { $out.error = $_.Exception.Message }
finally { if ($null -ne $conn) { $conn.Close() } }
$out | ConvertTo-Json -Compress`;

function runPs(exe, payload) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sithub-cards-'));
    const script = path.join(dir, 'write.ps1'); const input = path.join(dir, 'in.json');
    fs.writeFileSync(script, `\ufeff${PS}`); fs.writeFileSync(input, JSON.stringify(payload));
    execFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-In', input], { timeout: 90 * 1000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      fs.rmSync(dir, { recursive: true, force: true });
      const line = String(stdout || '').trim().split(/\r?\n/).pop();
      try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: (err && err.killed ? 'Access took too long to answer' : String(stderr || err?.message || stdout || 'no answer').trim()).slice(0, 500) }); }
    });
  });
}
// the 64-bit PowerShell, then the 32-bit one when the engine is the other bitness
async function viaEngine(payload) {
  if (process.env.CARDWRITE_TEST_LOG) { fs.appendFileSync(process.env.CARDWRITE_TEST_LOG, `${JSON.stringify(payload)}\n`); return { ok: true, provider: 'test', bits: 64, rows: 0 }; }
  if (process.platform !== 'win32') return { ok: false, error: 'Writing to an Access database needs SITHUB running on Windows (with the Access Database Engine)' };
  const root = process.env.SystemRoot || 'C:\\Windows';
  const tries = [path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), path.join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')].filter((f) => fs.existsSync(f));
  let r = { ok: false, error: 'PowerShell isn\'t there on this PC' };
  for (const exe of tries) { r = await runPs(exe, payload); if (r.ok || !/^NOENGINE/.test(String(r.error))) break; }
  return explain(r);
}
const ENGINE_URL = 'https://www.microsoft.com/en-us/download/details.aspx?id=54920';
function explain(r) {
  if (r.ok) return r;
  const e = String(r.error || '');
  if (/^NOENGINE/.test(e)) {
    if (/not registered/i.test(e)) return { ...r, error: 'The Access Database Engine isn\'t installed on the server (in 64 or 32 bits). Install Microsoft\'s free "Access Database Engine 2016 Redistributable" there (no Access needed), then test again.', engine_url: ENGINE_URL };
    return { ...r, error: `Access couldn't open the database: ${e.replace(/^NOENGINE:\s*/, '')}` };
  }
  if (/^EXISTS/.test(e)) return { ...r, error: `${e.replace(/^EXISTS:\s*/, '')} is already in the card database`, exists: true };
  if (/locked|in use|exclusive|could not use/i.test(e)) return { ...r, error: 'The database is locked (opened exclusively, or being saved): try again in a moment' };
  if (/read-only|updateable|permission|access is denied/i.test(e)) return { ...r, error: `The server can't write to the database: ${e}` };
  return r;
}

// a copy before writing, at most one an hour, the last 20 kept
function backup(file) {
  const dir = path.join(config.dataDir, 'card-db-backups');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(file).replace(/\.[^.]+$/, ''); const ext = path.extname(file);
  const stamp = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '');
  const target = path.join(dir, `${base}-${stamp}${ext}`);
  if (!fs.existsSync(target)) { fs.copyFileSync(file, target); log.info(`🗂 Card database copied before writing: ${target}`); }
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}-`)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 20))) fs.rmSync(path.join(dir, f), { force: true });
  return target;
}

const writable = (file) => /\.(accdb|mdb)$/i.test(String(file || ''));
async function test({ file, table, key }) {
  if (!writable(file)) return { ok: false, error: 'The card database is set to an Excel file: SITHUB can only add cards to an Access database (.accdb / .mdb)' };
  return viaEngine({ mode: 'test', file, table, key });
}
async function write({ file, table, key, fields }) {
  if (!writable(file)) return { ok: false, error: 'The card database is set to an Excel file: SITHUB can only add cards to an Access database (.accdb / .mdb)' };
  if (!process.env.CARDWRITE_TEST_LOG) backup(file);
  return viaEngine({ mode: 'insert', file, table, key, fields });
}

module.exports = { schemaNow, prepare, clean, test, write, writable, ENGINE_URL, PS };
