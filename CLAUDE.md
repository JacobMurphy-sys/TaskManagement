# SITHUB — notes for working in this repository

SITHUB (formerly CI Manager) is a Node/Express + SQLite app, run locally or as one shared server
with accounts. `npm test` runs the smoke test (`scripts/smoke-test.js`); run it before every commit
and don't pipe it in a way that hides its exit code.

## Keep the project timeline up to date (docs/)

`docs/` is the project's timeline on GitHub Pages (`docs/index.html`, data in `docs/data.js`).
It's part of the work, not an extra: whenever a change is something a user would notice — a new
feature, a new module, a visible fix, a change to how SITHUB is installed or run — add a pin to
`PINS` in `docs/data.js` in the same commit:

```js
{ id: 'short-id', date: 'YYYY-MM-DD', area: 'platform' | 'projects' | 'knowledge' | 'reporting' | 'production' | 'capacity' | 'look',
  title: 'Short title', text: 'One or two plain sentences.', points: ['optional', 'bullets'] },
```

- One pin per feature or update, not per commit; several commits on one thing share a pin (extend
  its `points`).
- A new stretch of work on one theme over several days gets a `PERIODS` entry (or extend `to`).
- Plain words, no customer names, file paths, figures or anything company-internal: the page may
  be public.
- The commits per day (`ACTIVITY`) are filled in by the Pages workflow at publish time; to see
  them locally run `node scripts/timeline-activity.js` (in a full clone).

### The blooper reel 🎬

`BLOOPERS` in `docs/data.js` is the hidden easter egg on the timeline (click the logo five times,
type "oops", or find the 🐞). When something goes memorably wrong or comic while working — a fix
that broke something else, a bug that came back, a misunderstanding, a name that changed again —
add a short, good-humoured entry: `{ date, title, text, lesson }`. Light-hearted, never at anyone's
expense, nothing company-internal.

## Branches: dev and live

- **`main` is live**: the shared server installs from it and pulls it every night, and the timeline publishes from
  it. Never push to `main` unless the user asks for a release; never commit work in progress there.
- **`dev` is where work happens: commit and push to `dev` by default** (`git push -u origin dev`), whatever branch a
  session was started on. Features are finished and tested there, then merged into `main` only when the user
  explicitly asks to merge into live (a pull request from `dev` to `main`, or a merge).

## House rules

- Don't commit company data or paths: `cimanager-defaults.json` and example files stay local.
- Display name is SITHUB; internal names (the `CIManager` folder, `cimanager-*.json`,
  `CIManager-Setup.bat`) are kept so existing installs keep working.
- Keep the README in step with user-visible changes.
