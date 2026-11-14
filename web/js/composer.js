// Composer: growing text field, send button, photo and file attach with upload progress, reply bar and the
// "@" mention picker for the room.
import { $, h, icons, coarsePointer, toast, fmtBytes } from './util.js';
import { state, firstName, isMe } from './store.js';
import { upload } from './api.js';
import { avatar } from './avatar.js';
import { previewText } from './md.js';

let els;
let chatId = null;
let replyTo = null;
let tray = []; // {id, file, url, progress, status, result, req}
// What he was typing in each chat survives a relaunch (11-09: iOS drops a Home Screen app from memory often, and a
// half-written message went with it). Kept on this device only.
const DRAFTS_KEY = 'vesper.drafts';
const MAX_FILE = 25 * 1024 * 1024;
const drafts = (() => {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}')).filter(([, v]) => typeof v === 'string' && v)); } catch { return new Map(); }
})();
let draftTimer = 0;
function saveDrafts() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      const out = Object.fromEntries([...drafts].filter(([, v]) => v && v.trim()).map(([k, v]) => [k, v.slice(0, 8000)]));
      if (Object.keys(out).length) localStorage.setItem(DRAFTS_KEY, JSON.stringify(out)); else localStorage.removeItem(DRAFTS_KEY);
    } catch { /* private window: drafts last until the app closes */ }
  }, 300);
}
// A chat with words waiting in it, for the list's "Draft:" line.
export const draftFor = (id) => (drafts.get(id) || '').trim();
let onSend = () => {};
let mention = null; // {start, query, items, index}

export function initComposer({ send }) {
  onSend = send;
  els = {
    root: $('#composer'),
    field: $('#field'),
    input: $('#input'),
    send: $('#send-btn'),
    mic: $('#mic-btn'),
    plus: $('#plus-btn'),
    file: $('#file-input'),
    reply: $('#reply-bar'),
    tray: $('#attach-tray'),
    picker: $('#mention-picker'),
  };
  els.input.addEventListener('input', onInput);
  els.input.addEventListener('keydown', onKey);
  els.input.addEventListener('blur', () => setTimeout(closePicker, 150));
  els.send.addEventListener('click', (e) => { e.preventDefault(); submit(); });
  // Keep the keyboard up when tapping send on phones.
  els.send.addEventListener('pointerdown', (e) => { if (document.activeElement === els.input) e.preventDefault(); });
  els.plus.addEventListener('click', () => (menu ? closeMenu() : openMenu()));
  // The mic puts the cursor in the field so the keyboard's dictation key is right there.
  els.mic.addEventListener('pointerdown', (e) => e.preventDefault());
  els.mic.addEventListener('click', () => focusComposer());
  els.file.addEventListener('change', () => {
    for (const f of els.file.files || []) addFile(f);
    els.file.value = '';
  });
  els.picker.addEventListener('pointerdown', (e) => e.preventDefault());
  els.picker.addEventListener('click', (e) => {
    const b = e.target.closest('[data-insert]');
    if (b) choose(b.dataset.insert);
  });
  // Paste pictures or files straight into the field.
  els.input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); files.forEach(addFile); }
  });
  // On a Mac: drop pictures or files anywhere on the open chat.
  const pane = els.root.parentElement;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  pane.addEventListener('dragenter', (e) => { if (!chatId || !hasFiles(e)) return; e.preventDefault(); depth++; pane.classList.add('dropping'); });
  pane.addEventListener('dragover', (e) => { if (chatId && hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  pane.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) pane.classList.remove('dropping'); });
  pane.addEventListener('drop', (e) => {
    depth = 0;
    pane.classList.remove('dropping');
    if (!chatId || !hasFiles(e)) return;
    e.preventDefault();
    [...e.dataTransfer.files].slice(0, 10).forEach(addFile);
    focusComposer();
  });
  window.addEventListener('pagehide', () => { if (chatId) drafts.set(chatId, els.input.value); clearTimeout(draftTimer); try { const out = Object.fromEntries([...drafts].filter(([, v]) => v && v.trim())); if (Object.keys(out).length) localStorage.setItem(DRAFTS_KEY, JSON.stringify(out)); else localStorage.removeItem(DRAFTS_KEY); } catch { /* ignore */ } });
}

