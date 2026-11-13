// SQLite access using Node's built-in node:sqlite module (no install needed).
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');
const {
  tablesSql, triggersSql, addColumnsSql, dropTriggersSql, tablesToRebuild, createTableSql, columnsOf, TABLE_NAMES,
} = require('./schema');

// node:sqlite prints an "experimental" warning on load; it's stable enough for this use.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite')) return;
  emitWarning.call(process, warning, ...rest);
};

let sqlite;
try {
  sqlite = require('node:sqlite');
} catch {
  console.error(`\nThis app needs Node.js 22.13 or newer (it uses Node's built-in SQLite). You have ${process.version}.\n` +
    'Install the current LTS version from https://nodejs.org and try again.\n');
  process.exit(1);
}

// The person and browser behind the current request (set per request by the server).
const { AsyncLocalStorage } = require('async_hooks');
const actorStore = new AsyncLocalStorage();
const actor = () => actorStore.getStore() || null;
const asActor = (who, fn) => actorStore.run(who, fn);

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new sqlite.DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return conn;
}

// One-off move of a database from the old location inside the app folder.
function migrateLegacyData() {
  const { legacy, dbFile, backup } = config;
  if (legacy.dbFile && !fs.existsSync(dbFile) && fs.existsSync(legacy.dbFile)) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    // VACUUM INTO also folds in anything still in the -wal file.
    const old = new sqlite.DatabaseSync(legacy.dbFile);
    old.prepare('VACUUM INTO ?').run(dbFile);
    old.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(legacy.dbFile + suffix)) fs.renameSync(legacy.dbFile + suffix, `${legacy.dbFile}${suffix}.migrated`);
    }
    log.info(`Moved database from ${legacy.dbFile} to ${dbFile}`);
  }
  if (legacy.backupDir && !fs.existsSync(backup.dir) && fs.existsSync(legacy.backupDir)) {
    fs.cpSync(legacy.backupDir, backup.dir, { recursive: true });
    log.info(`Copied backups from ${legacy.backupDir} to ${backup.dir}`);
  }
}
migrateLegacyData();

const live = open(config.dbFile);
// 🎓 Training: a copy of the live database that a training account works in (accounts.js). A request
// runs against one connection or the other (db.inTraining); everything here uses the current one.
const connStore = new AsyncLocalStorage();
const cur = () => connStore.getStore() || live;
const TRAINING_FILE = path.join(path.dirname(config.dbFile), `${path.basename(config.dbFile, '.db')}-training.db`);
let trainingConn = null;

// node:sqlite accepts only null/number/bigint/string/buffer parameters.
const param = (v) => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
};

const caches = new WeakMap(); // prepared statements, per connection
function stmt(sql) {
  const c = cur(); let cache = caches.get(c); if (!cache) { cache = new Map(); caches.set(c, cache); }
  const sq = mainWrites(sql);
  if (touchesShadow(sq)) syncViewer(c);
  let s = cache.get(sq);
  if (!s) { s = c.prepare(sq); cache.set(sq, s); }
  return s;
}

