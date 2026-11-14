// Vesper 10-30: search, the message behind a card chip, link previews, and the chart data (days, today).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sha256 } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { createHermes } from '../server/hermes.mjs';
import { createUnfurl, privateAddress, readTags, publicPreview } from '../server/unfurl.mjs';
import { generateVapidKeys } from '../server/push.mjs';

test('search finds words and client names in every chat; a card chip finds its card', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vesper-search-'));
  const store = new Store(join(dir, 'h.db'));
  try {
    store.postMessage({ chatId: 'dm-ben', sender: 'ben', text: '**Acme Pressure Washing**: Send Pat his $375 payment link (#91)\n\nText to Pat (ends 1234):\n"Hey Pat"' });
    store.postMessage({ chatId: 'dm-ben', sender: 'ben', text: 'Card #91 is waiting on you. 100% done_ish' });
    store.postMessage({ chatId: 'dm-dora', sender: 'dora', text: 'Fjord calls are up this week.' });
    store.postMessage({ chatId: 'dm-dora', sender: 'dora', text: 'Mentions (#91) in the middle, not a card' });
    assert.deepEqual(store.search('alex', { q: 'payment link' }).map((m) => m.chat_id), ['dm-ben']);
    assert.equal(store.search('alex', { q: '100%' }).length, 1, '% is a literal, not a wildcard');
    assert.equal(store.search('alex', { q: 'done_ish' }).length, 1);
    assert.deepEqual(store.search('alex', { any: ['Fjord', 'Garage Doors'] }).map((m) => m.chat_id), ['dm-dora']);
    assert.equal(store.search('alex', {}).length, 0, 'nothing asked, nothing back');
    assert.equal(store.search('alex', { recent: true }).length, 4, 'recent: the latest messages for the app to sort');
    const card = store.cardMessage(91, 'alex');
    assert.match(card.text, /^\*\*Acme Pressure Washing\*\*/, 'the card is the message whose first line ends in (#91)');
    assert.equal(store.cardMessage(92, 'alex'), null);
    assert.equal(store.cardMessage('x', 'alex'), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('previews only fetch public addresses and read the page tags', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '169.254.1.1', '100.101.102.103', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.equal(privateAddress(ip), false, ip);
  const t = readTags('<html><head><title>Plain title</title><meta property="og:title" content="Fjord &amp; Co: repair"><meta property="og:site_name" content="Fjord Garage Doors"><meta property="og:image" content="/hero.jpg"></head>');
  assert.deepEqual(t, { title: 'Fjord & Co: repair', site: 'Fjord Garage Doors', image: '/hero.jpg' });
  assert.equal(readTags('<title>Only a title</title>').title, 'Only a title');

  const dir = mkdtempSync(join(tmpdir(), 'vesper-unfurl-'));
  const fetched = [];
  const fetchPage = async (url, opts) => {
    fetched.push(url);
    if (opts.accept.startsWith('image')) return { url, type: 'image/jpeg', body: Buffer.from('jpg') };
    return { url, type: 'text/html', body: Buffer.from('<meta property="og:title" content="Repair page"><meta property="og:image" content="/hero.jpg">') };
  };
  try {
    const u = createUnfurl({ dir, fetchPage, stripeKeyFile: join(dir, 'none.json') });
    const p = await u.preview('http://93.184.216.34/repair');
    assert.equal(p.title, 'Repair page');
    assert.equal(p.image, `/api/unfurl/img?u=${encodeURIComponent('http://93.184.216.34/hero.jpg')}`);
    assert.equal(publicPreview(p)._img, undefined, 'internal fields stay on the server');
    await u.preview('http://93.184.216.34/repair');
    assert.equal(fetched.length, 1, 'a second ask comes from the cache');
    const img = await u.image('http://93.184.216.34/hero.jpg');
    assert.equal(img.type, 'image/jpeg');
    assert.equal(await u.image('http://93.184.216.34/other.jpg'), null, 'only pictures a preview named are proxied');
    for (const bad of ['http://127.0.0.1:8802/api/bootstrap', 'http://localhost/x', 'http://100.101.102.103/x', 'http://my-mac.tail1234.ts.net/', 'file:///etc/passwd', 'http://93.184.216.34:8802/']) {
      const r = await u.preview(bad);
      assert.equal(r.title, '', bad);
      assert.equal(r.blocked, true, bad);
    }
    assert.equal(fetched.length, 2, 'blocked links never reach the network');
    const s = await u.preview('https://buy.stripe.com/test_abc');
    assert.equal(s.kind, 'stripe');
    assert.equal(s.status, undefined, 'no Stripe key: no paid state is made up');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the agent page gets seven days and Runs gets each run that woke a bot today', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vesper-hermes-'));
  try {
    const cron = join(dir, 'profiles', 'ben', 'cron');
    mkdirSync(cron, { recursive: true });
    mkdirSync(join(dir, 'profiles', 'ben', 'memories'));
    writeFileSync(join(cron, 'jobs.json'), JSON.stringify({ jobs: [{ id: 'abc123def456', name: '[bot:ben] Morning sweep', schedule_display: '50 7 * * 1-5' }] }));
    writeFileSync(join(dir, 'profiles', 'ben', 'memories', 'MEMORY.md'), 'Acme prefers calls after 3 PM.\n§\nCedar posts at 7:30 PM.');
    const now = new Date(2026, 9, 29, 16, 0).getTime();
    const at = (d, h) => new Date(2026, 9, d, h, 0).toISOString();
    writeFileSync(join(cron, 'usage_audit.jsonl'), [
      { ts: at(29, 8), job_id: 'abc123def456', total_tokens: 100, error: null },
      { ts: at(29, 12), job_id: 'abc123def456', total_tokens: 50, error: 'timed out' },
      { ts: at(27, 9), job_id: 'abc123def456', total_tokens: 70, error: null },
    ].map((x) => JSON.stringify(x)).join('\n'));
    const hermes = createHermes({ hermesHome: dir, outboxDb: join(dir, 'none.db'), now: () => now });
    const a = hermes.agent('ben');
    assert.equal(a.days.length, 7);
    assert.deepEqual(a.days.at(-1), { day: '2026-10-29', runs: 2, failed: 1, tokens: 150 });
    assert.equal(a.days.at(-3).runs, 1);
    const ben = hermes.runs().bots.find((b) => b.id === 'ben');
    assert.deepEqual(ben.activity.map((x) => [new Date(x.at).getHours(), x.error]), [[8, false], [12, true]]);
    assert.deepEqual(hermes.searchMemory(['cedar']), [{ bot: 'ben', note: 'Cedar posts at 7:30 PM.' }]);
    assert.deepEqual(hermes.searchMemory([]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the routes: search, card, preview, picture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vesper-app-'));
  mkdirSync(join(dir, 'files')); mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>Vesper</title>');
  const store = new Store(join(dir, 'h.db'));
  const config = { vapid: generateVapidKeys(), pushSubject: 'https://example.com', botTokens: { ben: sha256('ben-token-0123456789abcdef') } };
  const hermes = { searchMemory: (t) => (t.includes('calls') ? [{ bot: 'ben', note: 'Acme prefers calls after 3 PM.' }] : []), close() {} };
  const unfurl = { preview: async (u) => ({ url: u, kind: 'page', title: 'Page', _img: 'x' }), image: async (u) => (u === 'ok' ? { type: 'image/png', body: Buffer.from('png') } : null) };
  const app = createApp({ store, config, filesDir: join(dir, 'files'), staticDir: join(dir, 'web'), hermes, unfurl });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = store.mintLoginToken();
    const res = await fetch(`${base}/login?t=${token}`, { redirect: 'manual' });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const get = (p) => fetch(`${base}${p}`, { headers: { cookie } });
    store.postMessage({ chatId: 'dm-ben', sender: 'ben', text: '**Acme**: calls after 3 (#7)' });
    const s = await (await get('/api/search?q=calls')).json();
    assert.equal(s.messages.length, 1);
    assert.equal(s.memory.length, 1);
    assert.equal((await (await get('/api/cards/7')).json()).message.chat_id, 'dm-ben');
    const p = await (await get(`/api/unfurl?u=${encodeURIComponent('https://example.com/a')}`)).json();
    assert.deepEqual(p, { url: 'https://example.com/a', kind: 'page', title: 'Page' });
    assert.equal((await get('/api/unfurl?u=javascript:alert(1)')).status, 400);
    const img = await get('/api/unfurl/img?u=ok');
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await get('/api/unfurl/img?u=nope')).status, 404);
    assert.equal((await fetch(`${base}/api/search?q=calls`)).status, 401, 'signed out: nothing');
  } finally {
    app.close(); server.closeAllConnections(); server.close(); store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
