// Date helpers shared by the API: whole-day due dates, the quick-add syntax
// used in task titles and note checklists, and recurring-task scheduling.
// All calendar arithmetic is in the PC's local time zone.

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const fromKey = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };

const PRIORITY_WORDS = { low: 1, l: 1, 1: 1, med: 2, medium: 2, m: 2, 2: 2, high: 3, h: 3, 3: 3, crit: 4, critical: 4, c: 4, 4: 4 };
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const REPEAT_WORDS = {
  daily: 'daily', weekdays: 'weekdays', weekly: 'weekly', fortnightly: 'fortnightly', biweekly: 'fortnightly',
  monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly', annually: 'yearly',
};

// "Chase finance !high @fri *weekly" -> { title, priority, due_at: 'YYYY-MM-DD', recurrence }
function parseQuick(text) {
  const out = {};
  const title = String(text)
    .replace(/(^|\s)!(\w+)/g, (m, sp, w) => {
      const p = PRIORITY_WORDS[w.toLowerCase()];
      if (!p) return m;
      out.priority = p; return sp;
    })
    .replace(/(^|\s)\*(\w+)/g, (m, sp, w) => {
      const r = REPEAT_WORDS[w.toLowerCase()];
      if (!r) return m;
      out.recurrence = r; return sp;
    })
    .replace(/(^|\s)@([\w-]+)/g, (m, sp, w) => {
      const lw = w.toLowerCase();
      const d = startOfToday();
      if (lw === 'today') { /* today */ } else if (lw === 'tomorrow' || lw === 'tmr') d.setDate(d.getDate() + 1);
      else if (/^[a-z]+$/.test(lw) && DAYS.includes(lw.slice(0, 3))) {
        let add = (DAYS.indexOf(lw.slice(0, 3)) - d.getDay() + 7) % 7;
        if (add === 0) add = 7;
        d.setDate(d.getDate() + add);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(lw) && !Number.isNaN(fromKey(lw).getTime())) {
        out.due_at = lw; return sp;
      } else return m;
      out.due_at = dateKey(d); return sp;
    })
    .replace(/\s+/g, ' ').trim();
  return { title, ...out };
}

function addMonths(d, n, anchorDay) {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(anchorDay, last));
  return r;
}

function step(d, rule, anchorDay) {
  const r = new Date(d);
  switch (rule) {
    case 'daily': r.setDate(r.getDate() + 1); return r;
    case 'weekdays': do { r.setDate(r.getDate() + 1); } while (r.getDay() === 0 || r.getDay() === 6); return r;
    case 'weekly': r.setDate(r.getDate() + 7); return r;
    case 'fortnightly': r.setDate(r.getDate() + 14); return r;
    case 'monthly': return addMonths(r, 1, anchorDay);
    case 'quarterly': return addMonths(r, 3, anchorDay);
    case 'yearly': return addMonths(r, 12, anchorDay);
    default: throw new Error(`Unknown recurrence ${rule}`);
  }
}

// Next due date for a recurring task: one step on from the current due date (or
// today if it had none), skipping ahead so it never lands in the past.
// Returns { due: 'YYYY-MM-DD', shiftDays } where shiftDays moves the start date too.
function nextOccurrence(dueIso, rule) {
  const base = dueIso ? new Date(dueIso) : startOfToday();
  base.setHours(0, 0, 0, 0);
  const anchor = base.getDate();
  const today = startOfToday();
  let next = step(base, rule, anchor);
  while (next < today) next = step(next, rule, anchor);
  return { due: dateKey(next), shiftDays: Math.round((next - base) / 86400000) };
}

function shiftKey(key, days) {
  const d = fromKey(key);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

module.exports = { parseQuick, nextOccurrence, shiftKey, dateKey, endOfDay, fromKey };
