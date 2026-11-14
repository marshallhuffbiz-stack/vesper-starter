// Runs (#/runs): every bot's routines from their Hermes profiles. Today's runs, what is coming up, and
// each routine with its schedule, last result and token use. Tap a routine for its text and the three
// actions Hermes allows from here: Run now, Pause, Resume. Its own screen over the panes, so threads
// and the Approvals view are never touched. The home screen shows a one-line summary (runsSummary).
import { $, h, icon } from './util.js';
import { api, post } from './api.js';
import { firstName } from './store.js';
import { avatar } from './avatar.js';
import { GLYPHS, friendColor } from './marks.js';
import { openRoutineSheet } from './routine.js';

let data = null;
let loading = null;
let el = null;
let openJob = null;
let showFinished = new Set(); // bots whose finished one-time routines are unfolded
let busy = new Set();
const listeners = new Set();

export function onRuns(fn) { listeners.add(fn); }

export async function loadRuns() {
  if (loading) return loading;
  loading = api('/api/runs').then((d) => { data = d; listeners.forEach((f) => f(data)); if (isOpen()) render(); return d; })
    .catch(() => data).finally(() => { loading = null; });
  return loading;
}

const allJobs = () => (data?.bots || []).flatMap((b) => b.jobs.map((j) => ({ ...j, bot: b.id })));
const ms = (s) => (s ? Date.parse(s) : NaN);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n || 0));

// "50 7 * * 1-5" -> "Weekdays at 7:50 AM". Common shapes only; anything else shows as written.
export function cronWords(expr) {
  // A one-time routine: "once at 2026-11-06 09:00" reads as a day and a time.
  const once = /^once at (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(String(expr || '').trim());
  if (once) {
    const d = new Date(Number(once[1]), Number(once[2]) - 1, Number(once[3]), Number(once[4]), Number(once[5]));
    return `Once, ${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${clock(d)}`;
  }
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length !== 5) return expr || '';
  const [mi, hr, dom, mon, dow] = p;
  const every = /^\*\/(\d+)$/.exec(mi);
  const DAYS = { '*': '', '1-5': ' on weekdays', '0,6': ' on weekends', '6,0': ' on weekends' };
  if (every && dom === '*' && mon === '*' && dow in DAYS) {
    const span = /^(\d+)-(\d+)$/.exec(hr);
    const hrs = hr === '*' ? '' : span ? `, ${clock(new Date(2026, 0, 1, Number(span[1]), 0))} to ${clock(new Date(2026, 0, 1, Number(span[2]), 0))}` : null;
    if (hrs != null) return `Every ${every[1]} min${hrs}${DAYS[dow]}`;
  }
  if (!/^\d+$/.test(mi) || !/^[\d,]+$/.test(hr) || dom !== '*' || mon !== '*') return expr;
  const times = hr.split(',').map((x) => clock(new Date(2026, 0, 1, Number(x), Number(mi)))).join(', ');
  const days = { '*': 'Daily', '1-5': 'Weekdays', '0,6': 'Weekends', '6,0': 'Weekends', 1: 'Mondays', 2: 'Tuesdays', 3: 'Wednesdays', 4: 'Thursdays', 5: 'Fridays', 6: 'Saturdays', 0: 'Sundays' }[dow];
  return days ? `${days} at ${times}` : `${times} (days ${dow})`;
}

// A watch: a routine that ticks every few minutes and only wakes its bot when something changed. Its
// ticks are not runs worth listing one by one; Runs shows one line per watch with how often it woke.
export const isWatch = (j) => /^\*\/\d+$/.test(String(j?.schedule || '').trim().split(/\s+/)[0] || '');
const watchIds = () => new Set(allJobs().filter(isWatch).map((j) => `${j.bot}/${j.id}`));
const realRuns = () => { const w = watchIds(); return (data?.bots || []).flatMap((b) => b.today).filter((r) => !w.has(`${r.bot}/${r.job_id}`)); };

