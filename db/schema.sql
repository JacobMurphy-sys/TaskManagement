-- Task Management schema. Idempotent: safe to run on every start-up.
-- Every table is time-stamped (timestamptz) and every change to it is
-- recorded in audit_log by trigger, including edits made directly in
-- pgAdmin / DBeaver / Access.

-- ---------------------------------------------------------------- tables

CREATE TABLE IF NOT EXISTS projects (
    id                serial PRIMARY KEY,
    name              text        NOT NULL,
    description       text,
    status            text        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'on_hold', 'completed', 'archived')),
    priority          smallint    NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
    start_date        date,
    due_at            timestamptz,
    -- Baseline: the original plan, frozen when "Set baseline" is used.
    baseline_set_at   timestamptz,
    baseline_due_at   timestamptz,
    baseline_snapshot jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    completed_at      timestamptz
);

CREATE TABLE IF NOT EXISTS tasks (
    id           serial PRIMARY KEY,
    project_id   integer     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id    integer     REFERENCES tasks(id) ON DELETE CASCADE,
    title        text        NOT NULL,
    description  text,
    status       text        NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
    priority     smallint    NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
    due_at       timestamptz,
    is_baseline  boolean     NOT NULL DEFAULT false,
    sort_order   integer     NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_parent_idx  ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS tasks_due_idx     ON tasks(due_at) WHERE status <> 'done';

-- Notes are the additive "log as I go" entries on a project (optionally tied to a task).
CREATE TABLE IF NOT EXISTS notes (
    id         serial PRIMARY KEY,
    project_id integer     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id    integer     REFERENCES tasks(id) ON DELETE SET NULL,
    body       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_project_idx ON notes(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reminders (
    id           serial PRIMARY KEY,
    project_id   integer     REFERENCES projects(id) ON DELETE CASCADE,
    task_id      integer     REFERENCES tasks(id) ON DELETE CASCADE,
    remind_at    timestamptz NOT NULL,
    message      text,
    status       text        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'dismissed')),
    snooze_count integer     NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    dismissed_at timestamptz
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(remind_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS audit_log (
    id         bigserial PRIMARY KEY,
    table_name text        NOT NULL,
    record_id  integer,
    project_id integer,
    action     text        NOT NULL,          -- INSERT / UPDATE / DELETE
    old_data   jsonb,
    new_data   jsonb,
    changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    db_user    text        NOT NULL DEFAULT current_user
);
CREATE INDEX IF NOT EXISTS audit_project_idx ON audit_log(project_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS audit_changed_idx ON audit_log(changed_at DESC);

-- ---------------------------------------------------------------- triggers

-- Maintains updated_at and completed_at.
CREATE OR REPLACE FUNCTION tm_stamp() RETURNS trigger AS $$
DECLARE
    done_status text := CASE TG_TABLE_NAME WHEN 'projects' THEN 'completed' ELSE 'done' END;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        NEW.updated_at := now();
    END IF;
    IF TG_TABLE_NAME IN ('projects', 'tasks') THEN
        IF NEW.status = done_status AND (TG_OP = 'INSERT' OR OLD.status <> done_status) THEN
            NEW.completed_at := now();
        ELSIF NEW.status <> done_status THEN
            NEW.completed_at := NULL;
        END IF;
    END IF;
    IF TG_TABLE_NAME = 'reminders' THEN
        IF NEW.status = 'dismissed' AND NEW.dismissed_at IS NULL THEN
            NEW.dismissed_at := now();
        ELSIF NEW.status = 'pending' THEN
            NEW.dismissed_at := NULL;
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Writes every change to audit_log.
CREATE OR REPLACE FUNCTION tm_audit() RETURNS trigger AS $$
DECLARE
    rec jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
        RETURN NULL; -- nothing actually changed
    END IF;
    INSERT INTO audit_log (table_name, record_id, project_id, action, old_data, new_data)
    VALUES (
        TG_TABLE_NAME,
        (rec->>'id')::integer,
        CASE WHEN TG_TABLE_NAME = 'projects' THEN (rec->>'id')::integer
             ELSE (rec->>'project_id')::integer END,
        TG_OP,
        CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
        CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
    );
    RETURN NULL;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['projects', 'tasks', 'notes', 'reminders'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I_stamp ON %I', t, t);
        EXECUTE format('CREATE TRIGGER %I_stamp BEFORE INSERT OR UPDATE ON %I
                        FOR EACH ROW EXECUTE FUNCTION tm_stamp()', t, t);
        EXECUTE format('DROP TRIGGER IF EXISTS %I_audit ON %I', t, t);
        EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                        FOR EACH ROW EXECUTE FUNCTION tm_audit()', t, t);
    END LOOP;
END $$;
