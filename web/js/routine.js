// New routine / Edit routine: a sheet over Runs. Pick the bot, name it, say when (Once, Daily, Weekdays,
// Weekly, or Repeat every few minutes between two hours), write what it should do, and choose whether it stays
// quiet when nothing needs the owner. Builds the five-field cron line Hermes runs on (the Mac's local time).
import { h } from './util.js';
import { api } from './api.js';
import { BOTS_ORDER } from './marks.js';
import { avatar } from './avatar.js';
import { member } from './store.js';

const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];
const KINDS = [['once', 'Once'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['repeat', 'Repeat']];
const pad = (n) => String(n).padStart(2, '0');
const clock = (hh, mm) => new Date(2026, 0, 1, hh, mm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Read a cron line back into the sheet's choices; anything else is kept as Custom.
export function parseCron(expr) {
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length !== 5) return { kind: 'custom', raw: expr };
  const [mi, hr, dom, mon, dow] = p;
  const every = /^\*\/(\d+)$/.exec(mi);
  const span = /^(\d+)-(\d+)$/.exec(hr);
  if (every && dom === '*' && mon === '*' && (hr === '*' || span)) return { kind: 'repeat', every: Number(every[1]), from: span ? Number(span[1]) : 0, to: span ? Number(span[2]) : 23, days: dow };
  if (/^\d+$/.test(mi) && /^\d+$/.test(hr) && dom === '*' && mon === '*') {
    const t = `${pad(hr)}:${pad(mi)}`;
    if (dow === '*') return { kind: 'daily', time: t };
    if (dow === '1-5') return { kind: 'weekdays', time: t };
    if (/^\d$/.test(dow)) return { kind: 'weekly', time: t, day: dow };
  }
  return { kind: 'custom', raw: expr };
}

function cronOf(st) {
  const [hh, mm] = String(st.time || '09:00').split(':').map(Number);
  if (st.kind === 'custom') return String(st.raw || '').trim();
  if (st.kind === 'repeat') return `*/${st.every} ${st.from}-${st.to} * * ${st.days === '1-5' ? '1-5' : '*'}`;
  if (st.kind === 'weekdays') return `${mm} ${hh} * * 1-5`;
  if (st.kind === 'weekly') return `${mm} ${hh} * * ${st.day}`;
  return `${mm} ${hh} * * *`; // once and daily
}

function summary(st, bot) {
  const who = member(bot)?.name || 'The bot';
  const [hh, mm] = String(st.time || '09:00').split(':').map(Number);
  const at = clock(hh, mm);
  if (st.kind === 'once') {
    const now = new Date();
    const when = new Date(); when.setHours(hh, mm, 0, 0);
    return `${who} runs this once, ${when > now ? 'today' : 'tomorrow'} at ${at}.`;
  }
  if (st.kind === 'daily') return `${who} runs this every day at ${at}.`;
  if (st.kind === 'weekdays') return `${who} runs this every weekday at ${at}.`;
  if (st.kind === 'weekly') return `${who} runs this every ${DAYS.find((d) => d[0] === st.day)?.[1] || 'week'} at ${at}.`;
  if (st.kind === 'repeat') return `${who} checks every ${st.every} minutes from ${clock(st.from, 0)} to ${clock(st.to, 0)}${st.days === '1-5' ? ' on weekdays' : ''}.`;
  return `${who} runs this on the schedule "${st.raw}".`;
}

// job: an existing routine to edit, or null for a new one. done(job) after Hermes confirms.
export function openRoutineSheet({ job = null, bot = BOTS_ORDER[0], done = () => {}, fail = () => {} } = {}) {
  const editing = !!job;
  const parsed = editing ? parseCron(job.schedule) : { kind: 'weekdays', time: '09:00' };
  const st = { bot: job?.bot || bot, name: job?.name || '', prompt: job?.prompt || '', quiet: editing ? !!job.quiet : true,
    kind: parsed.kind, time: parsed.time || '09:00', day: parsed.day || '5', every: parsed.every || 15, from: parsed.from ?? 8, to: parsed.to ?? 20, days: parsed.days || '*', raw: parsed.raw || job?.schedule || '' };
  let busy = false;

  const ov = h('div', { class: 'ed-ov rt-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': editing ? 'Edit routine' : 'New routine' });
  const sheet = h('div', { class: 'ed-sheet rt-sheet' });
  ov.append(sheet);
  const close = () => { ov.classList.remove('show'); setTimeout(() => ov.remove(), 260); document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); };

  const draw = () => {
    const kinds = editing && st.kind === 'custom' ? [...KINDS, ['custom', 'Custom']] : KINDS;
    const whenRows = [];
    if (st.kind === 'weekly') whenRows.push(h('div', { class: 'rt-days' }, DAYS.map(([v, l]) => h('button', { type: 'button', class: `rt-chip${st.day === v ? ' on' : ''}`, dataset: { day: v } }, l))));
    if (st.kind === 'repeat') {
      whenRows.push(h('label', { class: 'rt-kv' }, h('span', {}, 'Every'), h('select', { class: 'rt-sel', dataset: { f: 'every' } }, [5, 10, 15, 30, 60].map((n) => h('option', { value: String(n), selected: st.every === n }, `${n} min`)))));
      whenRows.push(h('label', { class: 'rt-kv' }, h('span', {}, 'From'), h('select', { class: 'rt-sel', dataset: { f: 'from' } }, Array.from({ length: 24 }, (_, i) => h('option', { value: String(i), selected: st.from === i }, clock(i, 0))))));
      whenRows.push(h('label', { class: 'rt-kv' }, h('span', {}, 'Until'), h('select', { class: 'rt-sel', dataset: { f: 'to' } }, Array.from({ length: 24 }, (_, i) => h('option', { value: String(i), selected: st.to === i }, clock(i, 0))))));
      whenRows.push(h('label', { class: 'rt-kv' }, h('span', {}, 'Weekdays only'), h('input', { type: 'checkbox', class: 'rt-tog', dataset: { f: 'days' }, checked: st.days === '1-5' })));
    } else if (st.kind === 'custom') {
      whenRows.push(h('label', { class: 'rt-kv' }, h('span', {}, 'Schedule'), h('input', { class: 'rt-in rt-raw', value: st.raw, dataset: { f: 'raw' }, 'aria-label': 'Cron schedule' })));
    } else {
      whenRows.push(h('label', { class: 'rt-kv' }, h('span', {}, 'Time'), h('input', { type: 'time', class: 'rt-time', value: st.time, dataset: { f: 'time' } })));
    }
    sheet.replaceChildren(
      h('div', { class: 'ed-top' }, h('button', { class: 'ed-cancel', type: 'button', dataset: { act: 'cancel' } }, 'Cancel'), h('b', {}, editing ? 'Edit routine' : 'New routine'), h('span')),
      h('div', { class: 'rt-scroll' },
        h('div', { class: `rt-who${editing ? ' locked' : ''}` }, BOTS_ORDER.map((id) => h('button', { type: 'button', class: `rt-bot${st.bot === id ? ' on' : ''}`, dataset: { bot: id }, disabled: editing && st.bot !== id, 'aria-pressed': String(st.bot === id) },
          avatar(id, 44), h('span', {}, member(id)?.name || id)))),
        h('div', { class: 'rt-lbl' }, 'Name'),
        h('input', { class: 'rt-in', value: st.name, maxlength: '60', placeholder: 'Friday ad recap', dataset: { f: 'name' }, 'aria-label': 'Routine name' }),
        h('div', { class: 'rt-lbl' }, 'When'),
        h('div', { class: 'rt-card' },
          h('div', { class: 'rt-seg' }, kinds.map(([v, l]) => h('button', { type: 'button', class: st.kind === v ? 'on' : '', dataset: { kind: v } }, l))),
          ...whenRows),
        h('div', { class: 'rt-sum' }, summary(st, st.bot)),
        h('div', { class: 'rt-lbl' }, `What should ${member(st.bot)?.name || 'it'} do?`),
        h('textarea', { class: 'rt-in rt-prompt', rows: '6', placeholder: 'Pull this week’s numbers for my clients and tell me what changed in five lines.', dataset: { f: 'prompt' }, 'aria-label': 'Instructions' }, st.prompt),
        h('label', { class: 'rt-kv rt-quiet' }, h('span', {}, 'Only message me if something needs me', h('small', {}, 'Otherwise it stays quiet')), h('input', { type: 'checkbox', class: 'rt-tog', dataset: { f: 'quiet' }, checked: st.quiet })),
        h('div', { class: 'rt-note' }, 'Anything it would send to a client still comes to you as an approval card first.')),
      h('button', { class: 'ed-send rt-go', type: 'button', dataset: { act: 'save' }, disabled: busy }, busy ? 'Saving…' : editing ? 'Save changes' : 'Add routine'));
    const ta = sheet.querySelector('.rt-prompt');
    ta.value = st.prompt;
  };

  sheet.addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    if (f === 'quiet' || f === 'days') st[f === 'days' ? 'days' : 'quiet'] = f === 'days' ? (e.target.checked ? '1-5' : '*') : e.target.checked;
    else if (['every', 'from', 'to'].includes(f)) st[f] = Number(e.target.value);
    else st[f] = e.target.value;
    const sum = sheet.querySelector('.rt-sum');
    if (sum) sum.textContent = summary(st, st.bot);
  });
  sheet.addEventListener('change', (e) => { if (['every', 'from', 'to', 'days', 'time'].includes(e.target.dataset.f)) sheet.querySelector('.rt-sum').textContent = summary(st, st.bot); });
  sheet.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.act === 'cancel') { close(); return; }
    if (t.dataset.bot && !editing) { st.bot = t.dataset.bot; draw(); return; }
    if (t.dataset.kind) { st.kind = t.dataset.kind; draw(); return; }
    if (t.dataset.day) { st.day = t.dataset.day; draw(); return; }
    if (t.dataset.act === 'save' && !busy) {
      const body = { name: st.name.trim(), schedule: cronOf(st), prompt: st.prompt.trim(), quiet: st.quiet, once: st.kind === 'once' };
      busy = true;
      draw();
      try {
        const r = editing
          ? await api(`/api/runs/${st.bot}/${job.id}`, { method: 'PATCH', body, timeout: 130000 })
          : await api(`/api/runs/${st.bot}`, { method: 'POST', body, timeout: 130000 });
        close();
        done(r.job, editing);
      } catch (err) {
        busy = false;
        draw();
        fail(err?.message || 'That did not save.');
        const msg = sheet.querySelector('.rt-err') || h('div', { class: 'rt-err', role: 'alert' });
        msg.textContent = err?.message || 'That did not save.';
        sheet.querySelector('.rt-scroll').prepend(msg);
      }
    }
  });
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.addEventListener('keydown', key);
  draw();
  document.body.append(ov);
  requestAnimationFrame(() => ov.classList.add('show'));
}