// Claude sessions the bots started that are still working (the team's own ledger, via GET /api/runs).
export const claudeWorking = () => data?.claude?.running || [];
const claudeQueued = () => data?.claude?.queued || [];
const since = (t) => { const m = Math.max(1, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

// One line for the home screen: how today went and what is next.
export function runsSummary() {
  if (!data) return null;
  const today = realRuns();
  const done = today.filter((r) => r.status === 'completed').length;
  const failed = today.filter((r) => r.status === 'failed').length;
  const running = today.filter((r) => r.status === 'running' || r.status === 'claimed').length;
  const next = allJobs().filter((j) => !j.paused && !j.finished && !isWatch(j) && ms(j.next_at) > Date.now()).sort((a, b) => ms(a.next_at) - ms(b.next_at))[0];
  const parts = [];
  const cw = claudeWorking().length;
  if (cw) parts.push(`${cw} Claude ${cw === 1 ? 'session' : 'sessions'} working`);
  if (running) parts.push(`${running} running`);
  parts.push(`${done} done`);
  if (failed) parts.push(`${failed} failed`);
  if (next) parts.push(`next ${firstName(next.bot)} ${clock(ms(next.next_at))}`);
  return { text: parts.join(' · '), failed, parts, failedWord: failed ? `${failed} failed` : '' };
}

const isOpen = () => document.body.classList.contains('runs-open');

export function initRuns({ back }) {
  el = $('#runs-pane');
  // The back button, the fade and the toast stay put; only the scroll content is rebuilt.
  const backBtn = h('button', { class: 'back glass rn-back', type: 'button', dataset: { act: 'back' }, 'aria-label': 'Back' });
  backBtn.innerHTML = '<svg viewBox="0 0 12 21" width="12" height="20" aria-hidden="true"><path d="M10 1.8 1.8 10.5l8.2 8.7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const addBtn = h('button', { class: 'rn-add', type: 'button', dataset: { act: 'new' } }, h('span', { 'aria-hidden': 'true' }, '+'), 'New routine');
  el.replaceChildren(h('div', { class: 'rn-scroll' }), h('div', { class: 'fade-top', 'aria-hidden': 'true' }, h('i'), h('i')), backBtn, addBtn, h('div', { class: 'rn-toast', role: 'status' }));
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="back"]')) { back(); return; }
    if (e.target.closest('[data-act="new"]')) { routineSheet(null); return; }
    const fin = e.target.closest('[data-finished]');
    if (fin) { const b = fin.dataset.finished; if (showFinished.has(b)) showFinished.delete(b); else showFinished.add(b); render(); return; }
    const ed = e.target.closest('[data-edit-job]');
    if (ed) { const [b, id] = ed.dataset.editJob.split('/'); routineSheet(allJobs().find((j) => j.bot === b && j.id === id)); return; }
    const act = e.target.closest('[data-run-act]');
    if (act) {
      const { bot, job, runAct } = act.dataset;
      const key = `${bot}/${job}`;
      if (busy.has(key)) return;
      busy.add(key);
      render();
      try {
        await post(`/api/runs/${bot}/${job}/${runAct}`);
        toastLine(runAct === 'run' ? 'Queued. It runs within a minute.' : runAct === 'pause' ? 'Paused.' : 'Resumed.');
      } catch (err) {
        toastLine(err?.message || 'That did not work.');
      }
      busy.delete(key);
      await loadRuns();
      return;
    }
    const row = e.target.closest('[data-job]');
    if (row) { openJob = openJob === row.dataset.job ? null : row.dataset.job; render(); }
  });
  setInterval(() => { if (isOpen() || document.visibilityState === 'visible') loadRuns(); }, 120000);
}

function routineSheet(job) {
  openRoutineSheet({
    job,
    done: async (saved, editing) => {
      toastLine(editing ? 'Saved.' : `Added. ${firstName(saved?.bot || '')} has it on Runs now.`);
      await loadRuns();
      if (saved) { openJob = `${saved.bot}/${saved.id}`; render(); }
    },
  });
}

let toastTimer = 0;
function toastLine(text) {
  const t = el.querySelector('.rn-toast');
  if (!t) return;
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2400);
}

export function showRuns() {
  document.body.classList.add('runs-open');
  el.setAttribute('aria-hidden', 'false');
  render();
  loadRuns();
}