export function setComposerChat(id) {
  closeMenu(true);
  if (chatId === id) return;
  if (chatId) drafts.set(chatId, els.input.value);
  chatId = id;
  els.input.value = drafts.get(id) || '';
  clearReply();
  clearTray();
  closePicker();
  autosize();
  update();
}

export function focusComposer() { els.input.focus({ preventScroll: true }); }

export function setReply(m) {
  replyTo = m;
  // A work card: his words go to the same Claude conversation, so the bar says Claude (11-11).
  const work = m.kind === 'work' && m.work;
  const who = work ? 'Claude' : isMe(m.sender) ? 'yourself' : firstName(m.sender);
  els.reply.replaceChildren(
    h('div', { class: 'rb-main' },
      h('div', { class: 'rb-title' }, 'Replying to ', h('b', {}, who), work ? ' \u00b7 same session' : ''),
      h('div', { class: 'rb-text' }, work ? work.title : previewText(m.text || '') || (m.attachments?.length ? 'Photo' : ''))),
    h('button', { class: 'rb-x', type: 'button', 'aria-label': 'Cancel reply', html: icons.x, onclick: () => { clearReply(); focusComposer(); } }));
  els.reply.hidden = false;
  focusComposer();
}

function clearReply() { replyTo = null; els.reply.hidden = true; els.reply.replaceChildren(); }

function autosize() {
  const ta = els.input;
  ta.style.height = 'auto';
  const max = 22 * 6 + 18;
  // scrollHeight is 0 while the pane is hidden; never collapse below one line.
  ta.style.height = `${Math.max(40, Math.min(ta.scrollHeight, max))}px`;
  ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
}

function ready() {
  const uploading = tray.some((t) => t.status === 'uploading');
  const has = els.input.value.trim().length > 0 || tray.some((t) => t.status === 'done');
  return has && !uploading;
}

function update() {
  const has = els.input.value.trim().length > 0 || tray.length > 0;
  els.field.classList.toggle('has-text', has);
  els.send.disabled = !ready();
}

function onInput() {
  autosize();
  update();
  if (chatId) { drafts.set(chatId, els.input.value); saveDrafts(); }
  checkMention();
}

function onKey(e) {
  if (mention && els.picker.childElementCount) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = mention.items.length;
      mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      paintPicker();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(mention.items[mention.index].insert); return; }
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarsePointer()) {
    e.preventDefault();
    submit();
  }
}

function submit() {
  if (!ready()) return;
  const text = els.input.value.replace(/\s+$/, '');
  const attachments = tray.filter((t) => t.status === 'done').map((t) => t.result);
  onSend({ text, reply_to: replyTo, attachments });
  els.input.value = '';
  if (chatId) { drafts.delete(chatId); saveDrafts(); }
  clearReply();
  clearTray(false);
  closePicker();
  autosize();
  update();
}

// ── attachments ──────────────────────────────────────────────────────────

function addFile(file) {
  if (!file || !file.size) return;
  if (file.size > MAX_FILE) { toast(`${file.name || 'That file'} is over 25 MB.`); return; }
  if (tray.length >= 10) { toast('Ten at a time.'); return; }
  const image = String(file.type || '').startsWith('image/');
  const item = { id: Math.random().toString(36).slice(2), file, image, url: image ? URL.createObjectURL(file) : null, progress: 0, status: 'uploading', result: null, req: null };
  tray.push(item);
  start(item);
  paintTray();
  update();
}

function start(item) {
  item.status = 'uploading';
  item.progress = 0;
  item.req = upload(item.file, (p) => { item.progress = p; paintProgress(item); });
  item.req.then((file) => {
    item.result = file;
    item.status = 'done';
    paintTray();
    update();
  }, (e) => {
    if (e.message === 'aborted') return;
    item.status = 'error';
    paintTray();
    update();
  });
}

function paintProgress(item) {
  const el = els.tray.querySelector(`[data-item="${item.id}"] .ring`);
  if (el) el.style.setProperty('--p', String(item.progress));
}

