# Task Manager

A personal project & task management system that runs on your own PC.

It needs nothing except **Node.js**. The data is kept in a single **SQLite** database file (`data/taskmgr.db`) using the SQLite engine built into Node, so there is no database server to install or run. You can open that file in **DBeaver** to browse, query or edit the data.

| Spec item | How it's covered |
|---|---|
| Baseline + quick additive updates | New projects take a list of **baseline tasks**; the plan is frozen ("baseline") and anything added later is flagged **+ added**. The baseline panel shows tasks added/removed since then and how far the due date has slipped. A **quick-note bar** on every project (and a global **Quick note** button, key `N`) appends time-stamped notes as you go. |
| Fully date & time stamped | Every record has `created_at` / `updated_at` / `completed_at` (with time zone), maintained by the database itself. |
| Full logging | Every insert/update/delete on every table is written to `audit_log` **by database triggers**, so edits made directly in DBeaver are recorded too. See it in **Activity log**, per project in the **Timeline**, and per task under **History**. The server also writes daily log files to `logs/`. |
| Backups | Automatic backups at start-up and every 24h (configurable): a complete copy of the **database file** (safe to take while the app is running) plus a **JSON export** of every table. Old backups are pruned (keeps 30). **Back up now** button in the app, and a restore script. |
| Priority & due dates | Low / Medium / High / Critical, and due date + time on projects and tasks. Overdue and due-soon items are highlighted. |
| Pop-up reminders & alerts | Set reminders on tasks or projects (quick buttons: 15 min, 1 h, next workday 9:00…). When one is due you get an in-app pop-up with a sound, plus a **Windows desktop notification** once enabled. Pop-ups offer Snooze / Dismiss / Open. Tasks that are overdue or due within 15 min also pop up automatically. |
| Kanban view | To do / In progress / Blocked / Done columns with drag & drop, filter by project, optional subtasks. |
| Tick-box tasks & subtasks | Checklist with unlimited nested subtasks. Ticking a parent offers to tick its open subtasks too. |

Also included: a dashboard (overdue, due today, next 7 days, high priority, reminders, latest notes), search across projects/tasks/notes, and a layout that works on narrow screens.

---

## 1. One-time setup (Windows)

**Prerequisite:** Node.js **22.13 or newer**. Check your version with `node -v`. If yours is older, install the current LTS from <https://nodejs.org> (the Windows installer doesn't need admin rights if you choose *Install for me only*). No database server is needed.

1. **Get the code** into a folder, e.g. `C:\TaskManager`.
2. **Install and start:** double-click **`start-hidden.vbs`**. It installs dependencies the first time (you'll see a window for that), then starts the app in the background with **no console window** and opens <http://localhost:3000>. Double-clicking it again while the app is running just opens the browser.
   - **To stop it:** click **⏻ Stop server** at the bottom of the sidebar, or double-click **`stop-server.vbs`**.
   - **`start.bat`** does the same but keeps a console window open that shows the log. Use it if something isn't working. Closing that window stops the app.
   - Or, from a terminal in the folder (in VS Code: *Terminal → New Terminal*):
   ```
   npm install
   npm start
   ```
   The database file `data\taskmgr.db` is created automatically on first start.
3. **Enable desktop alerts:** click **🔔 Enable desktop alerts** in the top bar and allow notifications. Reminders only fire while the app is open in a browser tab, so keep it pinned in Edge or Chrome.
4. *(Optional)* To change the port, database location or backup settings, copy `.env.example` to `.env` and edit it.

### Start automatically when you log in (optional)
Press `Win+R`, type `shell:startup`, and put a shortcut to **`start-hidden.vbs`** in the folder that opens (right-click the file → *Show more options* → *Create shortcut*, then move the shortcut). The app then starts silently at log-in and opens in your browser.

> If Windows reports that VBScript isn't available (Microsoft is gradually retiring it; it's still installed by default on Windows 10 and 11), use `start.bat` instead.

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

- Each backup writes a database copy to `backups/db/` and a JSON export to `backups/json/`.
- **Take a backup now:** the **Backups** page, or `npm run backup`.
- **Restore:** `npm run restore -- backups\db\taskmgr-YYYYMMDD-HHMMSS.db` (a `.json` backup works too). It asks you to confirm, then takes a safety backup of the current data before replacing it. Run `npm run restore` with no file to list the available backups. It's best to stop the app first.
- A backup `.db` file is a normal database, so you can also just open it in DBeaver to look something up without restoring.
- **Tip:** set `BACKUP_DIR` in `.env` to a OneDrive or network folder so the backups are kept off your PC.

## 4. Working with the data directly (DBeaver)

In DBeaver: *Database → New Database Connection → SQLite*, and pick `data\taskmgr.db` as the path. DBeaver offers to download the SQLite driver the first time. You can do this while the app is running.

| Table | Contents |
|---|---|
| `projects` | Projects, including baseline date, baseline due date and a JSON `baseline_snapshot` |
| `tasks` | Tasks; `parent_id` links subtasks, `is_baseline` (1/0) marks original-plan tasks |
| `notes` | The additive, time-stamped notes |
| `reminders` | Pending and dismissed reminders |
| `audit_log` | Every change, with old and new values as JSON and when it happened |

**Dates and times** are stored as UTC text in the form `2026-10-31T17:00:00.000Z` (note the trailing `Z`: UTC, not local time). The database rejects anything in another format, so hand edits can't break sorting or the due-date alerts. You don't need to set `updated_at`, `completed_at` or the audit log yourself; the triggers handle them.

**Microsoft Access / Excel (optional):** install the free *SQLite ODBC driver* (by Christian Werner). Then use *External Data → New Data Source → From Other Sources → ODBC* and link the tables for queries and reports. Edits made that way are captured in the audit log too.

## 5. Configuration (`.env`)

| Setting | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Where the app listens. Keeping `127.0.0.1` means only your own PC can reach it. |
| `DB_FILE` | `./data/taskmgr.db` | The database file |
| `BACKUP_DIR` | `./backups` | Where backups go |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between automatic backups (`0` turns them off) |
| `BACKUP_KEEP` | `30` | Number of backups of each type to keep |
| `LOG_DIR` | `./logs` | Daily log files |

## 6. Project layout

```
src/schema.js        tables, timestamp and audit triggers (applied automatically at start-up)
src/db.js            SQLite connection (Node's built-in node:sqlite)
src/server.js        web server entry point
src/api.js           REST API (/api/...)
src/backup.js        database-file + JSON backups and schedule
public/              the web UI (plain HTML/CSS/JS, no build step)
scripts/             init-db, backup, restore, smoke-test
start-hidden.vbs     double-click launcher for Windows (no console window)
stop-server.vbs      stops the background app
start.bat            launcher that keeps a console window with the log
```

`npm test` runs an end-to-end smoke test using a temporary database, so your real data is never touched.