export function hideRuns() {
  document.body.classList.remove('runs-open');
  el?.setAttribute('aria-hidden', 'true');
  openJob = null;
}

export const runsOpen = isOpen;

const statusOf = (r) => (r.status === 'completed' ? ['ok', 'Done'] : r.status === 'failed' ? ['bad', 'Failed'] : r.status === 'running' || r.status === 'claimed' ? ['live', 'Running'] : ['', r.status]);

function render() {
  if (!el) return;
  const scroll = el.querySelector('.rn-scroll');
  const top = scroll?.scrollTop || 0;
  const kids = [];
  const sum = runsSummary();
  kids.push(h('div', { class: 'rn-title' }, h('h1', {}, 'Runs'), h('div', { class: 'rn-sub' }, sum ? sum.text : 'Loading…')));
  if (data) kids.push(dayStrip());
  if (data) {
    // Claude sessions the bots handed work to: what is being worked on right now, and what waits for a slot.
    const cw = claudeWorking(), cq = claudeQueued();
    if (cw.length || cq.length) {
      kids.push(h('div', { class: 'sec-label' }, 'Claude sessions'));
      kids.push(h('div', { class: 'cells rn-tl rn-claude' },
        ...cw.map((j) => h(j.url ? 'a' : 'div', { class: 'rn-ev', ...(j.url ? { href: j.url, target: '_blank', rel: 'noopener' } : {}) },
          h('span', { class: 'rn-t num' }, j.started ? clock(j.started) : ''),
          h('span', { class: 'rn-dot live' }),
          h('div', { class: 'rn-tx' }, h('b', {}, j.title), h('span', {}, `${j.bot ? firstName(j.bot) : j.who} \u00b7 working${j.started ? ` ${since(j.started)}` : ''}${j.url ? ' \u00b7 open it' : ''}`)))),
        ...cq.map((j) => h('div', { class: 'rn-ev' },
          h('span', { class: 'rn-t num' }, j.created ? clock(j.created) : ''),
          h('span', { class: 'rn-dot' }),
          h('div', { class: 'rn-tx' }, h('b', {}, j.title), h('span', {}, `${j.bot ? firstName(j.bot) : j.who} \u00b7 waiting for a slot${j.created ? ` ${since(j.created)}` : ''}`))))));
    }
    const jobsById = new Map(allJobs().map((j) => [`${j.bot}/${j.id}`, j]));
    // Today, oldest first.
    const today = realRuns().sort((a, b) => ms(a.started_at) - ms(b.started_at));
    // Watches: one line each, how many checks today and how often they woke the bot.
    const watches = allJobs().filter((j) => isWatch(j) && !j.paused && !j.finished);
    if (watches.length) {
      const checks = (j) => (data.bots.find((b) => b.id === j.bot)?.today || []).filter((r) => r.job_id === j.id).length;
      kids.push(h('div', { class: 'sec-label' }, 'Watching'));
      kids.push(h('div', { class: 'cells rn-tl' }, watches.map((j) => h('div', { class: 'rn-ev' },
        h('span', { class: 'rn-t num' }, cronWords(j.schedule).replace(/^Every (\d+) min.*$/, '$1 min')),
        h('span', { class: `rn-dot${j.last_status && j.last_status !== 'ok' ? ' bad' : ' ok'}` }),
        h('div', { class: 'rn-tx' }, h('b', {}, j.name), h('span', {}, `${firstName(j.bot)} · ${checks(j)} checks today · ${j.woke_today ? `woke ${j.woke_today}×` : 'nothing needed'}`))))));
    }
    if (today.length) {
      kids.push(h('div', { class: 'sec-label' }, 'Today'));
      kids.push(h('div', { class: 'cells rn-tl' }, today.map((r) => {
        const j = jobsById.get(`${r.bot}/${r.job_id}`);
        const [cls, word] = statusOf(r);
        return h('div', { class: 'rn-ev' },
          h('span', { class: 'rn-t num' }, clock(ms(r.started_at))),
          h('span', { class: `rn-dot ${cls}` }),
          h('div', { class: 'rn-tx' }, h('b', {}, j?.name || 'Routine'), h('span', { class: cls === 'bad' ? 'bad' : '' }, `${firstName(r.bot)} · ${word}${r.error ? ` · ${r.error.slice(0, 60)}` : ''}`)));
      })));
    }
    // Coming up in the next 24 hours.
    const soon = allJobs().filter((j) => !j.paused && !j.finished && !isWatch(j) && ms(j.next_at) > Date.now() && ms(j.next_at) < Date.now() + 86400000)
      .sort((a, b) => ms(a.next_at) - ms(b.next_at)).slice(0, 8);
    if (soon.length) {
      kids.push(h('div', { class: 'sec-label' }, 'Coming up'));
      kids.push(h('div', { class: 'cells rn-tl' }, soon.map((j) => h('div', { class: 'rn-ev' },
        h('span', { class: 'rn-t num' }, clock(ms(j.next_at))),
        h('span', { class: 'rn-dot' }),
        h('div', { class: 'rn-tx' }, h('b', {}, j.name), h('span', {}, firstName(j.bot)))))));
    }
    // Every routine, by bot.
    for (const b of data.bots || []) {
      if (!b.jobs.length) continue;
      kids.push(h('div', { class: 'sec-label rn-bot' }, avatar(b.id, 22), h('span', {}, `${firstName(b.id)} · ${b.week.runs} runs this week · ${fmtTokens(b.week.tokens)} tokens`)));
      // One-time routines that already ran fold away under one row (11-09: last week's sat in the list as "Paused").
      const live = b.jobs.filter((j) => !j.finished);
      const gone = b.jobs.filter((j) => j.finished);
      const open = showFinished.has(b.id);
      kids.push(h('div', { class: 'cells' }, ...live.map((j) => jobRow(b.id, j)),
        gone.length ? h('button', { class: 'need more rn-fin', type: 'button', dataset: { finished: b.id }, 'aria-expanded': String(open) }, h('span', { class: 'need-tx' }, h('b', {}, open ? 'Hide finished' : `${gone.length} finished one-time ${gone.length === 1 ? 'routine' : 'routines'}`))) : null,
        ...(open ? gone.map((j) => jobRow(b.id, j)) : [])));
    }
  }
  scroll.replaceChildren(h('div', { class: 'rn-inner' }, ...kids));
  scroll.scrollTop = top;
}

