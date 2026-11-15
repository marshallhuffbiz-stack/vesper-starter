// Bot details: opens from the header name capsule as a uniform zoom (docs/messages-motion.md: full
// size by ~250 ms, settled ~550 ms), closes by reversing it, and the left-edge swipe shrinks it to a
// card that follows the finger. Only true information and working controls. It never touches #msgs.
import { $, h, toMs, reducedMotion, toast } from './util.js';
import { state, member, firstName, typers } from './store.js';
import { avatar, chatAvatar, dmPartner } from './avatar.js';
import { api, post } from './api.js';
import { pushStatus, enablePush, testPush } from './push.js';
import { cronWords } from './runs.js';
import { appMark, appFor, pairOf, taskTitle, gist, clientMark, friendColor } from './marks.js';

const OPEN = { duration: 520, easing: 'cubic-bezier(.2,.9,.22,1)' };
const CLOSE = { duration: 380, easing: 'cubic-bezier(.32,.72,0,1)' };
let el = null;
let open = null; // {chatId, anim}
let hooks = { goBack() {}, openChat() {}, focusOn() {} };

export function initDetails(opts) {
  hooks = { ...hooks, ...opts };
  el = h('section', { id: 'details', class: 'details', 'aria-label': 'Details', hidden: true });
  $('#app').append(el);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const id = open?.chatId;
    if (b.dataset.act === 'back' || b.dataset.act === 'message') closeDetails();
    else if (b.dataset.act === 'room') { closeDetails(true); hooks.openChat('room'); }
    else if (b.dataset.act === 'approvals') {
      const m = waiting(id)[0];
      closeDetails();
      if (m) hooks.focusOn(m.id);
    } else if (b.dataset.act === 'member') { closeDetails(true); hooks.openChat(`dm-${b.dataset.id}`); }
    else if (b.dataset.act === 'memory') { b.closest('.dt-mem')?.classList.toggle('open'); b.textContent = b.closest('.dt-mem')?.classList.contains('open') ? 'Show less' : 'Show all'; }
    else if (b.dataset.act === 'revoke') revoke(b);
    else if (b.dataset.act === 'runs') { closeDetails(true); hooks.openRuns?.(); }
  });
  // The per-client pause switch (10-31): holds every outbound thing for that client until it is turned off.
  el.addEventListener('change', (e) => {
    const t = e.target.closest('input[data-pause]');
    if (t) setPause(t);
    const r = e.target.closest('input[data-rule]');
    if (r) saveRules(r.dataset.rule === 'botToBot' ? { botToBot: r.checked } : { muted: [...el.querySelectorAll('input[data-rule="mute"]:checked')].map((x) => x.dataset.id) });
  });
  el.addEventListener('click', (e) => {
    const c = e.target.closest('[data-chain]');
    if (c && !c.disabled) saveRules({ chainCap: Number(c.dataset.chain) });
    const more = e.target.closest('[data-audit-more]');
    if (more) { more.closest('.dt-audit')?.classList.add('all'); more.remove(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) { e.stopImmediatePropagation(); closeDetails(); }
  }, true);
  edgeSwipe();
}

export const detailsOpen = () => !!open;

// Messages in this chat with unanswered buttons, oldest first.
function waiting(chatId) {
  const t = state.threads.get(chatId);
  return (t?.messages || []).filter((m) => m.buttons && m.buttons.length && !m.resolved);
}

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

function statusLine(id) {
  const m = member(id);
  for (const chat of state.chats.values()) {
    const ty = typers(chat.id).find((t) => t.id === id);
    if (ty) return { text: ty.status || `Typing in ${chat.title || 'a chat'}`, on: true };
  }
  return { text: m.online ? 'Online' : 'Offline', on: !!m.online };
}

function card(title, ...kids) {
  return h('div', { class: 'dt-group' }, h('div', { class: 'dt-gtitle' }, title), h('div', { class: 'dt-card' }, ...kids));
}

function action(act, label, svg, disabled = false, badge = '') {
  const b = h('button', { class: 'dt-act', type: 'button', dataset: { act }, disabled }, h('span', { class: 'dt-act-ic glass' }), h('span', { class: 'dt-act-l' }, label));
  b.firstChild.innerHTML = svg;
  if (badge) b.firstChild.append(h('span', { class: 'dt-badge' }, badge));
  return b;
}

