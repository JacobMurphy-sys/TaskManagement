// SQLite schema. Applied on every start-up (idempotent).
//
// Timestamps are stored as UTC ISO-8601 text, e.g. 2026-09-29T07:34:01.123Z,
// so they sort and compare correctly as plain strings. Triggers keep
// updated_at / completed_at current and write every change to audit_log,
// including edits made directly in DBeaver or any other SQLite tool.

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
// Columns added after the first release must be single-line definitions without
// UNIQUE/PRIMARY KEY, so existing databases can gain them with ALTER TABLE ADD COLUMN.

// Accepts only canonical UTC timestamps, so hand edits can't break date comparisons.
// (`IS`, not `=`: an unparseable value makes strftime() NULL, which `=` would let through.)
const isoCheck = (c) => `CHECK (${c} IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', ${c}) IS ${c})`;
const dateCheck = (c) => `CHECK (${c} IS NULL OR date(${c}) IS ${c})`;
const moneyCheck = (c) => `CHECK (${c} IS NULL OR (typeof(${c}) IN ('integer', 'real') AND ${c} >= 0))`;
const RECURRENCES = ['daily', 'weekdays', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly'];

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
    completed_at      TEXT,
    budget            REAL    ${moneyCheck('budget')},
    project_code      TEXT,
    sponsor           TEXT,
    leader            TEXT,
    policy_deployment TEXT,
    category          TEXT,
    gm_effect         TEXT,
    problem           TEXT,
    goals             TEXT,
    in_scope          TEXT,
    out_scope         TEXT,
    benefits_quantified TEXT,
    benefits_other    TEXT`,

  // Project charter: team members (with capacity) and improvement KPIs.
  project_team: `
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    role        TEXT,
    capacity    TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT    NOT NULL DEFAULT (${NOW}),
    contact     TEXT`,

  project_kpis: `
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    unit        TEXT,
    baseline    TEXT,
    target      TEXT,
    current     TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT    NOT NULL DEFAULT (${NOW})`,

  // Pick-lists for charter fields (managed on the Settings page).
  lookups: `
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    list        TEXT    NOT NULL CHECK (list IN ('category', 'policy_deployment')),
    name        TEXT    NOT NULL COLLATE NOCASE,
    active      INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT    NOT NULL DEFAULT (${NOW}),
    UNIQUE (list, name)`,

  // project_id is empty for standalone tasks (the "Tasks" area).
  // A project's internal split into phases / milestones (e.g. "Phase 1: pilot line").
  // Top-level tasks belong to at most one phase; subtasks follow their parent.
  project_phases: `
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    description     TEXT,
    status          TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    start_date      TEXT    ${dateCheck('start_date')},
    due_at          TEXT    ${isoCheck('due_at')},
    baseline_due_at TEXT    ${isoCheck('baseline_due_at')},
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at      TEXT    NOT NULL DEFAULT (${NOW}),
    completed_at    TEXT`,

  tasks: `
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
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
    completed_at TEXT,
    start_date   TEXT    ${dateCheck('start_date')},
    waiting_on   TEXT,
    waiting_since TEXT,
    recurrence   TEXT    CHECK (recurrence IS NULL OR recurrence IN (${RECURRENCES.map((r) => `'${r}'`).join(', ')})),
    next_task_id INTEGER,
    owner        TEXT,
    phase_id     INTEGER REFERENCES project_phases(id) ON DELETE SET NULL,
    meeting_id   INTEGER REFERENCES meetings(id) ON DELETE SET NULL`,

  // Gantt dependencies: task_id can't start until depends_on_id is finished.
  task_links: `
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at    TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at    TEXT    NOT NULL DEFAULT (${NOW}),
    UNIQUE (task_id, depends_on_id),
    CHECK (task_id <> depends_on_id)`,

  // Actual spend against a project's budget.
  project_costs: `
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    description TEXT    NOT NULL,
    amount      REAL    NOT NULL ${moneyCheck('amount')},
    spent_on    TEXT    ${dateCheck('spent_on')},
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT    NOT NULL DEFAULT (${NOW})`,

  // The additive "log as I go" notes on a project (optionally tied to a task).
  notes: `
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    body       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW})`,

  // Meetings on a project or on a task (task meetings also carry the task's project).
  // notes is a small, sanitised HTML subset (see richtext.js); agreed actions are
  // tasks with meeting_id set.
  meetings: `
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    title       TEXT    NOT NULL,
    held_at     TEXT    NOT NULL ${isoCheck('held_at')},
    location    TEXT,
    attendees   TEXT,
    notes       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT    NOT NULL DEFAULT (${NOW}),
    duration_min INTEGER NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 5 AND 1440)`,

  // Files attached to a task or a meeting. The file itself is DATA_DIR/attachments/<stored>
  // (mirrored into the backups folder); project_id follows the task or meeting.
  attachments: `
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    meeting_id  INTEGER REFERENCES meetings(id) ON DELETE CASCADE,
    project_id  INTEGER,
    name        TEXT    NOT NULL,
    stored      TEXT    NOT NULL,
    mime        TEXT,
    size        INTEGER,
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT    NOT NULL DEFAULT (${NOW})`,

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

  // Ideation: a lightweight ticket list. `ref` (IDEA-0001…) is assigned by trigger.
  areas: `
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    active     INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW})`,

  ideas: `
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ref          TEXT    UNIQUE,
    title        TEXT    NOT NULL,
    description  TEXT,
    submitted_by TEXT,
    area_id      INTEGER REFERENCES areas(id),
    priority     INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
    due_at       TEXT    ${isoCheck('due_at')},
    cost         REAL    CHECK (cost IS NULL OR (typeof(cost) IN ('integer', 'real') AND cost >= 0)),
    status       TEXT    NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'reviewing', 'approved', 'rejected', 'implemented', 'escalated')),
    project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,  -- set when escalated
    created_at   TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at   TEXT    NOT NULL DEFAULT (${NOW}),
    impact       INTEGER CHECK (impact IS NULL OR impact BETWEEN 1 AND 5),
    effort       INTEGER CHECK (effort IS NULL OR effort BETWEEN 1 AND 5)`,

  idea_notes: `
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_id    INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW})`,

  // Settings → People & departments: named lists (e.g. "People", "Departments",
  // "Maintenance crew") offered when picking task owners and meeting attendees.
  name_lists: `
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT    NOT NULL DEFAULT (${NOW})`,

  name_list_items: `
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id     INTEGER NOT NULL REFERENCES name_lists(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL COLLATE NOCASE,
    detail      TEXT,
    department  TEXT    COLLATE NOCASE,
    active      INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT    NOT NULL DEFAULT (${NOW}),
    UNIQUE (list_id, name)`,

  // Library: notes imported from an Obsidian vault (read-only in the app). Their
  // attachments are files in DATA_DIR/library. Not audited: an import replaces many
  // notes at once, and the vault is the record of their history.
  // Weekly KPI snapshots from the CI workbook: what the A3 and Database sheets showed
  // (view model, gzipped JSON in base64) and the disconnected A3 (zip in base64).
  // Not audited: a load replaces a whole week.
  // Weekly figures typed in for the KPIs (HR from Protime, complaints until the
  // Salesforce export is ready). protime: the Sun–Fri "present" counts hours came from.
  kpi_manual: `
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    week        TEXT    NOT NULL COLLATE NOCASE,
    hours       REAL,
    protime     TEXT,
    contract    REAL,
    temps       REAL,
    cc_critical INTEGER,
    cc_major    INTEGER,
    cc_minor    INTEGER,
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT    NOT NULL DEFAULT (${NOW}),
    UNIQUE (week)`,

  kpi_snapshots: `
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    week            TEXT    NOT NULL COLLATE NOCASE,
    year            INTEGER,
    month           TEXT,
    source_name     TEXT,
    source_modified TEXT,
    model           TEXT    NOT NULL,
    pkg             TEXT    NOT NULL,
    exported_at     TEXT,
    exported_to     TEXT,
    origin          TEXT,
    created_at      TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at      TEXT    NOT NULL DEFAULT (${NOW}),
    UNIQUE (week)`,

  library_docs: `
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    folder      TEXT    NOT NULL DEFAULT '',
    body        TEXT    NOT NULL,
    tags        TEXT,
    aliases     TEXT,
    imported_at TEXT    NOT NULL DEFAULT (${NOW}),
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT    NOT NULL DEFAULT (${NOW}),
    UNIQUE (path)`,

  settings: `
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT    NOT NULL UNIQUE,
    value      TEXT,
    created_at TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW})`,

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
  CREATE INDEX IF NOT EXISTS audit_changed_idx ON audit_log(changed_at);
  CREATE INDEX IF NOT EXISTS ideas_status_idx  ON ideas(status);
  CREATE INDEX IF NOT EXISTS ideas_area_idx    ON ideas(area_id);
  CREATE INDEX IF NOT EXISTS idea_notes_idx    ON idea_notes(idea_id, created_at);
  CREATE INDEX IF NOT EXISTS tasks_waiting_idx ON tasks(waiting_on) WHERE waiting_on IS NOT NULL;
  CREATE INDEX IF NOT EXISTS task_links_task_idx ON task_links(task_id);
  CREATE INDEX IF NOT EXISTS task_links_dep_idx  ON task_links(depends_on_id);
  CREATE INDEX IF NOT EXISTS project_costs_idx ON project_costs(project_id, spent_on);

  CREATE INDEX IF NOT EXISTS project_team_idx  ON project_team(project_id, sort_order);
  CREATE INDEX IF NOT EXISTS project_kpis_idx  ON project_kpis(project_id, sort_order);
  CREATE INDEX IF NOT EXISTS project_phases_idx ON project_phases(project_id, sort_order);
  CREATE INDEX IF NOT EXISTS tasks_phase_idx   ON tasks(phase_id);
  CREATE INDEX IF NOT EXISTS tasks_meeting_idx ON tasks(meeting_id);
  CREATE INDEX IF NOT EXISTS attachments_task_idx ON attachments(task_id);
  CREATE INDEX IF NOT EXISTS attachments_meeting_idx ON attachments(meeting_id);
  CREATE INDEX IF NOT EXISTS meetings_project_idx ON meetings(project_id, held_at);
  CREATE INDEX IF NOT EXISTS meetings_task_idx ON meetings(task_id);
  CREATE INDEX IF NOT EXISTS meetings_held_idx ON meetings(held_at);

  -- Default project ID (editable), like ideas' references.
  DROP TRIGGER IF EXISTS projects_code;
  CREATE TRIGGER projects_code AFTER INSERT ON projects WHEN NEW.project_code IS NULL
  BEGIN UPDATE projects SET project_code = 'PRJ-' || printf('%04d', NEW.id) WHERE id = NEW.id; END;

  -- Gives every idea a permanent, human-friendly reference, even if added in DBeaver.
  DROP TRIGGER IF EXISTS ideas_ref;
  CREATE TRIGGER ideas_ref AFTER INSERT ON ideas WHEN NEW.ref IS NULL
  BEGIN UPDATE ideas SET ref = 'IDEA-' || printf('%04d', NEW.id) WHERE id = NEW.id; END;

  -- A starting area on a brand-new database (only ever once).
  INSERT INTO areas (name) SELECT 'General'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'areas_seeded') AND NOT EXISTS (SELECT 1 FROM areas);
  INSERT OR IGNORE INTO settings (key, value) VALUES ('areas_seeded', '1');

  -- Two starting name lists (only ever once; they can be renamed or deleted).
  INSERT INTO name_lists (name, sort_order) SELECT 'People', 0
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'name_lists_seeded') AND NOT EXISTS (SELECT 1 FROM name_lists);
  INSERT INTO name_lists (name, sort_order) SELECT 'Departments', 1
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'name_lists_seeded') AND (SELECT count(*) FROM name_lists) = 1;
  INSERT OR IGNORE INTO settings (key, value) VALUES ('name_lists_seeded', '1');
  CREATE INDEX IF NOT EXISTS library_title_idx ON library_docs(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS name_list_items_idx ON name_list_items(list_id, sort_order);`;