// ---- 🔒 who sees what (visibility.js) ------------------------------------------------------------
// With accounts on, each request runs as its account (asViewer): on every connection, temporary views named like the
// tables (tasks, projects, notes …) shadow them, so every query sees only what that account may (the sets worked
// out by visibility.js, in temporary tables). Writes go to the real tables (main.…), where temporary triggers skip
// an update or delete of a row the account can't see (the route then says it's not found) and refuse a new one
// under a task or project it can't see. No account (accounts off, background jobs, backups: asSystem): all of it.
const viewerStore = new AsyncLocalStorage();
const asViewer = (v, fn) => viewerStore.run(v || null, fn);
const asSystem = (fn) => viewerStore.run(null, fn);
const viewer = () => viewerStore.getStore() || null;
const SHADOWED = ['tasks', 'projects', 'notes', 'reminders', 'capex', 'project_costs', 'project_team', 'project_kpis', 'project_phases', 'task_links', 'attachments', 'audit_log'];
const SHADOW_RE = new RegExp(`\\b(${SHADOWED.join('|')})\\b`, 'i');
const touchCache = new Map();
const touchesShadow = (sql) => { let t = touchCache.get(sql); if (t === undefined) { t = SHADOW_RE.test(sql); if (touchCache.size < 5000) touchCache.set(sql, t); } return t; };
// a write names the real table (an unqualified name would be the view)
// (anywhere in the statement: a write can start with a WITH … clause)
const WRITE_TARGET = new RegExp(`(\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+)(${SHADOWED.join('|')})\\b`, 'gi');
const mainWrites = (sql) => sql.replace(WRITE_TARGET, '$1main.$2');
const STAMPED = /^\s*INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(?:main\.)?(tasks|projects|notes|reminders|capex)\b/i; // made by the request's account
const WATCH = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:main\.)?(tasks|projects|project_team|shares|name_list_items|capex|org_links)\b/i; // changes who sees what
const ANY_WRITE = /\b(?:INSERT|REPLACE|UPDATE|DELETE)\b/i;
let dataVersion = 0; // goes up with every change to what decides visibility
const visCache = new Map(); // `${key}|${version}` → sets (the last few)
const shadowed = new WeakSet();
const shadowState = new WeakMap(); // connection → { key, version }
const ALL_SQL = '(SELECT allv FROM temp.vis_who)';
function ensureShadow(c) {
  if (shadowed.has(c)) return;
  const inT = 'IN (SELECT id FROM temp.vis_t)'; const inP = 'IN (SELECT id FROM temp.vis_p)';
  const acc = '(SELECT acc FROM temp.vis_who)'; const fa = '(SELECT fa FROM temp.vis_who)';
  const childOfP = (t) => `CREATE TEMP VIEW ${t} AS SELECT * FROM main.${t} WHERE ${ALL_SQL} OR project_id ${inP};`;
  const guardP = (t) => ['UPDATE', 'DELETE'].map((op) => `CREATE TEMP TRIGGER g_${t}_${op[0]} BEFORE ${op} ON main.${t} WHEN NOT ${ALL_SQL} AND OLD.project_id NOT ${inP} BEGIN SELECT RAISE(IGNORE); END;`).join('\n')
    + `\nCREATE TEMP TRIGGER g_${t}_i BEFORE INSERT ON main.${t} WHEN NOT ${ALL_SQL} AND NEW.project_id NOT ${inP} BEGIN SELECT RAISE(ABORT, 'Project not found'); END;`;
  c.exec(`
    CREATE TEMP TABLE IF NOT EXISTS vis_who (allv INTEGER NOT NULL, acc INTEGER, fa INTEGER);
    CREATE TEMP TABLE IF NOT EXISTS vis_t (id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS vis_p (id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS vis_c (id INTEGER PRIMARY KEY);
    DELETE FROM temp.vis_who; INSERT INTO temp.vis_who VALUES (1, NULL, NULL);
    CREATE TEMP VIEW tasks AS SELECT * FROM main.tasks WHERE ${ALL_SQL} OR id ${inT};
    CREATE TEMP VIEW projects AS SELECT * FROM main.projects WHERE ${ALL_SQL} OR id ${inP};
    CREATE TEMP VIEW notes AS SELECT * FROM main.notes WHERE ${ALL_SQL} OR (CASE WHEN task_id IS NOT NULL THEN task_id ${inT} WHEN project_id IS NOT NULL THEN project_id ${inP} ELSE coalesce(created_by, ${fa}) = ${acc} END);
    CREATE TEMP VIEW capex AS SELECT * FROM main.capex WHERE ${ALL_SQL} OR id IN (SELECT id FROM temp.vis_c);
    ${['UPDATE', 'DELETE'].map((op) => `CREATE TEMP TRIGGER g_capex_${op[0]} BEFORE ${op} ON main.capex WHEN NOT ${ALL_SQL} AND OLD.id NOT IN (SELECT id FROM temp.vis_c) BEGIN SELECT RAISE(IGNORE); END;`).join('\n')}
    CREATE TEMP VIEW reminders AS SELECT * FROM main.reminders WHERE ${ALL_SQL} OR coalesce(created_by, ${fa}) = ${acc};
    ${['project_costs', 'project_team', 'project_kpis', 'project_phases'].map(childOfP).join('\n')}
    CREATE TEMP VIEW task_links AS SELECT * FROM main.task_links WHERE ${ALL_SQL} OR (task_id ${inT} AND depends_on_id ${inT});
    CREATE TEMP VIEW attachments AS SELECT * FROM main.attachments WHERE ${ALL_SQL} OR (CASE WHEN task_id IS NOT NULL THEN task_id ${inT} WHEN project_id IS NOT NULL THEN project_id ${inP} ELSE 1 END);
    CREATE TEMP VIEW audit_log AS SELECT * FROM main.audit_log WHERE ${ALL_SQL} OR (CASE table_name WHEN 'tasks' THEN record_id ${inT} WHEN 'projects' THEN record_id ${inP}
      WHEN 'notes' THEN record_id IN (SELECT id FROM temp.notes) WHEN 'reminders' THEN record_id IN (SELECT id FROM temp.reminders)
      WHEN 'task_links' THEN record_id IN (SELECT id FROM temp.task_links) WHEN 'attachments' THEN record_id IN (SELECT id FROM temp.attachments)
      ELSE project_id IS NULL OR project_id ${inP} END);
    ${['UPDATE', 'DELETE'].map((op) => `CREATE TEMP TRIGGER g_tasks_${op[0]} BEFORE ${op} ON main.tasks WHEN NOT ${ALL_SQL} AND OLD.id NOT ${inT} BEGIN SELECT RAISE(IGNORE); END;`).join('\n')}
    CREATE TEMP TRIGGER g_tasks_i BEFORE INSERT ON main.tasks WHEN NOT ${ALL_SQL} AND NEW.parent_id IS NOT NULL AND NEW.parent_id NOT ${inT} BEGIN SELECT RAISE(ABORT, 'Task not found'); END;
    ${['UPDATE', 'DELETE'].map((op) => `CREATE TEMP TRIGGER g_projects_${op[0]} BEFORE ${op} ON main.projects WHEN NOT ${ALL_SQL} AND OLD.id NOT ${inP} BEGIN SELECT RAISE(IGNORE); END;`).join('\n')}
    ${['UPDATE', 'DELETE'].map((op) => `CREATE TEMP TRIGGER g_notes_${op[0]} BEFORE ${op} ON main.notes WHEN NOT ${ALL_SQL} AND OLD.id NOT IN (SELECT id FROM temp.notes) BEGIN SELECT RAISE(IGNORE); END;`).join('\n')}
    CREATE TEMP TRIGGER g_notes_i BEFORE INSERT ON main.notes WHEN NOT ${ALL_SQL} AND ((NEW.task_id IS NOT NULL AND NEW.task_id NOT ${inT}) OR (NEW.task_id IS NULL AND NEW.project_id IS NOT NULL AND NEW.project_id NOT ${inP})) BEGIN SELECT RAISE(ABORT, 'Not found'); END;
    ${['UPDATE', 'DELETE'].map((op) => `CREATE TEMP TRIGGER g_reminders_${op[0]} BEFORE ${op} ON main.reminders WHEN NOT ${ALL_SQL} AND coalesce(OLD.created_by, ${fa}) IS NOT ${acc} AND NOT coalesce(OLD.task_id ${inT} OR OLD.project_id ${inP}, 0) BEGIN SELECT RAISE(IGNORE); END;`).join('\n')}
    CREATE TEMP TRIGGER g_reminders_i BEFORE INSERT ON main.reminders WHEN NOT ${ALL_SQL} AND ((NEW.task_id IS NOT NULL AND NEW.task_id NOT ${inT}) OR (NEW.project_id IS NOT NULL AND NEW.project_id NOT ${inP})) BEGIN SELECT RAISE(ABORT, 'Not found'); END;
    ${['project_costs', 'project_team', 'project_kpis', 'project_phases'].map(guardP).join('\n')}
    CREATE TEMP TRIGGER g_task_links_i BEFORE INSERT ON main.task_links WHEN NOT ${ALL_SQL} AND (NEW.task_id NOT ${inT} OR NEW.depends_on_id NOT ${inT}) BEGIN SELECT RAISE(ABORT, 'Task not found'); END;
    CREATE TEMP TRIGGER g_task_links_d BEFORE DELETE ON main.task_links WHEN NOT ${ALL_SQL} AND OLD.task_id NOT ${inT} BEGIN SELECT RAISE(IGNORE); END;
    CREATE TEMP TRIGGER g_attachments_i BEFORE INSERT ON main.attachments WHEN NOT ${ALL_SQL} AND NEW.task_id IS NOT NULL AND NEW.task_id NOT ${inT} BEGIN SELECT RAISE(ABORT, 'Task not found'); END;
    ${['UPDATE', 'DELETE'].map((op) => `CREATE TEMP TRIGGER g_attachments_${op[0]} BEFORE ${op} ON main.attachments WHEN NOT ${ALL_SQL} AND OLD.task_id IS NOT NULL AND OLD.task_id NOT ${inT} BEGIN SELECT RAISE(IGNORE); END;`).join('\n')}
  `);
  shadowed.add(c); shadowState.set(c, { key: 'ALL', version: -1 });
  caches.delete(c); // statements made before read the tables: made again, they read the views
}
// off again (migrating: creating indexes and columns needs the real tables under their own names)
function dropShadow(c) {
  if (!shadowed.has(c)) return;
  for (const r of c.prepare("SELECT type, name FROM temp.sqlite_master WHERE type IN ('view', 'trigger')").all()) c.exec(`DROP ${r.type.toUpperCase()} IF EXISTS temp.${r.name}`);
  shadowed.delete(c); shadowState.delete(c); caches.delete(c);
}
// the request's account's sets into this connection's temporary tables (when they've changed)
function syncViewer(c) {
  if (!shadowed.has(c)) return;
  const v = viewer(); const st = shadowState.get(c);
  const key = v && v.id && !v.all ? `a${v.id}|${String(v.person || '').toLowerCase()}` : 'ALL';
  if (key === 'ALL') { if (st.key !== 'ALL') { c.prepare('UPDATE temp.vis_who SET allv = 1').run(); st.key = 'ALL'; } return; }
  if (st.key === key && st.version === dataVersion) return;
  const ck = `${key}|${dataVersion}`; let sets = visCache.get(ck);
  if (!sets) {
    sets = require('./visibility').compute(c, v);
    visCache.set(ck, sets); if (visCache.size > 50) visCache.delete(visCache.keys().next().value);
  }
  const fa = c.prepare("SELECT min(id) AS id FROM main.accounts WHERE role = 'admin'").get()?.id ?? null;
  c.prepare('UPDATE temp.vis_who SET allv = 1').run(); // filling the sets themselves isn't watched
  c.prepare('DELETE FROM temp.vis_t').run(); c.prepare('DELETE FROM temp.vis_p').run();
  const it = c.prepare('INSERT INTO temp.vis_t (id) VALUES (?)'); for (const id of sets.tasks) it.run(id);
  const ip = c.prepare('INSERT INTO temp.vis_p (id) VALUES (?)'); for (const id of sets.projects) ip.run(id);
  c.prepare('DELETE FROM temp.vis_c').run(); const ic = c.prepare('INSERT INTO temp.vis_c (id) VALUES (?)'); for (const id of sets.capex) ic.run(id);
  c.prepare('UPDATE temp.vis_who SET allv = 0, acc = ?, fa = ?').run(Number(v.id), fa);
  st.key = key; st.version = dataVersion;
}
// what the current account sees: { tasks, full, projects } (null: everything)
function visibleNow() {
  const v = viewer(); if (!v || !v.id || v.all) return null;
  const c = cur(); ensureShadow(c); syncViewer(c);
  return visCache.get(`${shadowState.get(c).key}|${dataVersion}`) || null;
}

