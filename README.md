# Task Manager

A personal project & task management system that runs on your own PC.
It uses **Node.js** for the app and **PostgreSQL** for the data (you can browse and edit the data in pgAdmin or DBeaver).

| Spec item | How it's covered |
|---|---|
| Baseline + quick additive updates | New projects take a list of **baseline tasks**; the plan is frozen ("baseline") and anything added later is flagged **+ added**. The baseline panel shows tasks added/removed since then and how far the due date has slipped. A **quick-note bar** on every project (and a global **Quick note** button, key `N`) appends time-stamped notes as you go. |
| Fully date & time stamped | Every record has `created_at` / `updated_at` / `completed_at` (with time zone), maintained by the database itself. |
| Full logging | Every insert/update/delete on every table is written to `audit_log` **by database triggers**, including edits made directly in pgAdmin / DBeaver / Access. See it in **Activity log**, per project in the **Timeline**, and per task under **History**. The server also writes daily log files to `logs/`. |
| Backups | Automatic backups at start-up and every 24h (configurable): a **JSON export** of every table, plus a native **pg_dump** file if `pg_dump` is available (pgAdmin includes one). Old backups are pruned (keeps 30). **Back up now** button in the app, and a restore script. |
| Priority & due dates | Low / Medium / High / Critical, and due date + time on projects and tasks. Overdue and due-soon items are highlighted. |
| Pop-up reminders & alerts | Set reminders on tasks or projects (quick buttons: 15 min, 1 h, next workday 9:00…). When one is due you get an in-app pop-up with a sound, plus a **Windows desktop notification** once enabled. Pop-ups offer Snooze / Dismiss / Open. Tasks that are overdue or due within 15 min also pop up automatically. |
| Kanban view | To do / In progress / Blocked / Done columns with drag & drop, filter by project, optional subtasks. |
| Tick-box tasks & subtasks | Checklist with unlimited nested subtasks. Ticking a parent offers to tick its open subtasks too. |

Also included: a dashboard (overdue, due today, next 7 days, high priority, reminders, latest notes), search across projects/tasks/notes, and a layout that works on narrow screens.

---

## 1. One-time setup (Windows)

**Prerequisites:** Node.js 18 or newer, and a PostgreSQL server you can connect to. If pgAdmin already connects to a server (e.g. `localhost:5432`), use that one.

1. **Get the code** into a folder, e.g. `C:\TaskManager`.
2. **Configure:** copy `.env.example` to `.env` and set `PGUSER` / `PGPASSWORD` (and `PGHOST` / `PGPORT` if they aren't the defaults) to the login you use in pgAdmin.
3. **Install and create the database.** Open a terminal in the folder (in VS Code: *Terminal → New Terminal*) and run:
   ```
   npm install
   npm run init-db
   ```
   `init-db` creates a database called `taskmgr` and its tables. Running it again is safe.
4. **Start the app:**
   ```
   npm start
   ```
   Then open <http://localhost:3000>. You can also double-click **`start.bat`**, which installs dependencies if needed, starts the server and opens the browser.
5. **Enable desktop alerts:** click **🔔 Enable desktop alerts** in the top bar and allow notifications. Reminders only fire while the app is open in a browser tab, so keep it pinned in Edge or Chrome.

### Start automatically when you log in (optional)
Press `Win+R`, type `shell:startup`, and put a shortcut to `start.bat` in the folder that opens.

---

## 2. Everyday use

- **New project:** click **+ New** in the sidebar. List the baseline tasks one per line. The baseline is set automatically.
- **Add a note as you go:** type in the bar at the top of the project and press **Enter**. Notes are time-stamped. To attach a note to a specific task, pick the task in the drop-down first.
- **Add a task:** type in the *Add a task…* box and press **Enter**. Shortcuts you can include in the text:
  - `!low` `!high` `!crit` sets the priority
  - `@today` `@tomorrow` `@fri` `@2026-10-31` `@2026-10-31T09:30` sets the due date (17:00 if no time is given)

  For example, `Send board pack !high @thu`.
- **Subtasks:** hover over a task and click **＋ sub**, or open the task and use *Add subtask*.
- **Task details:** click a task title to edit its description, status, priority and due date (changes save automatically), and to add subtasks, reminders and notes or see its history.
- **Re-baseline:** use this after an agreed change of scope. All current tasks become the new baseline.
- **Keyboard:** `N` quick note, `T` add task (in a project), `/` search.
- **Archive rather than delete:** set a finished project's status to *Archived* to hide it. **Show archived** in the sidebar brings it back.

---

## 3. Backups & restore

- Backups are written to `backups/json/` (always) and `backups/pgdump/` (when pg_dump is found). The server looks for pg_dump on PATH, in `C:\Program Files\PostgreSQL\*\bin` and in pgAdmin's `runtime` folder. You can also set `PG_DUMP_PATH` in `.env`.
- **Take a backup now:** the **Backups** page, or `npm run backup`.
- **Restore from JSON:** `npm run restore -- backups\json\taskmgr-YYYYMMDD-HHMMSS.json`. It asks you to confirm, then takes a safety backup of the current data before replacing it. Run `npm run restore` with no file to list the available backups.
- **Restore a `.dump` file:** in pgAdmin, right-click the database and choose **Restore…**, or use `pg_restore`.
- **Tip:** set `BACKUP_DIR` in `.env` to a OneDrive or network folder so the backups are kept off your PC.

## 4. Working with the data directly

The database is plain PostgreSQL, so pgAdmin and DBeaver work as normal:

| Table | Contents |
|---|---|
| `projects` | Projects, including baseline date, baseline due date and a JSON `baseline_snapshot` |
| `tasks` | Tasks; `parent_id` links subtasks, `is_baseline` marks original-plan tasks |
| `notes` | The additive, time-stamped notes |
| `reminders` | Pending and dismissed reminders |
| `audit_log` | Every change: old and new values as JSON, when, and which DB user |

**Microsoft Access / Excel:** install the *psqlODBC* driver (available through the PostgreSQL *Stack Builder*), create an ODBC data source for `taskmgr`, then use *External Data → New Data Source → From Other Sources → ODBC* to link the tables for queries and reports. Edits made that way are captured in the audit log too.

## 5. Configuration (`.env`)

| Setting | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Where the app listens. Keeping `127.0.0.1` means only your own PC can reach it. |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | `localhost` `5432` `taskmgr` `postgres` – | Database connection |
| `BACKUP_DIR` | `./backups` | Where backups go |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between automatic backups (`0` turns them off) |
| `BACKUP_KEEP` | `30` | Number of backups of each type to keep |
| `PG_DUMP_PATH` | auto-detect | Full path to `pg_dump.exe` |
| `LOG_DIR` | `./logs` | Daily log files |

## 6. Project layout

```
db/schema.sql        tables, timestamp and audit triggers (applied automatically at start-up)
src/server.js        web server entry point
src/api.js           REST API (/api/...)
src/backup.js        JSON + pg_dump backups and schedule
public/              the web UI (plain HTML/CSS/JS, no build step)
scripts/             init-db, backup, restore, smoke-test
start.bat            double-click launcher for Windows
```

`npm test` runs an end-to-end smoke test against the database configured in `.env`. It creates a temporary project and deletes it afterwards.
