'use strict';
// 🧭 Places for the search page: the parts of the app a search can take you to (the page, set up as
// needed, scrolled to the section) — so searching "OEE" offers Insights' Estimated OEE by customer and
// the OEE settings in Production's setup. Only places in the account's modules (and rights) are
// offered. Loaded before app.js.

// { label, where, keys (more words it answers to), area (null: the basic pack), right, hash, prep, find (a heading to scroll to) }
const PLACES = [
  // 🏭 Production
  { label: 'Perso work orders', where: 'Production › 💳 Perso', keys: 'open jobs queue plan list due today overdue running', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planView', 'list'); } },
  { label: 'Order: FIFO, BAU, Score, Mitigation', where: 'Production › 💳 Perso (the drop-down on the tab)', keys: 'fifo bau score mitigation priority order sort', area: 'planning', hash: '#/planning', prep: () => store.set('planHalf', 'perso'), find: '#pl-mode' },
  { label: 'Generate plan (PDF for the cells)', where: 'Production › 💳 Perso / ✉️ Matching', keys: 'print pdf plan cells dod emboss laser generate', area: 'planning', hash: '#/planning', prep: () => store.set('planHalf', 'perso'), find: '.pl-generate' },
  { label: 'Backlog and catching up', where: 'Production › 💳 Perso', keys: 'backlog overdue catch up pace', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planView', 'list'); }, find: '⏳ Backlog' },
  { label: 'Cards due by each cut-off', where: 'Production › 💳 Perso', keys: 'cut-off shipper deadline slots', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planView', 'list'); }, find: 'Cards due by each cut-off' },
  { label: 'Gantt and load per machine', where: 'Production › 💳 Perso › ▤ Gantt / ▦ Load', keys: 'gantt load machines booked capacity', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planView', 'gantt'); } },
  { label: 'History: done and on time', where: 'Production › 💳 Perso › 📈 History', keys: 'history completed done on time late throughput', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planView', 'history'); } },
  { label: 'Matching jobs', where: 'Production › ✉️ Matching', keys: 'matching otto waiting on perso', area: 'planning', hash: '#/planning', prep: () => store.set('planHalf', 'otto') },
  { label: 'Dispatch: ready, waiting on perso or Matching', where: 'Production › 🚚 Dispatch', keys: 'dispatch despatch shipping ready waiting chain live group', area: 'planning', hash: '#/planning', prep: () => store.set('planHalf', 'disp') },
  { label: 'Dispatch delays: new expected dates for late work orders', where: 'Production › 🚚 Dispatch › ⏱ Delays', keys: 'delay delays late overdue new date expected ship shipment plan report customer reason dispatch despatch', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'disp'); store.set('planView_disp', 'delays'); } },
  { label: 'Dispatch export (setting)', where: 'Production › ⚙ Setup', keys: 'dispatch despatch export path setting', area: 'planning', right: 'setup', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planSetupOpen', true); }, find: '[name="plan_disp_src"]' },
  { label: 'Card lines without a speed', where: 'Production › 💳 Perso (🔎 Show which)', keys: 'no speed missing speed card database unknown articles', area: 'planning', hash: '#/planning', prep: () => store.set('planHalf', 'perso'), find: '[data-pl="nospeed"]' },
  { label: 'Find a work order or card', where: 'Production (the 🔍 bar, or press F)', keys: 'search work order wo card ax article', area: 'planning', hash: '#/planning', prep: () => store.set('planHalf', 'perso'), find: '#pf-bar' },
  { label: 'Estimated OEE by customer', where: 'Production › 🧠 Insights › 🔬 Learned', keys: 'oee efficiency customer measured', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'learn'); }, find: 'Estimated OEE by customer' },
  { label: 'Speeds by kind of card (learned)', where: 'Production › 🧠 Insights › 🔬 Learned', keys: 'speed cards per hour learned kind type material', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'learn'); }, find: 'Speeds by kind of card' },
  { label: 'Accuracy: planned against what ran', where: 'Production › 🧠 Insights › 🔬 Learned', keys: 'accuracy planned within 25% card by card learned times', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'learn'); } },
  { label: 'What stands out (findings)', where: 'Production › 🧠 Insights › 🔬 Learned', keys: 'findings insights patterns', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'learn'); }, find: 'What stands out' },
  { label: 'Pace by shift, machine, weekday, job size', where: 'Production › 🧠 Insights › 🔬 Learned', keys: 'shift machine weekday job size pace patterns', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'learn'); }, find: 'By shift' },
  { label: 'Remakes by customer', where: 'Production › 🧠 Insights › 🔬 Learned', keys: 'remakes scrap remade quality', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'learn'); }, find: 'Remakes by customer' },
  { label: 'Late by customer and shipper', where: 'Production › 🧠 Insights › 🔬 Learned', keys: 'late otd on time delivery shipper customer', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'learn'); }, find: 'Late by customer and shipper' },
  { label: 'Jobs furthest over their usual time', where: 'Production › 🧠 Insights › 🔬 Learned', keys: 'overrun slow jobs over time', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'learn'); }, find: 'Jobs furthest over' },
  { label: 'Cards that run unlike their kind', where: 'Production › 🧠 Insights › 🔬 Learned', keys: 'cards slow fast unlike kind outliers', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'learn'); }, find: 'Cards that run unlike' },
  { label: 'Matching speeds by customer', where: 'Production › 🧠 Insights › 🔬 Learned', keys: 'matching speed items per hour customer', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'learn'); }, find: 'Matching speeds by customer' },
  { label: 'Explode: any dates, % of total, drill-down', where: 'Production › 🧠 Insights (⤢ on a table)', keys: 'explode drill down percentage share compare period', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'learn'); } },
  { label: 'D+ due out: how much notice', where: 'Production › 🧠 Insights › 📆 D+ due out', keys: 'd+ d+0 d+1 notice lead time same day due out arrival', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'dplus'); } },
  { label: 'Hidden old work orders to Excel', where: 'Production › 💳 Perso › ⏳ Backlog (⬇ Export them to Excel)', keys: 'hidden old open work orders due long ago export excel investigate likely errors not closed', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planView', 'list'); }, find: '⏳ Backlog' },
  { label: 'Anomalies to Excel (investigations)', where: 'Production › 🧠 Insights › ⏱ Timing (⬇ Anomalies to Excel)', keys: 'anomalies anomalous runs timing export excel investigate', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'timing'); }, find: '[data-anom-export]' },
  { label: 'Timing: what ran on each machine', where: 'Production › 🧠 Insights › ⏱ Timing', keys: 'timing runs machine gantt load anomalies efficiency daily report', area: 'planning', hash: '#/planning', prep: () => { store.set('planHalf', 'insights'); store.set('planInsight', 'timing'); } },
  { label: 'OEE by customer (setting)', where: 'Production › ⚙ Setup', keys: 'oee efficiency customer default setting', area: 'planning', right: 'setup', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planSetupOpen', true); }, find: 'Estimated OEE by customer' },
  { label: 'Speeds (setting)', where: 'Production › ⚙ Setup', keys: 'speed rules cards per hour setting', area: 'planning', right: 'setup', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planSetupOpen', true); }, find: 'Speeds — cards per hour' },
  { label: 'Machines (setting)', where: 'Production › ⚙ Setup', keys: 'machines lines capacity setting', area: 'planning', right: 'setup', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planSetupOpen', true); }, find: 'Machines' },
  { label: 'Exports and card database (setting)', where: 'Production › ⚙ Setup', keys: 'export file path card database access shifts working hours days run times learned', area: 'planning', right: 'setup', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planSetupOpen', true); }, find: '#pl-setup' },
  { label: 'Capacity planning (CPM): forecast vs capacity by month or week', where: 'Production › 📐 Capacity', keys: 'cpm capacity forecast macro year load machines scenarios', area: 'cpm', hash: '#/cpm/overview' },
  { label: 'Flex: forecast against actual, history uploads', where: 'Production › 📐 Capacity › Forecast vs actual', keys: 'flex forecast actual history previous years upload', area: 'cpm', hash: '#/cpm/flex' },
  { label: 'Capacity scenarios', where: 'Production › 📐 Capacity › Scenarios', keys: 'scenario what if add remove machine speed shifts oee', area: 'cpm', hash: '#/cpm/scenarios' },
  { label: 'Customer split and OEE for capacity planning', where: 'Production › 📐 Capacity › Customers', keys: 'split laser emboss dod oee trigram customer forecast names', area: 'cpm', hash: '#/cpm/customers' },
  { label: 'Priority modifiers', where: 'Production › ⚖ Modifiers', keys: 'modifiers priority score customers tags shifts', area: 'planning', right: 'setup', hash: '#/planning', prep: () => { store.set('planHalf', 'perso'); store.set('planModsOpen', true); }, find: '⚖ Priority modifiers' },
  // 📊 Reporting
  { label: 'Weekly Ops Report (A3)', where: 'Reporting', keys: 'a3 weekly report ops kpi', area: 'kpi', hash: '#/kpi' },
  { label: 'Prepare this week', where: 'Reporting › ▶ Prepare this week', keys: 'prepare week read sources missing checklist', area: 'kpi', hash: '#/kpi/prepare' },
  { label: 'KPI database', where: 'Reporting › Database', keys: 'database figures manual adjust kpi table', area: 'kpi', hash: '#/kpi/0/database' },
  { label: 'Sources and forecasts', where: 'Reporting › Sources', keys: 'sources forecast workbook files paths salesforce otd', area: 'kpi', right: 'setup', hash: '#/kpi/sources' },
  // 🗂 Projects, 💡 Ideas
  { label: 'Projects board', where: '🗂 Projects', keys: 'projects kanban board status', area: 'projects', hash: '#/kanban' },
  { label: 'Projects timeline', where: '🗂 Projects › ▤ Timeline', keys: 'timeline gantt projects', area: 'projects', hash: '#/kanban', prep: () => store.set('projectsView', 'timeline') },
  { label: 'Ideas and quick wins', where: '💡 Ideas', keys: 'ideas improvement quick wins impact effort', area: 'ideas', hash: '#/ideas' },
  // the basic pack
  { label: 'My work', where: '📥 My work', keys: 'assigned mine my tasks new for you', hash: '#/mine' },
  { label: 'Calendar and meetings', where: '📅 Calendar', keys: 'calendar meetings schedule', hash: '#/calendar' },
  { label: 'Tasks', where: '✅ Tasks', keys: 'tasks to do standalone', hash: '#/tasks' },
  { label: 'Library', where: '📚 Library', keys: 'library procedures work instructions obsidian vault', hash: '#/library' },
  { label: 'Appearance: light or dark', where: '⚙ Settings', keys: 'dark mode light theme appearance', hash: '#/settings', find: '#theme-choice' },
  { label: 'Change your password', where: '⋯ menu › 🔑 Change password', keys: 'password change account sign in', hash: '#/settings' },
  { label: 'Contacts', where: '📇 Contacts', keys: 'contacts people departments lists names', area: 'contacts', hash: '#/contacts' },
  // admin
  { label: 'Accounts, modules and rights', where: '⚙ Settings › 👤 Accounts', keys: 'accounts users modules rights admin permissions', right: 'accounts', hash: '#/settings', find: '.acct-card' },
  { label: 'Backups and restore', where: '⋯ › 💾 Backups', keys: 'backup restore', right: 'backups', hash: '#/backups' },
  { label: 'Server log and restart', where: '⚙ Settings › 🖥 Server', keys: 'server log restart update errors', right: 'server', hash: '#/settings', find: '[data-srv="log"]' },
];

// The places a search answers: every word somewhere in the label, the where or the keys; in this
// account's modules and rights.
function placesFor(q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return PLACES.filter((pl) => (!pl.area || modOk(pl.area)) && (!pl.right || acctRight(pl.right)))
    .filter((pl) => { const hay = `${pl.label} ${pl.where} ${pl.keys || ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
    .slice(0, 12);
}
// Go to a place: its page set up, then scrolled to its section (a CSS selector or a heading's text).
async function goPlace(i) {
  const pl = PLACES[i]; if (!pl) return;
  pl.prep?.();
  if (location.hash === pl.hash) await route(); else location.hash = pl.hash;
  if (!pl.find) return;
  const started = Date.now();
  const look = () => {
    let el = null;
    try { if (/^[#.[]/.test(pl.find)) el = document.querySelector(pl.find); } catch { /* not a selector */ }
    if (!el) el = [...document.querySelectorAll('#main h2, #main h3, #main h4')].find((h) => h.innerText.trim().startsWith(pl.find));
    if (el && el.offsetParent !== null) {
      // a small card is lit up whole; in a big one (Production's setup) just the section's heading
      const card = el.closest('.card'); const box = card && card.offsetHeight < 600 ? card : el;
      el.scrollIntoView({ behavior: 'smooth', block: box === el ? 'start' : 'center' });
      box.classList.add('place-flash'); setTimeout(() => box.classList.remove('place-flash'), 2400);
      return;
    }
    if (Date.now() - started < 10000) setTimeout(look, 300);
  };
  setTimeout(look, 300);
}
