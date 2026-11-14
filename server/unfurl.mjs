// Link previews (Vesper 2026-10-30): the title, site and picture of a link in a message, read from the
// page's Open Graph tags, plus the picture itself through a small cache so the app's CSP stays 'self'.
// Only public http(s) hosts are fetched (no loopback, private, link-local or tailnet addresses), pages are
// capped at 600 KB and pictures at 3 MB, every request times out, and a picture is only proxied if a
// preview named it. Stripe payment links: the amount and Paid or Not paid yet come from the Stripe API,
// read-only, when ~/.config/vesper/stripe.json holds a restricted key ({"key": "rk_live_..."}); without
// it the app says "payment link" with the amount from the message.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TZ } from './team.mjs';

const PAGE_MAX = 600 * 1024;
const IMAGE_MAX = 3 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const TTL_MS = 7 * 86400000;
const FAIL_TTL_MS = 30 * 60000;
const STRIPE_TTL_MS = 5 * 60000;
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
// Facebook and Instagram only give their link tags to their own crawler's name.
const FB_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function privateAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return m ? privateAddress(m[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function publicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  if (u.port && !['80', '443'].includes(u.port)) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.ts\.net)$/i.test(host)) return null;
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((x) => privateAddress(x.address))) return null;
  } catch { return null; }
  return u;
}

// GET with a time limit and a byte cap, following up to 4 redirects, each one checked again.
async function get(raw, { max, ua, accept }) {
  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    const u = await publicUrl(url);
    if (!u) throw new Error('not a public address');
    // One time limit covers the request and reading the body, so a server that stalls mid-page is cut off.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const chunks = [];
    let res;
    try {
      res = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': ua, accept, 'accept-language': 'en-US,en;q=0.8' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), u).href;
        try { await res.body?.cancel(); } catch { /* ignore */ }
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let size = 0;
      for await (const c of res.body) {
        size += c.length;
        if (size > max) {
          if (accept.startsWith('image')) throw new Error('too big');
          break;
        }
        chunks.push(c);
      }
    } finally { clearTimeout(timer); }
    return { url: u.href, type: String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), body: Buffer.concat(chunks) };
  }
  throw new Error('too many redirects');
}

const decode = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (all, e) => {
  const k = e.toLowerCase();
  if (k[0] === '#') { const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : all; }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }[k] ?? all;
}).replace(/\s+/g, ' ').trim();

export function readTags(html) {
  const head = String(html).slice(0, PAGE_MAX);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const val = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && val != null && !(key in meta)) meta[key] = decode(val);
  }
  const title = meta['og:title'] || meta['twitter:title'] || decode(/<title[^>]*>([^<]{1,300})<\/title>/i.exec(head)?.[1] || '');
  return {
    title: title.slice(0, 160),
    site: (meta['og:site_name'] || '').slice(0, 80),
    image: meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'] || '',
  };
}

const KINDS = [
  ['stripe', /(^|\.)stripe\.com$/],
  ['facebook', /(^|\.)(facebook\.com|fb\.me|fb\.watch)$/],
  ['instagram', /(^|\.)instagram\.com$/],
  ['maps', /^(maps\.app\.goo\.gl|g\.page|goo\.gl)$|^(maps\.)?google\.[a-z.]+$/],
  ['gmail', /^mail\.google\.com$/],
];
const kindOf = (host) => (KINDS.find(([, re]) => re.test(host)) || ['page'])[0];