function paintTray() {
  els.tray.hidden = tray.length === 0;
  els.tray.replaceChildren(...tray.map((item) => h('div', { class: `thumb ${item.status}${item.image ? '' : ' doc'}`, dataset: { item: item.id } },
    item.image ? h('img', { src: item.url, alt: item.file.name })
      : h('div', { class: 'thumb-doc' }, h('span', { class: 'thumb-ext' }, (/\.([a-z0-9]{1,5})$/i.exec(item.file.name || '')?.[1] || 'file').toUpperCase()), h('span', { class: 'thumb-name' }, item.file.name || 'File'), h('span', { class: 'thumb-size' }, fmtBytes(item.file.size))),
    item.status === 'uploading' ? h('div', { class: 'ring', style: { '--p': String(item.progress) }, 'aria-label': 'Uploading' }) : null,
    item.status === 'error' ? h('button', { class: 'thumb-retry', type: 'button', html: icons.alert, 'aria-label': 'Upload failed. Tap to retry.', onclick: () => { start(item); paintTray(); update(); } }) : null,
    h('button', { class: 'thumb-x', type: 'button', 'aria-label': item.image ? 'Remove photo' : 'Remove file', html: icons.x, onclick: () => remove(item) }))));
}

function remove(item) {
  item.req?.abort?.();
  if (item.url) URL.revokeObjectURL(item.url);
  tray = tray.filter((t) => t !== item);
  paintTray();
  update();
}

function clearTray(revoke = true) {
  for (const t of tray) { if (t.status === 'uploading') t.req?.abort?.(); if (revoke && t.url) URL.revokeObjectURL(t.url); }
  tray = [];
  paintTray();
}

// ── mentions ─────────────────────────────────────────────────────────────

function checkMention() {
  const chat = state.chats.get(chatId);
  if (!chat || chat.kind !== 'room') return closePicker();
  const ta = els.input;
  const upto = ta.value.slice(0, ta.selectionStart);
  const m = /(^|\s)@([\w]*)$/.exec(upto);
  if (!m) return closePicker();
  const q = m[2].toLowerCase();
  const bots = [...state.members.values()].filter((x) => x.kind === 'bot' && (chat.members || []).includes(x.id));
  const items = bots.filter((b) => b.name.toLowerCase().startsWith(q) || b.id.startsWith(q))
    .map((b) => ({ id: b.id, label: b.name, sub: b.role || '', insert: `@${b.name} ` }));
  if ('all'.startsWith(q) || 'everyone'.startsWith(q)) items.push({ id: null, label: 'Everyone', sub: '@all', insert: '@all ' });
  if (!items.length) return closePicker();
  mention = { start: upto.length - m[2].length - 1, query: m[2], items, index: 0 };
  paintPicker();
}

function paintPicker() {
  els.picker.replaceChildren(...mention.items.map((it, i) => h('button', {
    class: `mp-item${i === mention.index ? ' active' : ''}`, type: 'button', dataset: { insert: it.insert }, role: 'option', 'aria-selected': String(i === mention.index),
  },
  it.id ? avatar(it.id, 28, { dot: false }) : h('div', { class: 'mp-all', 'aria-hidden': 'true' }, '@'),
  h('span', { class: 'mp-name' }, it.label),
  it.sub ? h('span', { class: 'mp-sub' }, it.sub) : null)));
  els.picker.hidden = false;
}

function choose(insert) {
  if (!mention) return;
  const ta = els.input;
  const before = ta.value.slice(0, mention.start);
  const after = ta.value.slice(ta.selectionStart);
  ta.value = before + insert + after;
  const pos = (before + insert).length;
  ta.setSelectionRange(pos, pos);
  closePicker();
  onInput();
  ta.focus();
}

function closePicker() {
  mention = null;
  if (els?.picker) { els.picker.hidden = true; els.picker.replaceChildren(); }
}

// ── "+" menu: a frosted glass panel that grows out of the "+" button (docs/messages-motion.md:
// 450 ms open with a small overshoot, 200 ms close back into the button). Every row does something.
let menu = null;
let camInput = null;
const MENU_OPEN = { duration: 450, easing: 'cubic-bezier(.3,1.18,.4,1)' };
const MENU_CLOSE = { duration: 200, easing: 'cubic-bezier(.4,0,.6,1)' };