// Who made a change: the audit log's triggers record what changed; a write made for a request
// then stamps the rows it added with the request's person and browser (db.asActor). It happens
// in the same step as the write (node:sqlite is synchronous), so no other request's rows can get
// in between — and the triggers stay plain SQL, so edits made in DBeaver still work.
const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
function stamped(sql, fn) {
  const a = actor();
  if (!a || !(a.who || a.client) || !WRITE.test(sql)) return fn();
  const before = stmt('SELECT coalesce(max(id), 0) AS m FROM main.audit_log').get().m;
  const out = fn();
  stmt('UPDATE main.audit_log SET changed_by = ?, client_id = ? WHERE id > ? AND client_id IS NULL AND changed_by IS NULL').run(a.who ?? null, a.client ?? null, before);
  return out;
}
// 🔒 a new task, project, note or reminder is the request's account's (created_by); a change to what decides who sees
// what makes the sets be worked out again
function owned(sql, fn) {
  if (!ANY_WRITE.test(sql)) return fn();
  const v = viewer(); const m = STAMPED.exec(sql); const c = cur();
  const before = m && v?.id ? c.prepare(`SELECT coalesce(max(id), 0) AS m FROM main.${m[1]}`).get().m : null;
  let out;
  try { out = fn(); } finally { if (WATCH.test(sql)) dataVersion++; }
  if (before !== null) {
    const allv = shadowed.has(c) ? c.prepare('SELECT allv FROM temp.vis_who').get().allv : 1;
    if (shadowed.has(c)) c.prepare('UPDATE temp.vis_who SET allv = 1').run(); // stamping its own new row
    try { c.prepare(`UPDATE main.${m[1]} SET created_by = ? WHERE id > ? AND created_by IS NULL`).run(Number(v.id), before); } finally { if (shadowed.has(c)) c.prepare('UPDATE temp.vis_who SET allv = ?').run(allv); }
    dataVersion++;
  }
  return out;
}
const all = (sql, params = []) => stamped(sql, () => owned(sql, () => stmt(sql).all(...params.map(param)).map((r) => ({ ...r }))));
const get = (sql, params = []) => stamped(sql, () => owned(sql, () => { const r = stmt(sql).get(...params.map(param)); return r ? { ...r } : undefined; }));
const run = (sql, params = []) => stamped(sql, () => owned(sql, () => stmt(sql).run(...params.map(param))));