// Status value that means "finished", and the column stamped when it is reached.
const DONE = {
  projects: ['completed', 'completed_at'],
  tasks: ['done', 'completed_at'],
  project_phases: ['done', 'completed_at'],
  reminders: ['dismissed', 'dismissed_at'],
};
const AUTO_COLUMNS = ['id', 'ref', 'created_at', 'updated_at', 'completed_at', 'dismissed_at', 'waiting_since', 'next_task_id'];
const JSON_COLUMNS = ['baseline_snapshot'];

// Column definitions of a table: [{ name, sql }] (sql is the single-line definition).
const columnDefs = (table) => TABLES[table].split('\n')
  .map((l) => l.trim().replace(/\s*--.*$/, '').replace(/,$/, ''))
  .filter((l) => /^[a-z_]+\s+[A-Z]/.test(l))
  .map((l) => ({ name: l.split(/\s+/)[0], sql: l }));
const columnsOf = (table) => columnDefs(table).map((c) => c.name);

function triggerSql(table) {
  const cols = columnsOf(table);
  const tracked = cols.filter((c) => !AUTO_COLUMNS.includes(c));
  const obj = (rec) => `json_object(${cols.map((c) => `'${c}', ${JSON_COLUMNS.includes(c) ? `json(${rec}.${c})` : `${rec}.${c}`}`).join(', ')})`;
  const projectId = (rec) => {
    if (table === 'projects') return `${rec}.id`;
    return cols.includes('project_id') ? `${rec}.project_id` : 'NULL';
  };
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

const DATA_TABLES = ['projects', 'tasks', 'notes', 'reminders', 'areas', 'ideas', 'idea_notes', 'settings',
  'task_links', 'project_costs', 'project_team', 'project_kpis', 'lookups', 'project_phases', 'meetings', 'name_lists', 'name_list_items', 'attachments', 'kpi_manual'];

const tablesSql = () => Object.entries(TABLES).map(([t, body]) => `CREATE TABLE IF NOT EXISTS ${t} (${body}\n);`).join('\n');
const triggersSql = () => [...DATA_TABLES.map(triggerSql), INDEXES].join('\n');

// Tables whose existing NOT NULL constraints differ from the definition (SQLite can
// only change those by rebuilding the table).
function tablesToRebuild(existingInfo) {
  return Object.keys(TABLES).filter((t) => existingInfo[t]?.length && columnDefs(t).some((c) => {
    const ex = existingInfo[t].find((i) => i.name === c.name);
    return ex && !!ex.notnull !== /\bNOT NULL\b/i.test(c.sql);
  }));
}
const createTableSql = (t, name = t) => `CREATE TABLE ${name} (${TABLES[t]}\n);`;

// ALTER TABLE statements for columns an older database doesn't have yet.
function addColumnsSql(existing) {
  return Object.keys(TABLES).flatMap((t) => columnDefs(t)
    .filter((c) => existing[t] && !existing[t].includes(c.name))
    .map((c) => `ALTER TABLE ${t} ADD COLUMN ${c.sql};`));
}

function dropTriggersSql() {
  return DATA_TABLES.flatMap((t) => ['audit_insert', 'audit_update', 'audit_delete', 'stamp', 'stamp_insert']
    .map((s) => `DROP TRIGGER IF EXISTS ${t}_${s};`)).concat('DROP TRIGGER IF EXISTS ideas_ref;', 'DROP TRIGGER IF EXISTS projects_code;').join('\n');
}

module.exports = {
  tablesSql, triggersSql, addColumnsSql, dropTriggersSql, tablesToRebuild, createTableSql, columnsOf,
  TABLE_NAMES: Object.keys(TABLES), JSON_COLUMNS, RECURRENCES,
};
