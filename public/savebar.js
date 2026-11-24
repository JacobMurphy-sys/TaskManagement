'use strict';
// 💾 One Save / Undo bar for the whole app: whatever's been changed on a page and not saved yet floats at the bottom
// of the window — how many changes and where — with Undo changes and Save, as Production › Setup had it.
//
// Two ways a page puts its changes on it:
//  • saveBar.queue(key, run, { label, el }) — a change kept until Save (run: () => Promise that saves it; the same key
//    again replaces it). The field (el) is outlined until then. saveBar.on(label, { after, undo }) says what to do once
//    they're saved (after: draw the page again) or dropped (undo).
//  • An editor with its own save: its Save button marked data-sb-save="Label", its Undo data-sb-undo and its
//    "not saved yet" marker data-sb-dirty (changes waiting while that isn't hidden), side by side (or the marker
//    around them). Those buttons are hidden; the bar presses them. A Save button may carry .sbCheck = () => an error
//    message or null, asked before anything is saved.
// Leaving the page (another page, a reload, closing it) with changes waiting asks first.
const saveBar = (() => {
  const queued = new Map(); // key → { label, run, el }
  const hooks = new Map(); // label → { after, undo }
  let bar = null; let busy = false; let tick = 0;
  const inline = () => [...document.querySelectorAll('[data-sb-save]')].filter((b) => {
    if (!document.body.contains(b)) return false;
    const d = b.parentElement?.querySelector('[data-sb-dirty]') || b.closest('[data-sb-dirty]');
    return d ? !d.hidden : !b.disabled;
  }).map((b) => ({ label: b.dataset.sbSave, save: b, undo: b.parentElement?.querySelector('[data-sb-undo]') || b.closest('[data-sb-dirty]')?.querySelector('[data-sb-undo]') }));
  const labels = () => { const m = new Map(); for (const q of queued.values()) m.set(q.label, (m.get(q.label) || 0) + 1); for (const g of inline()) if (!m.has(g.label)) m.set(g.label, 0); return m; };
  const count = (label) => (label ? [...queued.values()].filter((q) => q.label === label).length : queued.size + inline().length);
  const any = () => count() > 0;
  function make() {
    if (bar) return bar;
    bar = document.createElement('div'); bar.className = 'savebar'; bar.hidden = true; bar.setAttribute('role', 'status');
    bar.innerHTML = '<span class="savebar-n"></span><span class="savebar-what"></span><span class="spacer"></span><button type="button" class="small" data-sbar="undo">Undo changes</button><button type="button" class="small primary" data-sbar="save">💾 Save</button>';
    bar.addEventListener('click', (e) => { const a = e.target.closest('[data-sbar]')?.dataset.sbar; if (a === 'save') save(); else if (a === 'undo') undo(); });
    document.body.appendChild(bar); return bar;
  }
  function refresh() {
    const b = make(); const n = count(); b.hidden = !n;
    if (!n) return;
    const L = labels();
    b.querySelector('.savebar-n').textContent = `${n} change${n === 1 ? '' : 's'} not saved yet`;
    b.querySelector('.savebar-what').textContent = [...L.keys()].filter(Boolean).length ? `— ${[...L.entries()].map(([l, k]) => (k > 1 ? `${l} (${k})` : l)).join(', ')}` : '';
    b.querySelectorAll('button').forEach((x) => { x.disabled = busy; });
    b.querySelector('[data-sbar="save"]').textContent = busy ? 'Saving…' : '💾 Save';
  }
  const later = () => { if (tick) return; tick = requestAnimationFrame(() => { tick = 0; refresh(); }); };
  function queue(key, run, { label = '', el = null } = {}) { queued.set(key, { label, run, el }); el?.classList.add('sb-dirty'); later(); }
  function on(label, h) { hooks.set(label, { ...(hooks.get(label) || {}), ...h }); }
  // saves what's queued (and, unless only that's asked, presses each editor's Save); false when something failed
  async function save({ quiet = false, queuedOnly = false } = {}) {
    if (busy) return false;
    const groups = queuedOnly ? [] : inline();
    for (const g of groups) { const err = g.save.sbCheck?.(); if (err) { toast(err, 'error'); return false; } }
    busy = true; refresh();
    for (const g of groups) g.save.click(); // each reads its fields straight away, then saves and draws itself again
    const runs = [...queued.values()]; queued.clear(); const errs = []; const done = new Set();
    for (const q of runs) { try { await q.run(); done.add(q.label); } catch (e) { errs.push(e.message); queued.set(`retry:${Math.random()}`, q); } }
    for (const q of runs) q.el?.classList.remove('sb-dirty');
    for (const q of queued.values()) q.el?.classList.add('sb-dirty');
    busy = false;
    if (errs.length) toast(`Not saved: ${errs.join('; ')}`, 'error'); else if (runs.length && !quiet) toast('Saved');
    if (!quiet) for (const l of done) await hooks.get(l)?.after?.();
    refresh(); return !errs.length;
  }
  function drop(label) { for (const [k, q] of queued) if (!label || q.label === label) { q.el?.classList.remove('sb-dirty'); queued.delete(k); } later(); }
  function undo() {
    const ls = new Set([...queued.values()].map((q) => q.label)); drop();
    for (const g of inline()) g.undo?.click();
    for (const l of ls) hooks.get(l)?.undo?.();
    later();
  }
  // a new page: nothing queued carries over, nor what to do after
  function reset() { drop(); hooks.clear(); later(); }
  window.addEventListener('beforeunload', (e) => { if (any()) { e.preventDefault(); e.returnValue = ''; } });
  const watch = () => { new MutationObserver((ms) => { if (ms.some((m) => !bar || !bar.contains(m.target))) later(); }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'disabled'] }); later(); };
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
  return { queue, on, save, undo, drop, reset, any, count, refresh };
})();