// Runs fn() inside a transaction.
function tx(fn) {
  const conn = cur();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    const st = shadowState.get(conn); if (st) { st.key = null; dataVersion++; } // the sets may have been rolled back too
    throw err;
  }
}

// One-off data changes, each recorded in settings so it runs only once. Triggers are
// dropped while they run so they don't bump updated_at or flood the audit log.
const DATA_MIGRATIONS = {
  // 🌳 the 👔 Manager ticks become the management tree: each ticked manager at the top, their department's people under them
  org_from_manager_ticks() {
    let ticked = []; try { ticked = all("SELECT DISTINCT name, department FROM name_list_items WHERE manager = 1 AND department IS NOT NULL"); } catch { return; }
    const placed = new Set(all('SELECT person FROM org_links').map((r) => r.person.toLowerCase()));
    const put = (person, manager) => { if (placed.has(person.toLowerCase()) || (manager && person.toLowerCase() === manager.toLowerCase())) return; run('INSERT INTO org_links (person, manager) VALUES (?, ?)', [person, manager]); placed.add(person.toLowerCase()); };
    for (const m of ticked) put(m.name, null);
    for (const m of ticked) for (const p of all('SELECT DISTINCT name FROM name_list_items WHERE department = ? AND manager = 0', [m.department])) put(p.name, m.name);
  },
  // ⏱ Production runs were kept one per job, machine and start: report rows sharing those were folded into
  // one (losing their cards). The table is rebuilt without that, and every report read again in full.
  prod_runs_every_row() {
    const conn = cur();
    const cols = all('PRAGMA table_info(prod_runs)').map((c) => c.name).filter((c) => c !== 'id');
    conn.exec(createTableSql('prod_runs', 'prod_runs__new'));
    conn.exec(`INSERT INTO prod_runs__new (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM prod_runs`);
    conn.exec('DROP TABLE prod_runs');
    conn.exec('ALTER TABLE prod_runs__new RENAME TO prod_runs');
    run("DELETE FROM settings WHERE key LIKE 'prod\\_seen\\_%' ESCAPE '\\'");
  },
  // Existing projects get a default project ID (new ones get it by trigger).
  project_codes() {
    run("UPDATE projects SET project_code = 'PRJ-' || printf('%04d', id) WHERE project_code IS NULL");
  },
  // Due dates became whole days: move any stored time to the end of that local day.
  due_dates_end_of_day() {
    const endOfDay = (iso) => {
      const d = new Date(iso);
      d.setHours(23, 59, 59, 999);
      return d.toISOString();
    };
    for (const [table, cols] of [['tasks', ['due_at']], ['ideas', ['due_at']], ['projects', ['due_at', 'baseline_due_at']]]) {
      for (const col of cols) {
        for (const r of all(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`)) {
          const v = endOfDay(r.v);
          if (v !== r.v) run(`UPDATE ${table} SET ${col} = ? WHERE id = ?`, [v, r.id]);
        }
      }
    }
  },
};

// Rebuilds tables whose NOT NULL constraints changed (e.g. tasks.project_id became
// optional for standalone tasks), following SQLite's documented procedure:
// foreign keys off, copy into a new table, swap, then verify every reference.
// A copy of the database is saved first.
function rebuildTables() {
  const conn = cur();
  const info = Object.fromEntries(TABLE_NAMES.map((t) => [t, all(`PRAGMA table_info(${t})`)]));
  const tables = tablesToRebuild(info);
  if (!tables.length) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const safety = path.join(config.backup.dir, 'db', `pre-upgrade-${stamp}.db`);
  fs.mkdirSync(path.dirname(safety), { recursive: true });
  conn.prepare('VACUUM INTO ?').run(safety);
  log.info(`Upgrading tables ${tables.join(', ')}; copy of the database saved first`, safety);
  conn.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(() => {
      conn.exec(dropTriggersSql());
      for (const t of tables) {
        const old = info[t].map((c) => c.name);
        const cols = columnsOf(t).filter((c) => old.includes(c)).join(', ');
        const seq = get('SELECT seq FROM sqlite_sequence WHERE name = ?', [t]);
        conn.exec(createTableSql(t, `${t}__new`));
        conn.exec(`INSERT INTO ${t}__new (${cols}) SELECT ${cols} FROM ${t}`);
        conn.exec(`DROP TABLE ${t}`);
        conn.exec(`ALTER TABLE ${t}__new RENAME TO ${t}`);
        if (seq) {
          if (!run('UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?', [seq.seq, t]).changes) {
            run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [t, seq.seq]);
          }
        }
      }
      const broken = all('PRAGMA foreign_key_check');
      if (broken.length) throw new Error(`Upgrade stopped: ${broken.length} broken references (nothing was changed)`);
    });
  } finally {
    conn.exec('PRAGMA foreign_keys = ON');
  }
}

function migrate() {
  const conn = cur();
  dropShadow(conn); // back at the end
  tx(() => conn.exec(tablesSql()));
  rebuildTables();
  tx(() => {
    const existing = Object.fromEntries(TABLE_NAMES.map((t) => [t, all(`PRAGMA table_info(${t})`).map((c) => c.name)]));
    for (const sql of addColumnsSql(existing)) {
      conn.exec(sql);
      log.info(`Database upgraded: ${sql}`);
    }
    conn.exec(triggersSql());
    const done = new Set(all("SELECT key FROM settings WHERE key LIKE 'migration:%'").map((r) => r.key));
    const pending = Object.keys(DATA_MIGRATIONS).filter((name) => !done.has(`migration:${name}`));
    if (!pending.length) return;
    conn.exec(dropTriggersSql());
    for (const name of pending) {
      DATA_MIGRATIONS[name]();
      run("INSERT INTO settings (key, value) VALUES (?, datetime('now'))", [`migration:${name}`]);
    }
    conn.exec(triggersSql());
  });
  // 🔒 work from before accounts: credited to whoever the history says added it (visibility.js); the triggers are off
  // meanwhile, so it isn't a change anyone made (no history entry, no new "updated")
  let dropped = false;
  try {
    const n = require('./visibility').backfill(conn, () => { conn.exec(dropTriggersSql()); dropped = true; });
    if (n) log.info(`Who made what: ${n} older items credited to their makers' accounts`);
  } catch (err) { log.warn('Crediting older work to its makers', err.message); } finally { if (dropped) conn.exec(triggersSql()); }
  ensureShadow(conn); // 🔒 from here on, its queries go through the views (who sees what)
}

// ---- 🎓 the training copy ----------------------------------------------------------------------
// Made from live (VACUUM INTO) the first time it's needed and whenever it's reset, without anyone's own
// work (clearPersonal); brought up to date with the code like the live database.
function freshTraining() {
  if (trainingConn) { try { trainingConn.close(); } catch { /* closed */ } trainingConn = null; }
  const tmp = `${TRAINING_FILE}.new`;
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  vacuumInto(tmp, config.dbFile);
  for (const f of [TRAINING_FILE, `${TRAINING_FILE}-wal`, `${TRAINING_FILE}-shm`]) fs.rmSync(f, { force: true });
  fs.renameSync(tmp, TRAINING_FILE);
  trainingConn = open(TRAINING_FILE);
  connStore.run(trainingConn, () => { migrate(); clearPersonal(); });
  setTrainingMeta();
  log.info('Training copy made from live');
  return trainingConn;
}
// What the training copy leaves out: everyone's own work and messages, and the history of who changed what. It
// keeps the site's data to practise on: planning and its history, the reports, OTD, quality and EHS, capacity,
// contacts and lists, settings and the Library. (Sign-ins aren't kept either: they're only checked on live.)
const TRAINING_EMPTY = ['task_links', 'reminders', 'reschedules', 'attachments', 'project_costs', 'project_team', 'project_kpis', 'project_phases', 'tasks', 'projects',
  'notes', 'meetings', 'idea_notes', 'ideas', 'capex', 'tickets', 'messages', 'people_focus', 'cpm_scenarios', 'task_list_items', 'task_lists', 'shares', 'sessions', 'audit_log'];
function clearPersonal() {
  const c = cur();
  dropShadow(c); // the triggers go back on the real tables
  c.exec('PRAGMA foreign_keys = OFF');
  try {
    c.exec(dropTriggersSql());
    for (const t of TRAINING_EMPTY) { try { c.exec(`DELETE FROM main.${t}`); } catch { /* not there */ } }
    try { c.exec(`DELETE FROM sqlite_sequence WHERE name IN (${TRAINING_EMPTY.map((t) => `'${t}'`).join(',')})`); } catch { /* none */ }
    c.exec(triggersSql());
  } finally { c.exec('PRAGMA foreign_keys = ON'); ensureShadow(c); }
}
const metaOf = (c) => { try { return c.prepare("SELECT value FROM settings WHERE key = 'training_copied_at'").get()?.value || null; } catch { return null; } };
function setTrainingMeta() { trainingConn.prepare("INSERT INTO settings (key, value) VALUES ('training_copied_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString()); }
function training() {
  if (trainingConn) return trainingConn;
  if (!fs.existsSync(TRAINING_FILE)) return freshTraining();
  trainingConn = open(TRAINING_FILE);
  connStore.run(trainingConn, () => migrate());
  return trainingConn;
}
const asTraining = (fn) => connStore.run(training(), fn);
// a copy of the current database (live, or the training copy) through a connection of its own: VACUUM INTO on one
// with the 🔒 views would try to index them
function vacuumInto(target, file = trainingConn && cur() === trainingConn ? TRAINING_FILE : config.dbFile) {
  const c = new sqlite.DatabaseSync(file);
  try { c.exec('PRAGMA busy_timeout = 5000'); c.prepare('VACUUM INTO ?').run(target); } finally { c.close(); }
}
const asLive = (fn) => connStore.run(live, fn);
const inTraining = () => !!trainingConn && connStore.getStore() === trainingConn;
const trainingInfo = () => { if (!trainingConn && !fs.existsSync(TRAINING_FILE)) return { exists: false, copied_at: null }; return { exists: true, copied_at: metaOf(training()) }; };

module.exports = {
  get conn() { return cur(); }, // the current connection: live, or the training copy for a training account's request
  asViewer, asSystem, viewer, visibleNow, vacuumInto, shadow: () => ensureShadow(cur()),
  all, get, run, tx, migrate, open, asActor, actor, asTraining, asLive, inTraining, resetTraining: freshTraining, ensureTraining: () => { training(); }, trainingInfo, TRAINING_FILE,
};
