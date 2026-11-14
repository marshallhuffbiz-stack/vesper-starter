// Later (11-06, the owner: reminders and "park this for later" should not go in the chat "because it'll be lost";
// they belong with the task list). The items live on the server (/api/later); a bot files them with team-later and
// he can park any message himself (long press, Remind me). Home shows them under Needs you; once one is due it
// moves up into Needs you and the phone rings once. This file holds the list, the time words and the two sheets.
import { h, toast } from './util.js';
import { state, on, emit, member } from './store.js';
import { api, post } from './api.js';

// ── the list ────────────────────────────────────────────────────────────────

export function setLater(items) {
  state.later = Array.isArray(items) ? items.filter((x) => x && !x.done_at) : [];
  armDueTimer();
  emit('later');
}

const isDue = (it, now = Date.now()) => it.due_at != null && it.due_at <= now;
// Due ones, oldest due first (they sit at the top of Needs you).
export const laterDue = () => (state.later || []).filter((it) => isDue(it)).sort((a, b) => a.due_at - b.due_at);
// Coming up (by when), then the ones parked with no date (newest first, as the server sends them).
export const laterUpcoming = () => (state.later || []).filter((it) => !isDue(it));

// Re-draw when the next one comes due, so it moves into Needs you on time even with the app open.
let dueTimer = 0;
function armDueTimer() {
  clearTimeout(dueTimer);
  const now = Date.now();
  const next = (state.later || []).filter((it) => it.due_at != null && it.due_at > now).reduce((m, it) => Math.min(m, it.due_at), Infinity);
  if (next !== Infinity) dueTimer = setTimeout(() => { armDueTimer(); emit('later'); }, Math.min(next - now + 250, 2 ** 31 - 1));
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { armDueTimer(); emit('later'); } });
}

function replace(item) {
  const rest = (state.later || []).filter((x) => x.id !== item.id);
  setLater(item.done_at ? rest : [...rest, item].sort(order));
}
function order(a, b) {
  if ((a.due_at == null) !== (b.due_at == null)) return a.due_at == null ? 1 : -1;
  if (a.due_at != null && a.due_at !== b.due_at) return a.due_at - b.due_at;
  return b.created_at - a.created_at;
}

async function patch(id, body) {
  const r = await api(`/api/later/${id}`, { method: 'PATCH', body });
  if (r?.item) replace(r.item);
  return r?.item;
}

// Done with Undo: the row eases out at once; Undo puts it back where it was.
export async function finish(it) {
  setLater((state.later || []).filter((x) => x.id !== it.id));
  try {
    await patch(it.id, { done: true });
    undoToast('Done', () => patch(it.id, { done: false }));
  } catch {
    replace(it);
    toast('Couldn’t mark that done. Try again.');
  }
}

export async function moveTo(it, due) {
  try {
    await patch(it.id, { due_at: due });
    toast(due == null ? 'Parked with no date' : `Moved to ${whenLabel(due)}`);
  } catch { toast('Couldn’t move that. Try again.'); }
}

async function remove(it) {
  setLater((state.later || []).filter((x) => x.id !== it.id));
  try { await api(`/api/later/${it.id}`, { method: 'DELETE' }); toast('Deleted'); }
  catch { replace(it); toast('Couldn’t delete that. Try again.'); }
}

let undoTimer = 0;
function undoToast(text, undo) {
  document.getElementById('lt-undo')?.remove();
  clearTimeout(undoTimer);
  const el = h('div', { id: 'lt-undo', class: 'lt-undo glass blur', role: 'status' },
    h('span', {}, text), h('button', { type: 'button' }, 'Undo'));
  el.querySelector('button').addEventListener('click', async () => {
    el.remove();
    try { await undo(); } catch { toast('Couldn’t undo that.'); }
  });
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  undoTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4000);
}

// ── time words ──────────────────────────────────────────────────────────────

