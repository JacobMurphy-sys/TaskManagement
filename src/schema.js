// SQLite schema. Applied on every start-up (idempotent).
//
// Timestamps are stored as UTC ISO-8601 text, e.g. 2026-09-29T07:34:01.123Z,
// so they sort and compare correctly as plain strings. Triggers keep
// updated_at / completed_at current and write every change to audit_log,
// including edits made directly in DBeaver or any other SQLite tool.

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
// Accepts only canonical UTC timestamps, so hand edits can't break date comparisons.
// (`IS`, not `=`: an unparseable value makes strftime() NULL, which `=` would let through.)
const isoCheck = (c) => `CHECK (${c} IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', ${c}) IS ${c})`;

const TABLES = {
  projects: `
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    description       TEXT,
    status            TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'on_hold', 'completed', 'archived')),
    priority          INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
    start_date        TEXT    CHECK (start_date IS NULL OR date(start_date) IS start_date),
    due_at            TEXT    ${isoCheck('due_at')},
    baseline_set_at   TEXT,
    baseline_due_at   TEXT,
    baseline_snapshot TEXT,   -- JSON: the plan as it was when the baseline was set
    created_at        TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at        TEXT    NOT NULL DEFAULT (${NOW}),
    completed_at      TEXT`,

  tasks: `
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    title        TEXT    NOT NULL,
    description  TEXT,
    status       TEXT    NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
    priority     INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
    due_at       TEXT    ${isoCheck('due_at')},
    is_baseline  INTEGER NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at   TEXT    NOT NULL DEFAULT (${NOW}),
    completed_at TEXT`,

  // The additive "log as I go" notes on a project (optionally tied to a task).
  notes: `
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    body       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW})`,

  reminders: `
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    task_id      INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    remind_at    TEXT    NOT NULL ${isoCheck('remind_at')},
    message      TEXT,
    status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dismissed')),
    snooze_count INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at   TEXT    NOT NULL DEFAULT (${NOW}),
    dismissed_at TEXT`,

  audit_log: `
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id  INTEGER,
    project_id INTEGER,
    action     TEXT NOT NULL,          -- INSERT / UPDATE / DELETE
    old_data   TEXT,                   -- JSON
    new_data   TEXT,                   -- JSON
    changed_at TEXT NOT NULL DEFAULT (${NOW})`,
};

const INDEXES = `
  CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS tasks_parent_idx  ON tasks(parent_id);
  CREATE INDEX IF NOT EXISTS tasks_due_idx     ON tasks(due_at);
  CREATE INDEX IF NOT EXISTS notes_project_idx ON notes(project_id, created_at);
  CREATE INDEX IF NOT EXISTS notes_task_idx    ON notes(task_id);
  CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(status, remind_at);
  CREATE INDEX IF NOT EXISTS reminders_task_idx ON reminders(task_id);
  CREATE INDEX IF NOT EXISTS audit_project_idx ON audit_log(project_id, changed_at);
  CREATE INDEX IF NOT EXISTS audit_record_idx  ON audit_log(table_name, record_id);
  CREATE INDEX IF NOT EXISTS audit_changed_idx ON audit_log(changed_at);`;

// Status value that means "finished", and the column stamped when it is reached.
const DONE = {
  projects: ['completed', 'completed_at'],
  tasks: ['done', 'completed_at'],
  reminders: ['dismissed', 'dismissed_at'],
};
const AUTO_COLUMNS = ['id', 'created_at', 'updated_at', 'completed_at', 'dismissed_at'];
const JSON_COLUMNS = ['baseline_snapshot'];

const columnsOf = (table) => TABLES[table].split('\n')
  .map((l) => l.trim().match(/^([a-z_]+)\s+[A-Z]/)).filter(Boolean).map((m) => m[1]);

function triggerSql(table) {
  const cols = columnsOf(table);
  const tracked = cols.filter((c) => !AUTO_COLUMNS.includes(c));
  const obj = (rec) => `json_object(${cols.map((c) => `'${c}', ${JSON_COLUMNS.includes(c) ? `json(${rec}.${c})` : `${rec}.${c}`}`).join(', ')})`;
  const projectId = (rec) => (table === 'projects' ? `${rec}.id` : `${rec}.project_id`);
  const audit = (action, oldRec, newRec, rec) => `INSERT INTO audit_log (table_name, record_id, project_id, action, old_data, new_data)
      VALUES ('${table}', ${rec}.id, ${projectId(rec)}, '${action}', ${oldRec ? obj(oldRec) : 'NULL'}, ${newRec ? obj(newRec) : 'NULL'});`;
  const [doneStatus, doneCol] = DONE[table] || [];
  const doneSet = doneCol
    ? `, ${doneCol} = CASE WHEN NEW.status = '${doneStatus}' THEN coalesce(NEW.${doneCol}, ${NOW}) ELSE NULL END`
    : '';

  return `
    DROP TRIGGER IF EXISTS ${table}_audit_insert;
    CREATE TRIGGER ${table}_audit_insert AFTER INSERT ON ${table}
    BEGIN ${audit('INSERT', null, 'NEW', 'NEW')} END;

    DROP TRIGGER IF EXISTS ${table}_audit_update;
    CREATE TRIGGER ${table}_audit_update AFTER UPDATE ON ${table}
    WHEN ${tracked.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')}
    BEGIN ${audit('UPDATE', 'OLD', 'NEW', 'NEW')} END;

    DROP TRIGGER IF EXISTS ${table}_audit_delete;
    CREATE TRIGGER ${table}_audit_delete AFTER DELETE ON ${table}
    BEGIN ${audit('DELETE', 'OLD', null, 'OLD')} END;

    -- Keeps updated_at (and completed_at / dismissed_at) current on every edit.
    DROP TRIGGER IF EXISTS ${table}_stamp;
    CREATE TRIGGER ${table}_stamp AFTER UPDATE ON ${table}
    WHEN NEW.updated_at IS OLD.updated_at
    BEGIN UPDATE ${table} SET updated_at = ${NOW}${doneSet} WHERE id = NEW.id; END;
    ${doneCol ? `
    DROP TRIGGER IF EXISTS ${table}_stamp_insert;
    CREATE TRIGGER ${table}_stamp_insert AFTER INSERT ON ${table}
    WHEN NEW.status = '${doneStatus}' AND NEW.${doneCol} IS NULL
    BEGIN UPDATE ${table} SET ${doneCol} = ${NOW} WHERE id = NEW.id; END;` : ''}`;
}

const DATA_TABLES = ['projects', 'tasks', 'notes', 'reminders'];

function schemaSql() {
  return [
    ...Object.entries(TABLES).map(([t, body]) => `CREATE TABLE IF NOT EXISTS ${t} (${body}\n);`),
    INDEXES,
    ...DATA_TABLES.map(triggerSql),
  ].join('\n');
}

function dropTriggersSql() {
  return DATA_TABLES.flatMap((t) => ['audit_insert', 'audit_update', 'audit_delete', 'stamp', 'stamp_insert']
    .map((s) => `DROP TRIGGER IF EXISTS ${t}_${s};`)).join('\n');
}

module.exports = { schemaSql, dropTriggersSql, TABLE_NAMES: Object.keys(TABLES), JSON_COLUMNS };