const SVG = {
  msg: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 4.5c4.7 0 8.5 3 8.5 6.8s-3.8 6.8-8.5 6.8c-.9 0-1.8-.1-2.6-.3L5 19.6l1.2-3.4C4.5 14.9 3.5 13.2 3.5 11.3 3.5 7.5 7.3 4.5 12 4.5z" fill="currentColor"/></svg>',
  room: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="8" cy="9" r="3" fill="currentColor"/><circle cx="16.5" cy="9" r="3" fill="currentColor"/><path d="M2.5 18.5c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6zM12.2 15c.9-.7 2.3-1.1 4.3-1.1 2.7 0 4.9 1.6 5.5 4.6h-8.3" fill="currentColor"/></svg>',
  appr: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function build(chatId) {
  const chat = state.chats.get(chatId);
  const room = chat.kind === 'room';
  const bot = room ? null : dmPartner(chat);
  const m = bot ? member(bot) : null;
  const wait = waiting(chatId);
  const kids = [];
  const head = h('div', { class: 'dt-hero' },
    room ? chatAvatar(chat, 80) : avatar(bot, 80, { dot: false }),
    h('div', { class: 'dt-name' }, room ? (chat.title || 'Room') : m.name));
  if (room) {
    const bots = (chat.members || []).filter((id) => member(id).kind === 'bot');
    head.append(h('div', { class: 'dt-sub' }, `${bots.length} bots`));
  } else {
    const sub = [m.role, (m.clients || []).join(', ')].filter(Boolean).join(' · ');
    if (sub) head.append(h('div', { class: 'dt-sub' }, sub));
    const st = statusLine(bot);
    head.append(h('div', { class: `dt-status${st.on ? ' on' : ''}` }, st.text));
  }
  kids.push(head);
  const acts = h('div', { class: 'dt-acts' }, action('message', 'Message', SVG.msg));
  if (!room && state.chats.has('room')) acts.append(action('room', 'Room', SVG.room));
  acts.append(action('approvals', 'Approvals', SVG.appr, !wait.length, wait.length ? String(wait.length) : ''));
  kids.push(acts);

  if (room) {
    kids.push(card('Members', ...(chat.members || []).filter((id) => member(id).kind === 'bot').map((id) => {
      const st = statusLine(id);
      return h('button', { class: 'dt-row dt-member', type: 'button', dataset: { act: 'member', id } },
        avatar(id, 36, { dot: false }),
        h('span', { class: 'dt-mtext' }, h('span', { class: 'dt-mname' }, member(id).name), h('span', { class: `dt-mst${st.on ? ' on' : ''}` }, st.text)));
    })));
    // Room rules and the auto log (10-31), filled from /api/room/rules and /api/audit.
    kids.push(h('div', { class: 'dt-rules' }, h('div', { class: 'dt-row dt-empty' }, 'Loading room rules…')));
    kids.push(h('div', { class: 'dt-audit' }));
    kids.push(notifyCard());
    fillRoom();
  } else {
    const cl = m.clients || [];
    kids.push(card('Clients', ...(cl.length ? cl.map((c) => h('label', { class: 'dt-row dt-client' }, clientMark(c, 30),
      h('span', { class: 'dt-cl' }, c, h('small', { dataset: { pst: c } }, '')),
      h('input', { type: 'checkbox', class: 'rt-tog pause', role: 'switch', disabled: true, hidden: !PAUSABLE.has(c), 'aria-label': `Pause ${c}`, dataset: { pause: c } }))) : [h('div', { class: 'dt-row dt-empty' }, 'No clients')])));
    fillPauses();
    const since = startOfToday();
    let today = 0, appr = 0;
    for (const t of state.threads.values()) {
      for (const x of t.messages) {
        if (x.sender !== bot) continue;
        if (toMs(x.at) >= since) today++;
        if (x.buttons && x.buttons.length && !x.resolved) appr++;
      }
    }
    kids.push(card('Today',
      h('div', { class: 'dt-row dt-kv' }, h('span', null, 'Messages'), h('span', { class: 'dt-v' }, String(today))),
      h('div', { class: 'dt-row dt-kv' }, h('span', null, 'Waiting on you'), h('span', { class: 'dt-v' }, String(appr)))));
    // Vesper: routines, the week, Always rules, memory and recent actions, from the bot's own Hermes
    // profile and the team outbox (GET /api/agents/<id>), filled in when they arrive.
    kids.push(h('div', { class: 'dt-more', dataset: { bot } }, h('div', { class: 'dt-row dt-empty' }, 'Loading routines and memory…')));
    fillAgent(bot);
  }
  const imgs = [];
  for (const x of state.threads.get(chatId)?.messages || []) for (const a of x.attachments || []) if (String(a.type || '').startsWith('image/')) imgs.push(a);
  kids.push(card('Shared photos', imgs.length
    ? h('div', { class: 'dt-photos' }, ...imgs.slice(-12).reverse().map((a) => h('img', { src: a.preview || a.url, alt: a.name || 'Photo', loading: 'lazy', decoding: 'async', draggable: 'false' })))
    : h('div', { class: 'dt-row dt-empty' }, 'No photos yet')));

  const scroll = h('div', { class: 'dt-scroll' }, h('div', { class: 'dt-inner' }, ...kids));
  const back = h('button', { class: 'back glass dt-back', type: 'button', dataset: { act: 'back' }, 'aria-label': 'Back to chat' });
  back.innerHTML = '<svg viewBox="0 0 12 21" width="12" height="20" aria-hidden="true"><path d="M10 1.8 1.8 10.5l8.2 8.7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  el.replaceChildren(scroll, h('div', { class: 'fade-top dt-fade', 'aria-hidden': 'true' }, h('i'), h('i')), back, h('div', { class: 'edge-grab dt-grab', 'aria-hidden': 'true' }));
}

// Notifications (11-02, "I feel like I'm not getting notifications"): where this device stands, Turn on, and a
// test that rings every subscribed device so he can see it work.
function notifyCard() {
  const box = h('div', { class: 'dt-notify' });
  const paint = () => {
    const st = pushStatus();
    const btn = st.mode === 'on' ? h('button', { class: 'dt-row dt-link', type: 'button' }, 'Send a test notification')
      : st.mode === 'ask' ? h('button', { class: 'dt-row dt-link', type: 'button' }, 'Turn on notifications') : null;
    btn?.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        if (st.mode === 'ask') {
          if (!(await enablePush())) toast('Notifications stay off.');
          paint();
          return;
        }
        const r = await testPush();
        toast(r?.ok ? `Sent to ${r.sent === 1 ? 'your phone' : `${r.sent} devices`}. It should ring in a few seconds.` : 'No device took it. Turn notifications off and on again on your phone.');
      } catch { toast('The test did not go out. Try again.'); }
      btn.disabled = false;
    });
    box.replaceChildren(card('Notifications', h('div', { class: 'dt-row dt-cl' }, st.text), ...(btn ? [btn] : [])));
  };
  paint();
  return box;
}