const DAY = 86400000;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function clock(d) {
  const h12 = d.getHours() % 12 || 12;
  const ap = d.getHours() < 12 ? 'AM' : 'PM';
  return d.getMinutes() ? `${h12}:${String(d.getMinutes()).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}
// "Today 9 AM", "Tomorrow 9 AM", "Tue 9 AM", "Nov 18, 9 AM"; "Yesterday" and weekday words for the recent past.
export function whenLabel(t, now = Date.now()) {
  if (t == null) return 'No date';
  const d = new Date(t);
  const days = Math.round((startOfDay(t) - startOfDay(now)) / DAY);
  const c = clock(d);
  if (days === 0) return `Today ${c}`;
  if (days === 1) return `Tomorrow ${c}`;
  if (days === -1) return `Yesterday ${c}`;
  if (Math.abs(days) < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${c}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${c}`;
}

const at = (base, hour, minute = 0) => { const d = new Date(base); d.setHours(hour, minute, 0, 0); return d.getTime(); };
// The quick picks, like Reminders: soon, this evening (until 5 PM), tomorrow morning, next Monday, no date.
export function choices(now = Date.now()) {
  const out = [];
  const hour = Math.ceil((now + 3600000) / 300000) * 300000;
  out.push({ key: 'hour', label: 'In 1 hour', due: hour });
  if (new Date(now).getHours() < 17) out.push({ key: 'evening', label: 'This evening', due: at(now, 18) });
  out.push({ key: 'tomorrow', label: 'Tomorrow', due: at(now + DAY, 9) });
  const d = new Date(now);
  const toMon = ((8 - d.getDay()) % 7) || 7;
  out.push({ key: 'monday', label: toMon === 1 ? 'Monday' : 'Next week', due: at(now + toMon * DAY, 9) });
  out.push({ key: 'none', label: 'No date', due: null });
  return out;
}

const localInput = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// The chips plus "Pick a time": calls pick(due) with ms or null. instant (an item's sheet): a chip moves it at once and
// a picked time waits for Set; otherwise (the add sheet) a chip only marks the choice.
function whenPicker(pick, { selected = null, instant = false } = {}) {
  const list = choices();
  const custom = h('input', { class: 'lt-dt', type: 'datetime-local', 'aria-label': 'Pick a day and time', value: localInput(list.find((c) => c.key === 'tomorrow').due) });
  const setBtn = instant ? h('button', { class: 'lt-set', type: 'button' }, 'Set') : null;
  const row = h('div', { class: 'lt-pick' }, custom, setBtn);
  row.hidden = selected !== 'pick';
  const chips = h('div', { class: 'ch-starts lt-chips', role: 'group', 'aria-label': 'When' },
    list.map((c) => h('button', { class: `ch-start${c.key === selected ? ' on' : ''}`, type: 'button', 'aria-pressed': String(c.key === selected), dataset: { key: c.key }, title: c.due ? whenLabel(c.due) : 'No date' }, c.label)),
    h('button', { class: `ch-start${selected === 'pick' ? ' on' : ''}`, type: 'button', dataset: { key: 'pick' } }, 'Pick a time\u2026'));
  const mark = (key) => chips.querySelectorAll('.ch-start').forEach((b) => { const on = b.dataset.key === key; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  const picked = () => { const t = new Date(custom.value).getTime(); return Number.isFinite(t) ? t : null; };
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('.ch-start');
    if (!b) return;
    mark(b.dataset.key);
    if (b.dataset.key === 'pick') {
      row.hidden = false;
      custom.focus();
      try { custom.showPicker?.(); } catch { /* not allowed here; the field is there to tap */ }
      if (!instant && picked() != null) pick(picked());
      return;
    }
    row.hidden = true;
    pick(list.find((c) => c.key === b.dataset.key).due);
  });
  if (instant) setBtn.addEventListener('click', () => { if (picked() != null) pick(picked()); });
  else custom.addEventListener('change', () => { if (picked() != null) pick(picked()); });
  return h('div', { class: 'lt-when' }, chips, row);
}

// ── sheets ──────────────────────────────────────────────────────────────────

