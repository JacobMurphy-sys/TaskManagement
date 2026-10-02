# CI Manager

A personal project & task management system that runs on your own PC.

It needs nothing except **Node.js**. The data is kept in a single **SQLite** database file using the SQLite engine built into Node, so there is no database server to install or run. You can open that file in **DBeaver** to browse, query or edit the data.

**Your data lives outside the app folder**, in `%LOCALAPPDATA%\CIManager` (i.e. `C:\Users\<you>\AppData\Local\CIManager`), which holds `taskmgr.db`, `backups\` and `logs\`. Updating, re-cloning or deleting the app folder never touches it. The **Backups** page in the app shows the exact path.

| Spec item | How it's covered |
|---|---|
| Projects with a charter | Every project has a **📋 Charter** tab laid out like the standard project template: problem definition, goals, team (with capacity), in / out of scope, quantified and non-quantified benefits, sponsor, leader, current date, policy deployment, category, gross margin effect, project ID, improvement KPIs and a milestone plan (the project's top-level tasks with baseline, planned and actual dates). Title, problem, goals, sponsor and leader are required to create a project; a **% complete** indicator nudges you to finish the rest. **⬇ Charter (Excel)** fills in your own Excel template. |
| Standalone tasks | **✅ Tasks** holds ad-hoc work that doesn't need a project: quick add, subtasks, notes, due dates, reminders, repeats, waiting-on, list or board. Move a task into a project from its task window, or **🚀 promote** it to a project of its own (which asks for the charter). |
| Baseline + quick additive updates | New projects take a list of **baseline tasks**; the plan is frozen ("baseline") and anything added later is flagged **+ added**. The baseline panel shows tasks added/removed since then and how far the due date has slipped. A **quick-note bar** on every project appends time-stamped notes as you go. The global **Quick note** button (key `N`) needs no project: add the note to an **existing task** (standalone or in a project, with a filter box), start a **new task** with it (title defaults to the note's first line and understands `!high @fri *weekly`; project optional), or put it on a **project**. `[ ]` lines in a note on a task become its subtasks. |
| Fully date & time stamped | Every record has `created_at` / `updated_at` / `completed_at` (with time zone), maintained by the database itself. |
| Full logging | Every insert/update/delete on every table is written to `audit_log` **by database triggers**, so edits made directly in DBeaver are recorded too. See it in **Activity log**, per project in the **Timeline**, and per task under **History**. The server also writes daily log files to the `logs` folder in your data folder. |
| Backups | Automatic backups at start-up and every 24h (configurable): a complete copy of the **database file** (safe to take while the app is running) plus a **JSON export** of every table. Old backups are pruned (keeps 30). **Back up now** and **Restore** buttons in the app (plus a restore script). |
| Priority & due dates | Low / Medium / High / Critical, and a due **date** on projects, tasks and ideas (something is overdue once its due day has passed). Overdue and due-today/tomorrow items are highlighted. The exact time everything was created or changed is still recorded for the logs. |
| Pop-up reminders & alerts | Set reminders on tasks or projects (quick buttons: 15 min, 1 h, next workday 9:00…). When one is due you get an in-app pop-up with a sound, plus a **Windows desktop notification** once enabled. Pop-ups offer Snooze / Dismiss / Open. Tasks that are overdue or due within 15 min also pop up automatically. |
| Several owners · 📇 Contacts | A task (or a meeting action) can have **several owners** — people, departments or both — shown as chips. Type to get matching suggestions, or click **📇** to open the **contacts book**: one searchable window with the project's team, every contacts list and names used before, each with its role or details; tick several and press Done (you can also use a name that isn't in your contacts). Meeting **attendees**, **＋ Add person** on a project team and the **charter's people fields** (management sponsor, project leader, the team table, and the team box when creating a project) use the same book: typing suggests contacts with their role, 📇 opens the book, and picking a team member fills in their role from their contact details. Owners are stored as `Sam Patel, Maintenance`, so exports, reports and the charter show them all, and each person's open-task count includes tasks they share. The **📇 Contacts** page (sidebar) holds as many named lists as you like (*People* and *Departments* to start), each name with optional details; search them, add names one at a time or **paste several** (one per line), untick **Active** to stop offering a name. Names are fixed text; **✎ Rename** changes a name everywhere it's used (task and action owners — open and done — meeting attendees, project teams, leaders and sponsors), so renaming never breaks a link. It also lists everyone on a project team with their projects, with ＋ to add them to a list. |
| Departments | Each person in a contacts list can have a **Department**, chosen from the list called *Departments* (one each; departments you untick as inactive stop being offered but stay on the people who have them, and a department can't be removed while anyone is in it; the *Departments* list itself can't be renamed or deleted). The contacts book and typed suggestions show it next to the name — *Sam Patel · Maintenance · Fitter* — and searching for a department finds its people. When choosing meeting **attendees**, a department offers **＋ everyone in Maintenance** to add all its people at once. On the 📇 Contacts page, filter by department (or *No department*); the Departments list shows how many people are in each and their **open tasks**, counting tasks the department owns plus those its people own. Renaming a department moves everyone in it. Project team members pick up their department when their name matches a contact; it shows on the 👥 team panel, on the Contacts page and in the **Team** sheet of the Excel export. |
| Light / dark mode | The **Dark** switch in the top bar flips between light and dark; the choice is remembered. ⚙ Settings → *Appearance* can also set it back to **Automatic** (follow Windows). |
| Reorder & rename in lists | In any task list (a project's tasks, the ✅ Tasks page, and the subtasks in a task window) **drag the ⠿ handle** to put tasks or subtasks in order — they only move within their own list — or focus the handle and use **↑ / ↓**. **Double-click a title** (or use ✎) to rename it in place: Enter saves, Esc cancels; a single click still opens the task. The order is kept everywhere the list appears, including the charter timeline. |
| 📚 Library (Obsidian) | Your instructions and procedures from an **Obsidian vault**, read-only and kept with their folders and formatting. **📥 Import Obsidian vault…** → choose the vault folder; every note is copied in with images, PDFs and other attachments (Obsidian's settings, plugins and trash are skipped; the vault itself is never changed). Shown as in Obsidian's reading view: headings, bold/italic/~~strike~~/==highlight==, nested and numbered lists, `- [ ]` checklists, tables, quotes and `> [!warning]` **callouts** (coloured, foldable), code blocks, footnotes, `#tags`, properties, `[[wikilinks]]` (with `#heading` and `\|alias`), and `![[embeds]]` of images (with size), PDFs, audio/video and other notes or sections. Folder tree, search, contents list, “Linked from”, print. **Click an image** to open it full-screen: zoom with the buttons, mouse wheel or a click, drag to move around, ← → for the note's other images, Esc or a click outside to close. **🗑 Remove** a note (or a folder, from the 🗑 on hover in the tree) to take it out of the library — it stays in your vault, and updates leave it out until you choose *Include again* in **Update from vault…**. **Update from vault…** re-imports: changed notes are refreshed, new ones added, deleted ones removed. Link a procedure from any task or project description by writing `[[Note name]]` (🔗 on a note copies it); the note lists the tasks and projects that use it, and the global search includes the library. Tables follow the **Sheets Extended** plugin: `<` / `^` merge cells left / up, an all-dash column makes row headings, `~ .class { css }` styles a cell, and ` ```sheet ` blocks with their JSON5 class metadata, row/column header styles and `--- ~ {…}` table style are drawn as in Obsidian (`disable-sheet: true` in a note's properties turns this off, as in the plugin). Mermaid/Dataview blocks are shown as text. |
| Attachments | Tasks and meetings have an **Attachments** section: **📎 Add files…**, drag files onto it, or **paste a screenshot with Ctrl+V** while the task or meeting is open (Win+Shift+S, then Ctrl+V; it's named *Screenshot <date> <time>.png*). Images show as thumbnails that open in the full-screen viewer (zoom, ← →); PDFs and text open in a new tab, other files (Excel, Word, emails…) download. Rename ✎ or delete ✕ any attachment; tasks with files show 📎 *n* in lists. Up to 100 MB per file. Files are kept in `attachments\` in your data folder and copied to `backups\files\` at every backup (kept there even after deletion, so restoring an older backup still finds them). |
| 📅 Calendar | The app's own meetings (no outside calendars) in **month, week and day** views, coloured by project with a legend, today highlighted and a red *now* line. **Click a meeting** to open it; **click an empty day or time** to add one there (choose its project, or none for a meeting of its own); **drag** a meeting to another day or time (15-minute steps); in week/day view **drag its bottom edge** to change its length. Filter to one project, ‹ Today › (or ← →) to move through time; the view and date are remembered. Meetings now have a **duration** (default 1 hour). |
| Meetings | Record meetings on a **project** (🗓 Meetings card on its Overview) or on a **task** (in the task window): title, date & time, location and attendees (one click adds team members). **Notes** have basic formatting — **bold**, *italic*, underline, highlight, bullet and numbered lists (Ctrl+B / I / U work too; pasting from Outlook or Word keeps just those formats) — and save as you type. **Actions agreed** take an owner and due date (and the quick syntax, e.g. `!high`) and become real tasks — subtasks for a task's meeting — so they appear in task lists, the dashboard and reminders, link back to their meeting, and can be ticked off from the meeting. **📋 Copy minutes** puts formatted minutes on the clipboard for an email. Meetings appear in the project timeline, on the dashboard (next 7 days), in search, in the status report (with actions agreed/done) and as a **Meetings** sheet in the Excel export. Deleting a meeting keeps its actions. |
| Project team | Each project's **👥 Project team** panel (Overview tab) lists the leader and sponsor, then the team with role, capacity and contact (emails are clickable), and how many open and overdue tasks each person owns. Add people when creating the project (*Name, role* per line) or with **＋ Add person**; click someone to edit or remove them. People who own tasks but aren't on the team are listed with a one-click **＋** to add them. Team names are offered first as task owners, fill the charter's *Team* box, and the Excel export has a **Team** sheet. The same list is editable in the Charter tab. |
| Phases / milestones | Split a bigger project into **phases** (e.g. *Phase 1: pilot*, *Phase 2: roll-out*), each with a start and end (milestone) date and a short description of what it delivers. The project page shows them as a strip of cards with progress, **current / upcoming / complete**, a Red / Yellow / Green status and slip against the baseline; click one to edit, reorder, **mark complete** (with the date recorded) or delete it (its tasks are kept). Tasks are grouped under their phase in the list (finished phases collapse), new tasks go into the chosen phase, and a task's phase can be changed in the task window — subtasks always follow their parent. The **Gantt** shows a bar per phase with its tasks under it; the projects board and dashboard show *Phase 2/3: Roll-out · ends 12 Dec*; the status report lists phases completed in the period and moved phase dates; the Excel export has a **Phases** sheet. |
| Kanban view | **Projects board**: every ongoing project as a card (Active / On hold / Completed) showing progress, blocked and overdue counts and due dates; drag to change status. Each project page also has its own **mini board** of its tasks (To do / In progress / Blocked / Done) via the **List / Board** switch. |
| Tick-box tasks & subtasks | Checklist with unlimited nested subtasks. Ticking a parent offers to tick its open subtasks too. |
| Ideation (lightweight tickets) | Log ideas with a permanent reference (`IDEA-0001`…), name, submitter, area, priority, due date, cost and an **impact / effort score**. Add time-stamped notes later, move them through a status, see them on a **quick-wins grid**, and **escalate** one to a full project in one step. Areas are managed on the **Settings** page. |
| Gantt chart | Each project has a **▤ Gantt** view: bars from start to due date, the **baseline plan** as a grey bar underneath with the slip (`+3d`), **dependencies** as arrows (red ⚠ when a task starts before what it depends on is due), today and due-date lines, day / week / month zoom. **Drag** a bar to move it or its ends to change the dates. The Projects board has a **▤ Timeline** of all projects too. |
| Status report | **📰 Report** summarises a period (last 7 days, this / last week, since the last report, or custom) per project: completed, started, added and re-dated tasks, notes, blocked / waiting / overdue items, what's coming up, budget, plus new ideas. **Copy as text** for an email, download for **Word**, or **print / PDF**. |
| Meeting notes → tasks | In any project note, lines starting `[ ]` become tasks when you save (on a task's note they become subtasks). Shortcuts work on those lines, e.g. `[ ] Chase finance !high @fri`. |
| Waiting on | Record who a task is waiting on; the app tracks for how long. Shown on the task, in the dashboard's **Waiting on others** card and in the report. |
| Recurring tasks | Set a task to repeat (daily, weekdays, weekly, every 2 weeks, monthly, quarterly, yearly). Ticking it off creates the next one, with fresh copies of its subtasks. |
| Budget vs actual | Give a project a budget (escalated ideas bring their cost across) and log costs against it; the project shows spent, remaining and a warning when over. |
| Excel export | Download everything, one project, or all ideas as a real `.xlsx` workbook (Projects, Tasks, Ideas, Notes and Costs sheets, with filters and proper dates). |
| Links | Web links and file paths in notes and descriptions become clickable. A path such as `\\server\share\file.xlsx` opens File Explorer with the file selected (wrap paths containing spaces in "quotes"). |

Also included: a **dashboard** in two parts, **Projects** (headline counts plus a table of every ongoing project with a health rating (⚠ At risk / ◐ Watch / ✓ On track), progress, open issues, next due task and last activity) and **Tasks & notes** (overdue, due today, next 7 days, blocked, high-priority, reminders and latest notes), plus search across projects, tasks, notes and ideas, and a layout that works on narrow screens.

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
   The database is created automatically on first start in `%LOCALAPPDATA%\CIManager`. If you used a version from before the rename to CI Manager, the old `%LOCALAPPDATA%\TaskManager` folder is renamed to `CIManager` automatically on the first start (if something has a file in it open, e.g. DBeaver, the old folder keeps being used and a warning is logged; close it and restart). If you used an earlier version that kept `data\taskmgr.db` inside the app folder, it's moved across automatically on first start (the old file is renamed to `taskmgr.db.migrated`), and old backups are copied too.
3. **Enable desktop alerts:** click **🔔 Enable desktop alerts** in the top bar and allow notifications. Reminders only fire while the app is open in a browser tab, so keep it pinned in Edge or Chrome.
4. *(Optional)* To change the port, database location or backup settings, copy `.env.example` to `.env` and edit it.

### Start automatically when you log in (optional)
Press `Win+R`, type `shell:startup`, and put a shortcut to **`start-hidden.vbs`** in the folder that opens (right-click the file → *Show more options* → *Create shortcut*, then move the shortcut). The app then starts silently at log-in and opens in your browser.

> If Windows reports that VBScript isn't available (Microsoft is gradually retiring it; it's still installed by default on Windows 10 and 11), use `start.bat` instead.

### Getting updates (during development)
Double-click **`update.bat`** in your clone of the repository. It:
1. stops the running CI Manager (whether it was started hidden or with `start.bat`);
2. takes a backup of your data;
3. runs `git pull --ff-only` and lists the new changes;
4. runs `npm install` in case dependencies changed;
5. starts the app again and opens it in the browser.

This needs Git installed and the app running from a `git clone` of the repository. Your data is in `%LOCALAPPDATA%\CIManager`, outside the repository, so pulling never touches it (and `.env` is git-ignored). If the pull fails (for example, because you've edited a tracked file), the script says so and restarts the version you already had.

When an update changes how data is stored, the app upgrades your database automatically on its next start. Before any structural change it saves a copy of the database as `backups\db\pre-upgrade-<date>.db` in your data folder, and it checks every link between records afterwards; if anything doesn't add up, the upgrade is undone and nothing is changed.

---

## 2. Everyday use

- **New project:** click **+ New** in the sidebar. List the baseline tasks one per line. The baseline is set automatically.
- **Add a note as you go:** type in the bar at the top of the project and press **Enter**. Notes are time-stamped. To attach a note to a specific task, pick the task in the drop-down first.
- **Add a task:** type in the *Add a task…* box and press **Enter**. Shortcuts you can include in the text:
  - `!low` `!high` `!crit` sets the priority
  - `@today` `@tomorrow` `@fri` `@2026-10-31` sets the due date

  For example, `Send board pack !high @thu`.
- **Subtasks:** hover over a task and click **＋ sub**, or open the task and use *Add subtask*.
- **Task details:** click a task title to edit its description, status, priority and due date (changes save automatically), and to add subtasks, reminders and notes or see its history.
- **Boards:** **🗂 Projects board** in the sidebar shows all ongoing projects; drag a card between *Active*, *On hold* and *Completed*, or click it to open the project. On a project page, switch the Tasks panel between **☰ List** (tick-box checklist with subtasks) and **▦ Board** (that project's own Kanban: drag tasks between columns). The choice is remembered.
- **Due-date alerts:** a pop-up appears once on the day a task is due, and again once it becomes overdue.
- **Re-baseline:** use this after an agreed change of scope. All current tasks become the new baseline.
- **Keyboard:** `N` quick note, `T` add task (in a project), `/` search.
- **Closing windows:** click anywhere outside a pop-up window (or press Esc). Windows that save as you go (tasks, meetings) save first; a form you haven't saved yet (new project, phase, person…) asks before discarding what you typed. Clicking outside the 📇 contacts book keeps what you ticked.
- **Repeating tasks:** add `*weekly` (or `*daily`, `*weekdays`, `*fortnightly`, `*monthly`, `*quarterly`, `*yearly`) when adding a task, or set *Repeats* in the task window.
- **Waiting on someone:** fill in *Waiting on* in the task window (names you've used are suggested). Clear it when they've replied.
- **Gantt:** give tasks a *Start date* and *Due date* in the task window, or drag on the chart. A task with only a due date shows as a ◆ milestone. Add dependencies under *Depends on* in the task window.
- **Costs:** use *＋ Log a cost* under the project heading; *Show costs* lists them. Set the budget with ✎ Edit.
- **Report:** open **📰 Report**, pick the period, then *Copy as text* and paste into your email. Use *✓ Mark as sent* so *Since last report* starts from there next time.
- **Excel:** *⬇ Export to Excel* on the dashboard (everything), *⬇ Excel* on a project page (that project) or on Ideation (all ideas).
- **Archive rather than delete:** set a finished project's status to *Archived* to hide it. **Show archived** in the sidebar brings it back.

### Project charter
- **New project** opens the charter form. Fill in the fields marked \* (title, problem definition, goals, sponsor, leader); category, policy deployment, gross margin effect and project ID are optional, and scope / benefits can be added now or later. If you leave *Project ID* blank it's numbered automatically (`PRJ-0001`, …) and you can change it at any time.
- The project's **📋 Charter** tab shows the whole template. Edit any box in place (it saves as you go). Add team members (name, role, capacity) and KPIs (unit, baseline, target, current) in their tables; press **Enter** on the last row to add one. The milestone plan lists the project's top-level tasks, so give those tasks dates (in the task window or on the Gantt).
- **⬇ Charter (Excel)** downloads the charter. **🖨 Print** prints just the charter, landscape.
- **Timeline grids:** if the template has timeline tables like the standard one (*Sub projects* and *Action agreed*, with *Owner*, *Planned Complete Date*, month columns and *Status*), they're filled from the project: if it has **phases**, **Sub projects** = the phases and **Action agreed** = its tasks; otherwise **Sub projects** = the top-level tasks and **Action agreed** = their subtasks (open ones first in both cases). Each row gets the owner, the planned complete date, the planned months shaded, **S** in the month work actually started (when the task was first set to *In progress* or *Done*), **x** in the month it was completed, and a **Red / Yellow / Green** status (red = overdue; yellow = blocked, or due within a week and not started; green = otherwise, or *Complete*). The year headers are set to the project's years. If there are more tasks than rows, the last row says how many more there are.
- **Owners:** each task has an *Owner* field (in the task window). The project's charter team is suggested first.
- **Your Excel template:** on **⚙ Settings → Project charter Excel template**, upload your standard template (.xlsx) once. The app finds each label (*Problem definition*, *Management Sponsor*, *Project ID*, …) and shows which cell each value will go into: the box below or beside the label, or *under the label* when the label is at the top of a box. Correct any cell that's wrong (use the top-left cell of a merged box) and **Save cell mapping**. The downloaded charter contains **only the sheet the charter is written to** (e.g. *Project Template*); the workbook's other sheets (A3 copies, checklists, risk sheets, final report, …) are left out, along with the external links and named ranges that belonged to them. The Settings page lists which sheets are kept and which are left out. On the kept sheet, formatting, dropdowns, formulas, comments and print areas stay as they are. If the template has a dropdown for Category, its choices are added to the app's Category list. Until a template is uploaded, a plain one-sheet charter is produced.
- The **Category** and **Policy deployment** suggestions are managed on the Settings page too.
- The dashboard's project table shows each charter's completeness.

### Standalone tasks
- **✅ Tasks** in the sidebar: type a task and press Enter (the usual shortcuts work). Tasks can have subtasks, notes (with `[ ]` checklists), reminders, repeats and *Waiting on*, and appear on the dashboard, in alerts and in the status report under *Other tasks*.
- To file a task under a project, open it and pick the **Project**. It moves with its subtasks and notes, and counts as new scope against that project's baseline. Pick *✅ Tasks (no project)* to move it back.
- **🚀 Promote to a project** (in the task window) turns a task that has grown into a project: you fill in the charter, its subtasks become the project's tasks and its notes move across.

### Ideation
- **💡 Ideation** in the sidebar lists open ideas (*New*, *Under review*, *Approved*). You can filter by status or area, or search by name, reference or submitter. The header shows the total cost of the ideas listed.
- **+ New idea:** give it a name, who submitted it (earlier names are suggested as you type), an area, a priority, a due date and a cost. It gets the next reference number, e.g. `IDEA-0007`. The reference never changes or gets reused.
- **Open an idea** by clicking its row. Edit any field (changes save automatically), change its status (*Rejected* and *Implemented* close it), add time-stamped notes, and see its full history.
- **Impact and effort** (1–5 each) give a **value score** out of 25 (impact × (6 − effort)). Sort the list by *Best value first*, or switch to **▦ Quick wins** to see ideas in a 2×2 grid: quick wins, big projects, fill-ins and ones to reconsider.
- **🚀 Escalate to project** creates a project from the idea. You confirm the name, description, priority and dates, and can list the first (baseline) tasks. The project's timeline gets a summary note (submitter, area, cost) and, optionally, copies of the idea's notes. The idea is marked *Escalated* and the two link to each other.
- **⚙ Settings** manages the *Area* list. Add areas, rename them, or untick *Active* to hide one without affecting ideas that already use it. You can also set the currency symbol used for costs here (default £).

---

## 3. Backups & restore

- The Library's notes are in the database, so they're backed up; its images and attachments are in `library\` in your data folder (your Obsidian vault remains their source — import again to restore them).
- Each backup writes a database copy to `backups\db\` and a JSON export to `backups\json\`, inside your data folder (`%LOCALAPPDATA%\CIManager\backups`).
- **Take a backup now:** the **Backups** page, or `npm run backup`.
- **Restore in the app:** on the **💾 Backups** page, click **⤺ Restore** next to any backup, or **⤺ Restore from file…** to pick a `.db` or `.json` backup from anywhere (e.g. a copy on OneDrive or a USB stick). It shows what the backup contains and asks you to confirm; a safety backup of the current data is taken first, so a restore can be undone by restoring that.
- **Restore from the command line:** `npm run restore -- "%LOCALAPPDATA%\CIManager\backups\db\taskmgr-YYYYMMDD-HHMMSS.db"` (a `.json` backup works too). It asks you to confirm, then takes a safety backup of the current data before replacing it. Run `npm run restore` with no file to list the available backups. It's best to stop the app first.
- A backup `.db` file is a normal database, so you can also just open it in DBeaver to look something up without restoring.
- **Tip:** set `BACKUP_DIR` in `.env` to a OneDrive or network folder so the backups are kept off your PC.

## 4. Working with the data directly (DBeaver)

In DBeaver: *Database → New Database Connection → SQLite*, and pick `%LOCALAPPDATA%\CIManager\taskmgr.db` as the path (paste `%LOCALAPPDATA%\CIManager` into the file dialog's address bar to get there). DBeaver offers to download the SQLite driver the first time. You can do this while the app is running.

| Table | Contents |
|---|---|
| `projects` | Projects, including baseline date, baseline due date and a JSON `baseline_snapshot` |
| `tasks` | Tasks; `project_id` is empty for standalone tasks, `parent_id` links subtasks, `is_baseline` (1/0) marks original-plan tasks |
| `notes` | The additive, time-stamped notes |
| `reminders` | Pending and dismissed reminders |
| `ideas` | Ideation tickets; `ref` (`IDEA-0001`…) is assigned automatically, `project_id` is set when escalated |
| `idea_notes` | Notes on ideas |
| `areas` | The *Area* list for ideas |
| `settings` | App settings (e.g. currency symbol, when the report was last sent) |
| `task_links` | Gantt dependencies: `task_id` waits for `depends_on_id` |
| `project_costs` | Costs logged against a project's budget |
| `project_team`, `project_kpis` | The charter's team members and improvement KPIs |
| `lookups` | The Category and Policy deployment pick-lists |
| `audit_log` | Every change, with old and new values as JSON and when it happened |

**Dates and times** are stored as UTC text in the form `2026-10-31T17:00:00.000Z` (note the trailing `Z`: UTC, not local time). The database rejects anything in another format, so hand edits can't break sorting or the due-date alerts. Due dates (`due_at`) are whole days, stored as the last moment of that day in local time (e.g. `2026-10-31T23:59:59.999Z` in winter in the UK). You don't need to set `updated_at`, `completed_at` or the audit log yourself; the triggers handle them.

**Microsoft Access / Excel (optional):** install the free *SQLite ODBC driver* (by Christian Werner). Then use *External Data → New Data Source → From Other Sources → ODBC* and link the tables for queries and reports. Edits made that way are captured in the audit log too.

## 5. Configuration (`.env`)

| Setting | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Where the app listens. Keeping `127.0.0.1` means only your own PC can reach it. |
| `DATA_DIR` | `%LOCALAPPDATA%\CIManager` | Folder for the database, backups and logs. Avoid OneDrive-synced folders for the live database. |
| `DB_FILE` | `DATA_DIR\taskmgr.db` | The database file |
| `BACKUP_DIR` | `DATA_DIR\backups` | Where backups go (a OneDrive or network folder is a good choice) |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between automatic backups (`0` turns them off) |
| `BACKUP_KEEP` | `30` | Number of backups of each type to keep |
| `LOG_DIR` | `DATA_DIR\logs` | Daily log files |

## 6. Project layout

```
src/schema.js        tables, timestamp and audit triggers (applied automatically at start-up)
src/db.js            SQLite connection (Node's built-in node:sqlite)
src/server.js        web server entry point
src/api.js           REST API (/api/...)
src/backup.js        database-file + JSON backups and schedule
src/dates.js         quick-add syntax and repeating-task dates
src/xlsx.js          Excel (.xlsx) reader/writer used for exports
src/charter.js       project charter fields, completeness and filling your Excel template
public/charter.js    Charter tab, Tasks page and charter settings
public/gantt.js      Gantt chart
public/report.js     status report page
public/              the web UI (plain HTML/CSS/JS, no build step)
scripts/             init-db, backup, restore, smoke-test
start-hidden.vbs     double-click launcher for Windows (no console window)
stop-server.vbs      stops the background app
update.bat           stop → back up → git pull → npm install → restart
start.bat            launcher that keeps a console window with the log
```

`npm test` runs an end-to-end smoke test using a temporary database, so your real data is never touched.