export function createUnfurl({ dir, stripeKeyFile = join(homedir(), '.config', 'vesper', 'stripe.json'), fetchPage = get, now = () => Date.now() } = {}) {
  const cacheDir = dir && join(dir, 'unfurl');
  if (cacheDir) mkdirSync(join(cacheDir, 'img'), { recursive: true, mode: 0o700 });
  const indexFile = cacheDir && join(cacheDir, 'index.json');
  let index = {};
  try { if (indexFile && existsSync(indexFile)) index = JSON.parse(readFileSync(indexFile, 'utf8')); } catch { index = {}; }
  const pending = new Map();
  let saveTimer = null;
  const save = () => {
    if (!indexFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const keep = Object.entries(index).filter(([, v]) => now() - v.at < TTL_MS).slice(-2000);
      index = Object.fromEntries(keep);
      try { writeFileSync(indexFile, JSON.stringify(index), { mode: 0o600 }); } catch { /* the cache is only a cache */ }
    }, 1000);
  };
  const hashOf = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

  function stripeKey() {
    try { return JSON.parse(readFileSync(stripeKeyFile, 'utf8')).key || null; } catch { return null; }
  }
  async function stripeGet(key, path) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`https://api.stripe.com/v1/${path}`, { signal: ctl.signal, headers: { authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(`stripe ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  }
  // Amount and paid state of one payment link, by its public URL. Read-only calls only.
  // Amount and paid state of one payment link, by its public URL. Read-only calls only, and each one is
  // optional: a key that cannot read checkout sessions still tells a one-use link's state from the link
  // itself (restrictions.completed_sessions), and one that cannot read line items leaves the amount to the
  // message. Nothing is guessed: no answer means no status.
  async function stripeInfo(url) {
    const key = stripeKey();
    if (!key) return null;
    const links = await stripeGet(key, 'payment_links?limit=100');
    const link = (links.data || []).find((l) => l.url === url);
    if (!link) return null;
    const [items, sessions] = await Promise.all([
      stripeGet(key, `payment_links/${link.id}/line_items?limit=20`).catch(() => null),
      stripeGet(key, `checkout/sessions?payment_link=${link.id}&limit=10`).catch(() => null),
    ]);
    const cents = (items?.data || []).reduce((t, x) => t + (Number(x.amount_total) || 0), 0);
    const amount = cents ? `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0 })}` : '';
    const paidSession = (sessions?.data || []).find((x) => x.payment_status === 'paid');
    const used = Number(link.restrictions?.completed_sessions?.count) || 0;
    const day = (t) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ });
    let status;
    if (paidSession) status = { tone: 'ok', label: `Paid ${day(paidSession.created)}` };
    else if (used > 0) status = { tone: 'ok', label: 'Paid' };
    else if (link.active === false) status = { tone: 'off', label: 'Turned off' };
    else if (sessions || link.restrictions?.completed_sessions) status = { tone: 'wait', label: 'Not paid yet' };
    return { amount, ...(status ? { status } : {}) };
  }

  async function build(url) {
    let parsed = null;
    try { parsed = new URL(url); } catch { /* not a link */ }
    const host = parsed && /^https?:$/.test(parsed.protocol) ? parsed.hostname.replace(/^www\./, '') : '';
    const kind = host ? kindOf(host) : 'page';
    const out = { url, kind, host, title: '', site: '', image: '' };
    // A Stripe link is never fetched as a page; its amount and paid state come from the API (key or nothing).
    if (kind === 'stripe') {
      try { Object.assign(out, await stripeInfo(url) || {}); } catch { /* status stays unknown */ }
      return out;
    }
    if (!(await publicUrl(url))) return { ...out, kind: 'page', title: '', blocked: true };
    try {
      const page = await fetchPage(url, { max: PAGE_MAX, ua: kind === 'facebook' || kind === 'instagram' ? FB_UA : SAFARI, accept: 'text/html,application/xhtml+xml' });
      if (/html|xml/.test(page.type)) {
        const t = readTags(page.body.toString('utf8'));
        out.title = t.title;
        out.site = t.site;
        if (t.image) {
          const img = new URL(t.image, page.url).href;
          if (/^https?:/.test(img)) out.image = `/api/unfurl/img?u=${encodeURIComponent(img)}`;
          out._img = img;
        }
      }
    } catch { out.failed = true; }
    return out;
  }

  return {
    async preview(url) {
      const key = hashOf(url);
      const hit = index[key];
      const ttl = hit?.data?.kind === 'stripe' ? STRIPE_TTL_MS : hit?.data?.failed ? FAIL_TTL_MS : TTL_MS;
      if (hit && now() - hit.at < ttl) return hit.data;
      if (pending.has(key)) return pending.get(key);
      const p = build(url).then((data) => { index[key] = { at: now(), data }; save(); return data; }).finally(() => pending.delete(key));
      pending.set(key, p);
      return p;
    },
    // A picture a preview named, from the disk cache or fetched once (images only, 3 MB at most).
    async image(imgUrl) {
      const known = Object.values(index).some((v) => v.data?._img === imgUrl);
      if (!known) return null;
      const name = hashOf(imgUrl);
      const file = cacheDir && join(cacheDir, 'img', name);
      if (file && existsSync(file) && existsSync(`${file}.type`)) return { type: readFileSync(`${file}.type`, 'utf8'), body: readFileSync(file) };
      const got = await fetchPage(imgUrl, { max: IMAGE_MAX, ua: SAFARI, accept: 'image/avif,image/webp,image/png,image/jpeg,image/*' });
      if (!IMAGE_TYPES.has(got.type)) return null;
      if (file) { writeFileSync(file, got.body, { mode: 0o600 }); writeFileSync(`${file}.type`, got.type, { mode: 0o600 }); }
      return { type: got.type, body: got.body };
    },
  };
}

// What the app gets: no internal fields.
export const publicPreview = (d) => {
  const { _img, failed, blocked, ...rest } = d || {};
  return rest;
};