function menuRows() {
  const room = state.chats.get(chatId)?.kind === 'room';
  const rows = [
    { id: 'camera', label: 'Camera', cls: 'pm-cam', glyph: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 8.2h3l1.6-2.2h6.8L17 8.2h3v10H4z" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.3" fill="none" stroke="#fff" stroke-width="1.7"/></svg>', run: () => camera() },
    { id: 'photos', label: 'Photos', cls: 'pm-photos', glyph: '<svg viewBox="0 0 24 24" width="26" height="26">' + [0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => `<ellipse cx="12" cy="6.6" rx="3" ry="4.6" transform="rotate(${a} 12 12)" fill="${['#F4B23E', '#F07E2E', '#E9473F', '#C2418F', '#7B53C8', '#3F86E0', '#3DB6C9', '#6CC24A'][i]}" opacity=".88"/>`).join('') + '</svg>', run: () => els.file.click() },
  ];
  rows.push({ id: 'file', label: 'File', cls: 'pm-file', glyph: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M7 3.5h7l4.5 4.5V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5Z" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/><path d="M13.5 3.5V8.5h5" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>', run: () => anyFile() });
  if (room) rows.push({ id: 'all', label: 'Ask everyone', cls: 'pm-all', glyph: '<span>@</span>', run: () => insertText('@all ') });
  return rows;
}

function camera() {
  if (!camInput) {
    camInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    camInput.addEventListener('change', () => { for (const f of camInput.files || []) addFile(f); camInput.value = ''; });
    els.root.append(camInput);
  }
  camInput.click();
}

// A PDF, a spreadsheet, a recording: anything up to 25 MB. The bot gets the file itself.
let docInput = null;
function anyFile() {
  if (!docInput) {
    docInput = h('input', { type: 'file', multiple: true, hidden: true });
    docInput.addEventListener('change', () => { for (const f of docInput.files || []) addFile(f); docInput.value = ''; });
    els.root.append(docInput);
  }
  docInput.click();
}

function insertText(t) {
  const el = els.input;
  const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
  el.value = el.value.slice(0, a) + t + el.value.slice(b);
  el.selectionStart = el.selectionEnd = a + t.length;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  focusComposer();
}

function openMenu() {
  if (menu) return;
  const pane = els.root.parentElement;
  const panel = h('div', { class: 'pm glass', role: 'menu', 'aria-label': 'Add' });
  for (const r of menuRows()) {
    const b = h('button', { class: 'pm-row', type: 'button', role: 'menuitem', dataset: { act: r.id } },
      h('span', { class: `pm-ic ${r.cls}`, 'aria-hidden': 'true' }), h('span', { class: 'pm-label' }, r.label));
    b.firstChild.innerHTML = r.glyph;
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); r.run(); });
    panel.append(b);
  }
  const catcher = h('div', { class: 'pm-catch' });
  catcher.addEventListener('pointerdown', (e) => { e.preventDefault(); closeMenu(); });
  pane.append(catcher, panel);
  // Grow from the "+" centre: the panel's origin is pinned there, measured once before animating.
  const pr = els.plus.getBoundingClientRect(), pn = pane.getBoundingClientRect();
  panel.style.bottom = `${Math.max(12, pn.bottom - pr.bottom - 2)}px`;
  const r = panel.getBoundingClientRect();
  panel.style.transformOrigin = `${pr.left + pr.width / 2 - r.left}px ${pr.top + pr.height / 2 - r.top}px`;
  const s0 = Math.min(0.2, (pr.width * 1.4) / r.width);
  panel.animate([{ transform: `scale(${s0})`, opacity: 0.5 }, { transform: 'scale(1)', opacity: 1 }], MENU_OPEN);
  panel.querySelectorAll('.pm-row').forEach((row) => row.animate([{ opacity: 0 }, { opacity: 0, offset: 0.2 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' }));
  els.plus.classList.add('menu-open');
  menu = { panel, catcher };
}

export function closeMenu(instant = false) {
  if (!menu) return;
  const { panel, catcher } = menu;
  menu = null;
  catcher.remove();
  els.plus.classList.remove('menu-open');
  if (instant) { panel.remove(); return; }
  panel.style.pointerEvents = 'none';
  panel.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.15)', opacity: 0 }], { ...MENU_CLOSE, fill: 'forwards' }).onfinish = () => panel.remove();
}
