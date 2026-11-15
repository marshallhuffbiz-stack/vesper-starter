// Link previews (Vesper 2026-10-30): a link in a message gets a small card under it, the way Messages
// shows links: the page's own picture or the app's logo, a title and where it goes. A Stripe payment
// link reads as "$375 payment link" and, once a read-only Stripe key is saved on the Mac, Paid or
// Not paid yet (server/unfurl.mjs). Cards keep one fixed height, so nothing jumps when one fills in.
import { h } from './util.js';
import { api } from './api.js';
import { appMark } from './marks.js';

const URL_RE = /https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]/g;
const cache = new Map(); // url -> {data} | {pending: true} | {failed: true}

export function urlsIn(text, max = 2) {
  const out = [];
  for (const m of String(text || '').matchAll(URL_RE)) {
    if (!out.includes(m[0])) out.push(m[0]);
    if (out.length >= max) break;
  }
  return out;
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// "https://buy.stripe.com/test_00example0002" reads as "buy.stripe.com/test_00…".
export function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = (u.pathname + u.search).replace(/\/$/, '');
    const host = u.hostname.replace(/^www\./, '');
    return path.length > 9 ? `${host}${path.slice(0, 8)}…` : `${host}${path}`;
  } catch { return url; }
}
export const withShortUrls = (text) => String(text || '').replace(URL_RE, (u) => shortUrl(u));

// The dollar amount said closest before the link ("here's the $375 payment link: https://...").
export function amountNear(text, url) {
  const t = String(text || '');
  const i = t.indexOf(url);
  const before = (i < 0 ? t : t.slice(0, i)).slice(-160);
  const all = [...before.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?/g)];
  return all.length ? all[all.length - 1][0].replace(/\s/, '') : '';
}

const KIND = [
  ['stripe', /(^|\.)stripe\.com$/],
  ['facebook', /(^|\.)(facebook\.com|fb\.me|fb\.watch)$/],
  ['instagram', /(^|\.)instagram\.com$/],
  ['maps', /^(maps\.app\.goo\.gl|g\.page|goo\.gl)$|^(maps\.)?google\.[a-z.]+$/],
  ['gmail', /^mail\.google\.com$/],
];
const APP = { stripe: 'pay', facebook: 'facebook', instagram: 'instagram', maps: 'maps', gmail: 'gmail', page: 'web' };
const kindOf = (url, d) => d?.kind || (KIND.find(([, re]) => re.test(hostOf(url))) || ['page'])[0];

function fill(el, url, d, ctx) {
  const kind = kindOf(url, d);
  const host = hostOf(url);
  let title = d?.title || '';
  let sub = d?.site || host;
  let tone = '';
  if (kind === 'stripe') {
    const amount = d?.amount || ctx.amount || '';
    title = amount ? `${amount} payment link` : 'Payment link';
    sub = d?.status?.label || 'Stripe checkout';
    tone = d?.status?.tone || '';
  } else if (!title) {
    title = { facebook: 'Facebook post', instagram: 'Instagram post', maps: 'Google Maps', gmail: 'Gmail' }[kind] || host;
  }
  const pic = d?.image && kind !== 'stripe'
    ? h('span', { class: 'lk-pic' }, h('img', { src: d.image, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }))
    : h('span', { class: 'lk-pic lk-logo' }, appMark(APP[kind] || 'web', 34));
  el.classList.toggle('loading', !d && !cache.get(url)?.failed);
  el.replaceChildren(pic, h('span', { class: 'lk-tx' }, h('b', {}, title), h('span', { class: tone ? `tone-${tone}` : '' }, sub)));
  el.setAttribute('aria-label', `${title}, ${sub}`);
}

function load(url) {
  if (cache.has(url)) return;
  cache.set(url, { pending: true });
  api(`/api/unfurl?u=${encodeURIComponent(url)}`)
    .then((d) => cache.set(url, { data: d }))
    .catch(() => cache.set(url, { failed: true }))
    .finally(() => {
      const d = cache.get(url)?.data || null;
      for (const el of document.querySelectorAll('a.lk')) if (el.dataset.lk === url) fill(el, url, d, { amount: el.dataset.amount || '' });
    });
}

export function linkCard(url, ctx = {}) {
  const el = h('a', { class: 'lk', href: url, target: '_blank', rel: 'noopener noreferrer', dataset: { lk: url, amount: ctx.amount || '' } });
  fill(el, url, cache.get(url)?.data || null, ctx);
  load(url);
  return el;
}

// Ask for previews ahead of time (a thread's links when it loads) so most cards are filled on first paint.
export function warmLinks(texts) {
  for (const t of texts) for (const u of urlsIn(t)) load(u);
}