function sheet(label, ...kids) {
  const ov = h('div', { class: 'ed-ov lt-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, h('div', { class: 'ed-sheet lt-sheet' }, ...kids));
  const key = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { ov.classList.remove('show'); document.removeEventListener('keydown', key); setTimeout(() => ov.remove(), 260); };
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', key);
  document.body.append(ov);
  requestAnimationFrame(() => ov.classList.add('show'));
  return { ov, close };
}

const whoFiled = (it) => (it.by && member(it.by).kind === 'bot' ? member(it.by).name : null);
const whereLine = (it) => [it.client, whoFiled(it) ? `from ${whoFiled(it)}` : 'You parked this',
  `added ${new Date(it.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`].filter(Boolean).join(' · ');

// One item: what it is, where it came from, when it is due; move it, finish it, open the chat, delete it.
export function openLaterItem(it, { openAt } = {}) {
  const due = isDue(it);
  const dueLine = h('div', { class: `lt-due${due ? ' late' : ''}` }, it.due_at == null ? 'No date' : `${due ? 'Due' : 'Reminds you'} ${whenLabel(it.due_at)}`);
  const doneBtn = h('button', { class: 'ed-send', type: 'button' }, 'Mark done');
  const openBtn = it.chat_id ? h('button', { class: 'lt-link', type: 'button' }, `Open ${whoFiled(it) ? `${whoFiled(it)}’s` : 'the'} chat`) : null;
  const delBtn = h('button', { class: 'lt-link danger', type: 'button' }, 'Delete');
  const { close } = sheet(due ? 'Reminder' : 'Later',
    h('div', { class: 'ed-top' }, h('button', { class: 'ed-cancel', type: 'button', 'data-close': '' }, 'Close'), h('b', {}, due ? 'Reminder' : 'Later'), h('span')),
    h('div', { class: 'lt-head' }, h('div', { class: 'lt-title' }, it.text), it.note ? h('div', { class: 'lt-note' }, it.note) : null,
      dueLine, h('div', { class: 'lt-meta' }, whereLine(it))),
    h('div', { class: 'lt-lab' }, due ? 'Remind me again' : 'Move it'),
    whenPicker((t) => { close(); moveTo(it, t); }, { instant: true }),
    doneBtn,
    h('div', { class: 'lt-links' }, openBtn, delBtn));
  doneBtn.addEventListener('click', () => { close(); finish(it); });
  openBtn?.addEventListener('click', () => { close(); openAt?.(it.chat_id, it.message_id); });
  let armed = false;
  delBtn.addEventListener('click', () => {
    if (!armed) { armed = true; delBtn.textContent = 'Tap again to delete'; setTimeout(() => { armed = false; delBtn.textContent = 'Delete'; }, 3000); return; }
    close();
    remove(it);
  });
}

// Park something himself, from a message (long press, Remind me): the words, when, Add to Later.
export function openRemindSheet({ text = '', chatId = null, messageId = null } = {}) {
  let due = choices().find((c) => c.key === 'tomorrow').due;
  const field = h('textarea', { class: 'ed-field lt-field', rows: '2', maxlength: '300', 'aria-label': 'What to remember', placeholder: 'What to remember' });
  field.value = text.slice(0, 300);
  const addBtn = h('button', { class: 'ed-send', type: 'button' }, 'Add to Later');
  const sync = () => { addBtn.disabled = !field.value.trim(); };
  field.addEventListener('input', sync);
  const { close } = sheet('Remind me',
    h('div', { class: 'ed-top' }, h('button', { class: 'ed-cancel', type: 'button', 'data-close': '' }, 'Cancel'), h('b', {}, 'Remind me'), h('span')),
    field,
    h('div', { class: 'lt-lab' }, 'When'),
    whenPicker((t) => { due = t; }, { selected: 'tomorrow' }),
    addBtn,
    h('div', { class: 'ed-note' }, 'It waits on your home screen under Later, not in the chat.'));
  sync();
  let busy = false;
  addBtn.addEventListener('click', async () => {
    const v = field.value.trim();
    if (!v || busy) return;
    busy = true;
    addBtn.disabled = true;
    try {
      const r = await post('/api/later', { text: v, chat_id: chatId, message_id: messageId, due_at: due });
      if (r?.item) replace(r.item);
      close();
      toast(due == null ? 'Added to Later' : `Added to Later · ${whenLabel(due)}`);
    } catch {
      busy = false;
      sync();
      toast('Couldn’t add that. Try again.');
    }
  });
}

export function onLater(fn) { return on('later', fn); }