// Today as a strip (Vesper 10-30): one lane per bot, its friend at the start of the lane (identity is the
// lane and the face, never color alone), a tick for every run that woke it, hollow ticks for what is still
// coming today, failed runs in red with a ring, and a hairline for now. Tap a tick for what ran and when.
const DAY_MS = 86400000;
function dayStrip() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  const pos = (t) => `${Math.min(100, Math.max(0, ((t - t0) / DAY_MS) * 100)).toFixed(2)}%`;
  const names = new Map(allJobs().map((j) => [`${j.bot}/${j.id}`, j.name]));
  const tip = h('div', { class: 'ds-tip', role: 'status', 'aria-live': 'polite' }, 'Tap a mark to see what ran');
  const lanes = (data.bots || []).map((b) => {
    const color = friendColor(b.id) || 'var(--blue)';
    const ran = (b.activity || []).filter((x) => x.at >= t0);
    const soon = b.jobs.filter((j) => !j.paused && !j.finished && !isWatch(j) && ms(j.next_at) > Date.now() && ms(j.next_at) < t0 + DAY_MS);
    const tick = (at, cls, label) => h('button', { class: `ds-tick ${cls}`, type: 'button', style: { left: pos(at), '--c': color }, dataset: { tip: label }, 'aria-label': label });
    const ticks = [
      ...ran.map((x) => tick(x.at, x.error ? 'bad' : 'ran', `${firstName(b.id)} · ${names.get(`${b.id}/${x.job_id}`) || 'Routine'} · ${clock(x.at)}${x.error ? ' · failed' : ''}`)),
      ...soon.map((j) => tick(ms(j.next_at), 'soon', `${firstName(b.id)} · ${j.name} · coming at ${clock(ms(j.next_at))}`)),
    ];
    return h('div', { class: 'ds-lane' }, avatar(b.id, 24), h('div', { class: 'ds-track' }, ...ticks), h('span', { class: 'ds-n num', 'aria-label': `${ran.length} runs` }, String(ran.length)));
  });
  const nowF = Math.min(1, Math.max(0, (Date.now() - t0) / DAY_MS)).toFixed(4);
  const box = h('div', { class: 'ds' },
    h('div', { class: 'ds-head' }, h('b', {}, 'Today'), h('span', { class: 'ds-key' },
      h('i', { class: 'k-ran' }), 'Ran', h('i', { class: 'k-soon' }), 'Coming up', h('i', { class: 'k-bad' }), 'Failed')),
    h('div', { class: 'ds-lanes', style: { '--now-f': nowF } }, ...lanes, h('span', { class: 'ds-now', 'aria-hidden': 'true' })),
    h('div', { class: 'ds-axis num', 'aria-hidden': 'true' }, ...['12 AM', '6 AM', '12 PM', '6 PM', '12 AM'].map((l, i) => h('span', { style: { left: `${i * 25}%` } }, l))),
    tip);
  box.addEventListener('click', (e) => { const t = e.target.closest('.ds-tick'); if (t) { tip.textContent = t.dataset.tip; for (const x of box.querySelectorAll('.ds-tick.sel')) x.classList.remove('sel'); t.classList.add('sel'); } });
  box.addEventListener('pointerover', (e) => { const t = e.target.closest('.ds-tick'); if (t && e.pointerType === 'mouse') tip.textContent = t.dataset.tip; });
  return box;
}