const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n || 0));
const KIND = { ads: 'ad edits', posts: 'posts', site: 'website fixes', listing: 'listing updates' };
const STATUS = { done: 'Sent', approved: 'Approved', rejected: 'Declined', changed: 'Changed', refused: 'Held back', failed: 'Failed', cancelled: 'Withdrawn', stopped: 'Stopped', posted: 'Waiting on you', pending: 'Queued', running: 'Sending', unconfirmed: 'Probably sent' };

// ── room rules and the auto log ──
const CHAINS = [2, 4, 6, 8];
const AUDIT_SHOWN = 6;
const AUDIT_STATUS = { done: 'Done', unconfirmed: 'Sent', running: 'Sending', grace: 'Waiting to send', doing: 'Working', approved: 'Working', stopped: 'Stopped', refused: 'Held back', failed: 'Failed', cancelled: 'Withdrawn', posted: 'Turned into a card', pending: 'Queued' };
function rulesCard(r) {
  const bots = state.chats.get('room')?.members?.filter((id) => member(id)?.kind === 'bot') || [];
  return card('Room rules',
    h('label', { class: 'dt-row dt-rule' }, h('span', { class: 'dt-cl' }, 'Bots talk to each other', h('small', {}, r.botToBot ? 'A bot can ask another bot in the room' : 'Bots answer only you')),
      h('input', { type: 'checkbox', class: 'rt-tog', role: 'switch', checked: r.botToBot, dataset: { rule: 'botToBot' }, 'aria-label': 'Bots talk to each other' })),
    h('div', { class: 'dt-row dt-rule' }, h('span', { class: 'dt-cl' }, 'Bot turns in a row', h('small', {}, 'Then the room waits for you')),
      h('span', { class: 'dt-seg', role: 'group', 'aria-label': 'Bot turns in a row' }, ...CHAINS.map((n) => h('button', { type: 'button', class: `dt-segb${n === r.chainCap ? ' on' : ''}`, dataset: { chain: n }, disabled: !r.botToBot, 'aria-pressed': String(n === r.chainCap) }, String(n))))),
    ...bots.map((id) => h('label', { class: 'dt-row dt-rule' }, avatar(id, 30, { dot: false }),
      h('span', { class: 'dt-cl' }, `Mute ${member(id).name}`, h('small', {}, r.muted.includes(id) ? 'Wakes only when you name them' : 'Answers in the room as usual')),
      h('input', { type: 'checkbox', class: 'rt-tog pause', role: 'switch', checked: r.muted.includes(id), dataset: { rule: 'mute', id }, 'aria-label': `Mute ${member(id).name} in the room` }))));
}
function auditCard(a) {
  const items = a.items || [];
  const rows = items.map((x, i) => h('div', { class: `dt-row dt-aud${i >= AUDIT_SHOWN ? ' extra' : ''}` }, appMark(x.kind === 'text' ? 'sms' : x.kind === 'email' ? 'gmail' : appFor(x.what), 30),
    h('span', { class: 'dt-cl' }, x.what ? x.what[0].toUpperCase() + x.what.slice(1) : 'Action', h('small', {}, [x.who, x.client, x.why, new Date(x.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' · '))),
    h('span', { class: `dt-aud-st st-${x.status}` }, AUDIT_STATUS[x.status] || x.status)));
  return card('Done without a tap',
    ...(rows.length ? rows : [h('div', { class: 'dt-row dt-empty' }, a.ok === false ? 'The team outbox is not readable right now' : 'Nothing in the last 14 days')]),
    ...(items.length > AUDIT_SHOWN ? [h('button', { class: 'dt-row dt-link', type: 'button', dataset: { auditMore: '1' } }, `Show all ${items.length}`)] : []));
}
async function fillRoom() {
  const [rules, audit] = await Promise.all([api('/api/room/rules').catch(() => null), api('/api/audit').catch(() => ({ ok: false, items: [] }))]);
  const r = el.querySelector('.dt-rules');
  if (r) r.replaceChildren(rules ? rulesCard(rules.rules) : h('div', { class: 'dt-row dt-empty' }, 'Room rules did not load'));
  const a = el.querySelector('.dt-audit');
  if (a) a.replaceChildren(auditCard(audit));
}
async function saveRules(patch) {
  const box = el.querySelector('.dt-rules');
  for (const x of box?.querySelectorAll('input, button') || []) x.disabled = true;
  let out = null;
  try { out = await post('/api/room/rules', patch); } catch { /* the card reloads below with what the server has */ }
  const now = out?.rules || (await api('/api/room/rules').catch(() => null))?.rules;
  if (box && now) box.replaceChildren(rulesCard(now));
}

// Clients with a pause switch: the ones a teamops hook reports (GET /api/clients); none in this starter. Each
// client row has the switch hidden until the report names that client.
const PAUSABLE = { has: (short) => !!clientIds[short] };
let clientIds = {};
const pauseNote = (c) => (c.paused ? `Paused${c.since ? ` since ${new Date(c.since).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}: nothing goes out` : 'Pause holds every send and change');
function showPause(c) {
  for (const t of el.querySelectorAll(`input[data-pause="${CSS.escape(c.short)}"]`)) { t.checked = c.paused; t.disabled = false; t.hidden = false; }
  for (const s of el.querySelectorAll(`[data-pst="${CSS.escape(c.short)}"]`)) { s.textContent = pauseNote(c); s.classList.toggle('on', c.paused); }
}
async function fillPauses() {
  let out;
  try { out = await api('/api/clients'); } catch { return; }
  for (const c of out.clients || []) { clientIds[c.short] = c.id; showPause(c); }
}
async function setPause(t) {
  const id = clientIds[t.dataset.pause];
  if (!id) { t.checked = !t.checked; return; }
  t.disabled = true;
  try {
    const out = await post(`/api/clients/${id}/pause`, { paused: t.checked });
    showPause(out.client);
  } catch {
    t.checked = !t.checked;
    t.disabled = false;
  }
}

async function fillAgent(bot) {
  let d;
  try { d = await api(`/api/agents/${bot}`); } catch { d = null; }
  const box = el?.querySelector(`.dt-more[data-bot="${bot}"]`);
  if (!box) return;
  if (!d) { box.replaceChildren(h('div', { class: 'dt-row dt-empty' }, 'Could not load routines and memory.')); return; }
  const groups = [];
  groups.push(card('This week', weekChart(bot, d)));
  const jobs = d.jobs.filter((j) => !j.finished); // one-time routines that already ran live on the Runs screen
  groups.push(card('Routines', ...(jobs.length ? jobs.map((j) => h('div', { class: 'dt-row dt-two' },
    h('span', { class: 'dt-l' }, j.name),
    h('span', { class: `dt-s${j.last_status && j.last_status !== 'ok' ? ' bad' : ''}` }, `${cronWords(j.schedule)}${j.paused ? ' · Paused' : j.last_status && j.last_status !== 'ok' ? ' · Last run failed' : ''}`)))
    : [h('div', { class: 'dt-row dt-empty' }, 'No routines')]),
    h('button', { class: 'dt-row dt-link', type: 'button', dataset: { act: 'runs' } }, 'Open Runs')));
  groups.push(card('Always rules', ...(d.rules.length ? d.rules.map((r) => h('div', { class: 'dt-row dt-rule' },
    h('span', { class: 'dt-l' }, `${r.client} ${KIND[r.kind] || r.kind}`, h('small', {}, `Since ${new Date(r.created).toLocaleDateString([], { month: 'short', day: 'numeric' })}, no tap needed`)),
    h('button', { class: 'dt-revoke', type: 'button', dataset: { act: 'revoke', id: r.id } }, 'Revoke')))
    : [h('div', { class: 'dt-row dt-empty' }, 'None. Everything asks you first.')])));
  const notes = String(d.memory.notes || '').split(/\n?§\n?/).map((x) => x.trim()).filter(Boolean);
  groups.push(card('Memory', notes.length
    ? h('div', { class: 'dt-mem' }, h('ul', {}, notes.map((n) => h('li', {}, n))), notes.length > 3 ? h('button', { class: 'dt-row dt-link', type: 'button', dataset: { act: 'memory' } }, 'Show all') : null)
    : h('div', { class: 'dt-row dt-empty' }, 'Nothing saved yet')));
  if (d.actions.length) {
    // Each action as its app, a plain title and how it ended; a receipt full of ids never shows here.
    groups.push(card('Recent actions', ...d.actions.slice(0, 6).map((a) => {
      const learn = /^Learn:/i.test(a.ask || '');
      const title = learn ? `Skill: ${String(a.ask).replace(/^Learn:\s*/i, '').replace(/[-_]+/g, ' ')}` : taskTitle(a.ask, a.client);
      const app = learn ? 'learn' : a.kind === 'text' ? 'sms' : a.kind === 'email' ? 'gmail' : appFor(title);
      const said = a.status === 'cancelled' || learn ? '' : gist(a.result, 120);
      const word = a.kind === 'task' && a.status === 'done' ? 'Done' : STATUS[a.status] || a.status;
      const status = [word, a.auto && a.status === 'done' ? 'on its own' : ''].filter(Boolean).join(' ');
      return h('div', { class: 'dt-row dt-did' },
        appMark(app, 30, pairOf(app, title)),
        h('span', { class: 'dt-two' },
          h('span', { class: 'dt-l' }, title),
          h('span', { class: `dt-s${a.status === 'failed' || a.status === 'refused' ? ' bad' : ''}` }, [status, said].filter(Boolean).join(' · '))));
    })));
  }
  // Start fresh (11-09): the bot's gateway begins a new conversation in this chat. The thread here stays; what
  // the bot was carrying in its head goes, which is the fix when it is stuck on an old idea. Two taps.
  const fresh = h('button', { class: 'dt-row dt-link', type: 'button' }, 'Start a fresh conversation');
  let armed = 0;
  fresh.addEventListener('click', async () => {
    if (!armed) { armed = setTimeout(() => { armed = 0; fresh.textContent = 'Start a fresh conversation'; }, 3500); fresh.textContent = 'Tap again to start fresh'; return; }
    clearTimeout(armed); armed = 0;
    fresh.disabled = true;
    try {
      const r = await post(`/api/chats/dm-${bot}/command`, { command: 'fresh', bot });
      toast(r?.online === false ? `${firstName(bot)} is offline. It starts fresh when it is back.` : `${firstName(bot)} starts fresh from your next message.`);
    } catch { toast('That did not go through. Try again.'); }
    fresh.disabled = false;
    fresh.textContent = 'Start a fresh conversation';
  });
  groups.push(card('Conversation', h('div', { class: 'dt-row dt-cl dt-note' }, h('span', { class: 'dt-cl' }, 'When a bot is stuck', h('small', {}, 'It forgets this chat\u2019s back-and-forth and keeps its memory, rules and routines. Every bot also starts fresh on its own each morning.'))), fresh));
  box.replaceChildren(...groups);
}

// The week as seven bars (runs that woke the bot each day, today in full color), one series, so no legend:
// the totals line says what is plotted. Tap a bar for that day's runs and tokens. Bars: 20px wide, 4px
// rounded tops, square on a hairline baseline; only today's value is labeled.
function weekChart(bot, d) {
  const days = Array.isArray(d.days) && d.days.length ? d.days : null;
  const total = h('div', { class: 'wk-total' },
    h('span', {}, h('b', { class: 'num' }, String(d.week.runs)), ` runs${d.week.failed ? `, ${d.week.failed} failed` : ''}`),
    h('span', {}, h('b', { class: 'num' }, fmtTok(d.week.tokens)), ' tokens'));
  if (!days) return h('div', { class: 'dt-row wk' }, total);
  const max = Math.max(1, ...days.map((x) => x.runs));
  const color = friendColor(bot) || 'var(--blue)';
  const tip = h('div', { class: 'wk-tip', role: 'status', 'aria-live': 'polite' });
  const show = (x) => {
    const when = new Date(`${x.day}T12:00:00`).toLocaleDateString([], { weekday: 'long' });
    tip.textContent = `${when}: ${x.runs} run${x.runs === 1 ? '' : 's'}${x.failed ? `, ${x.failed} failed` : ''}, ${fmtTok(x.tokens)} tokens`;
  };
  const bars = days.map((x, i) => {
    const today = i === days.length - 1;
    const hpx = x.runs ? Math.max(4, Math.round((x.runs / max) * 84)) : 0;
    const b = h('button', { class: `wk-col${today ? ' today' : ''}`, type: 'button', 'aria-label': `${x.day}: ${x.runs} runs, ${fmtTok(x.tokens)} tokens` },
      today && x.runs ? h('span', { class: 'wk-val num' }, String(x.runs)) : null,
      h('span', { class: 'wk-bar', style: { height: `${hpx}px`, background: color } }),
      h('span', { class: 'wk-day' }, new Date(`${x.day}T12:00:00`).toLocaleDateString([], { weekday: 'narrow' })));
    b.addEventListener('pointerenter', () => show(x));
    b.addEventListener('click', () => show(x));
    return b;
  });
  show(days[days.length - 1]);
  return h('div', { class: 'dt-row wk' }, total, h('div', { class: 'wk-plot' }, ...bars), tip);
}

async function revoke(b) {
  if (b.disabled) return;
  b.disabled = true;
  b.textContent = 'Revoking…';
  try {
    await post(`/api/rules/${b.dataset.id}/revoke`);
    const row = b.closest('.dt-rule');
    row.querySelector('small').textContent = 'Revoked. It asks you first again.';
    b.remove();
  } catch {
    b.disabled = false;
    b.textContent = 'Revoke';
  }
}

// The transform that lays the full screen over the header capsule: uniform scale to the capsule's
// width, top-aligned with it, centred horizontally (origin 0 0). Measured once per open or close.
function capsuleTransform() {
  const cap = $('#head-name').getBoundingClientRect();
  const W = el.offsetWidth;
  const s = Math.max(0.2, cap.width / W);
  return `translate3d(${cap.left + cap.width / 2 - (W * s) / 2}px, ${cap.top}px, 0) scale(${s})`;
}

export function openDetails(chatId) {
  if (open || !state.chats.has(chatId)) return;
  for (const a of el.getAnimations()) a.cancel();
  build(chatId);
  el.hidden = false;
  open = { chatId };
  document.body.classList.add('details-open');
  if (reducedMotion()) return;
  el.style.transformOrigin = '0 0';
  el.classList.add('morph');
  const a = el.animate([{ transform: capsuleTransform(), opacity: 0.5 }, { transform: 'none', opacity: 1 }], OPEN);
  el.firstChild.animate([{ transform: 'translateY(10px)' }, { transform: 'none' }], { duration: 560, easing: 'cubic-bezier(.3,.9,.3,1)' });
  open.anim = a;
  a.onfinish = () => el.classList.remove('morph');
}

export function closeDetails(instant = false) {
  if (!open) return;
  open = null;
  document.body.classList.remove('details-open');
  const done = () => { for (const a of el.getAnimations()) a.cancel(); el.hidden = true; el.classList.remove('morph'); el.style.transform = ''; el.replaceChildren(); };
  if (instant || reducedMotion()) { done(); return; }
  el.classList.add('morph');
  const cur = el.style.transform || 'none';
  el.style.transformOrigin = '0 0';
  const to = capsuleTransform();
  el.animate([{ transform: cur, opacity: 1 }, { transform: to, opacity: 0 }], { ...CLOSE, fill: 'forwards' }).onfinish = done;
}

// Left-edge swipe: the screen shrinks to a rounded card under the finger (scale 1 -> ~0.6 across
// the width) and drifts right; past a third of the width or on a flick it flies off to the right.
function edgeSwipe() {
  let s = null, raf = 0;
  const paint = () => {
    raf = 0;
    if (!s) return;
    const p = Math.min(1, s.dx / s.w);
    el.style.transform = `translate3d(${s.dx * 0.6}px, ${p * 40}px, 0) scale(${1 - 0.4 * p})`;
  };
  el.addEventListener('pointerdown', (e) => {
    if (!e.target.classList.contains('dt-grab') || !open) return;
    s = { x: e.clientX, y: e.clientY, dx: 0, w: el.offsetWidth, id: e.pointerId, locked: false, samples: [{ x: e.clientX, t: e.timeStamp }] };
    try { e.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  el.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x;
    if (!s.locked) {
      if (Math.abs(e.clientY - s.y) > 14 && Math.abs(e.clientY - s.y) > dx) { s = null; return; }
      if (dx < 4) return;
      s.locked = true;
      el.style.transformOrigin = '50% 50%';
      el.classList.add('morph');
    }
    s.dx = Math.max(0, dx);
    s.samples.push({ x: e.clientX, t: e.timeStamp });
    while (s.samples.length > 2 && e.timeStamp - s.samples[0].t > 100) s.samples.shift();
    if (!raf) raf = requestAnimationFrame(paint);
  });
  const end = (e) => {
    if (!s || e.pointerId !== s.id) return;
    const st = s; s = null;
    if (!st.locked) return;
    const a = st.samples[0], b = st.samples[st.samples.length - 1];
    const v = (b.x - a.x) / Math.max(16, b.t - a.t);
    const from = el.style.transform;
    if (st.dx > st.w / 3 || v > 0.5) {
      open = null;
      document.body.classList.remove('details-open');
      el.animate([{ transform: from, opacity: 1 }, { transform: `translate3d(${st.w * 0.7}px, 60px, 0) scale(.35)`, opacity: 0 }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' }).onfinish = () => {
        for (const x of el.getAnimations()) x.cancel(); el.hidden = true; el.classList.remove('morph'); el.style.transform = ''; el.replaceChildren();
      };
    } else {
      el.animate([{ transform: from }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' }).onfinish = () => el.classList.remove('morph');
      el.style.transform = '';
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