function jobRow(bot, j) {
  const open = openJob === `${bot}/${j.id}`;
  const failing = j.last_status && j.last_status !== 'ok';
  const state = j.finished ? (failing ? 'Ran and failed' : 'Ran') : j.paused ? 'Paused' : failing ? `Last run failed${j.failures > 1 ? ` (${j.failures} in a row)` : ''}` : j.last_at ? `Last ran ${clock(ms(j.last_at))}` : 'Not run yet';
  const key = `${bot}/${j.id}`;
  const row = h('div', { class: `rn-job${open ? ' open' : ''}${j.paused || j.finished ? ' paused' : ''}` },
    h('button', { class: 'rn-jhead', type: 'button', dataset: { job: key }, 'aria-expanded': String(open) },
      h('div', { class: 'rn-tx' }, h('b', {}, j.name), h('span', { class: failing ? 'bad' : '' }, `${cronWords(j.schedule)} · ${state}`)),
      j.week ? h('span', { class: 'rn-tok num' }, fmtTokens(j.week.tokens)) : null,
      icon('chevron')));
  if (open) {
    const b = busy.has(key);
    row.append(h('div', { class: 'rn-body' },
      j.last_error && failing ? h('div', { class: 'rn-err' }, j.last_error) : null,
      h('div', { class: 'rn-prompt' }, j.prompt.length > 900 ? `${j.prompt.slice(0, 900)}…` : j.prompt),
      h('div', { class: 'rn-acts' },
        h('button', { class: 'rn-btn pri', type: 'button', disabled: b || j.paused || j.finished, dataset: { runAct: 'run', bot, job: j.id } }, 'Run now'),
        j.finished ? null : h('button', { class: 'rn-btn', type: 'button', disabled: b, dataset: { runAct: j.paused ? 'resume' : 'pause', bot, job: j.id } }, j.paused ? 'Resume' : 'Pause'),
        h('button', { class: 'rn-btn', type: 'button', disabled: b, dataset: { editJob: key } }, 'Edit')),
      j.week ? h('div', { class: 'rn-meta' }, `This week: ${j.week.runs} runs${j.week.failed ? `, ${j.week.failed} failed` : ''}, ${fmtTokens(j.week.tokens)} tokens, about ${Math.round(j.week.ms / Math.max(1, j.week.runs) / 1000)} s a run`) : null));
  }
  return row;
}

// The home screen's Runs row icon.
export const runsGlyph = () => GLYPHS.clock || GLYPHS.task;
