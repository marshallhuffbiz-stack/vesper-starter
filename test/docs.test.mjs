// Documents and Deliverables (11-10): files a bot or a service hands Alex, read inside the app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sha256 } from '../server/store.mjs';
import { createApp, forWords } from '../server/app.mjs';
import { generateVapidKeys } from '../server/push.mjs';
import { viewKind, typeFromName, wantsThumb } from '../server/docs.mjs';

let dir, store, app, server, base, cookie;
const pushes = [];
const logs = [];
const HANK = 'eli-token-0123456789abcdef';
const SVC = 'team-token-0123456789abcdef';
const POPPLER = ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/usr/bin/pdftoppm'].some((p) => existsSync(p));

// A small real PDF with `n` blank letter pages and a correct cross-reference table.
function pdf(n) {
  const objs = [];
  const kids = Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  for (let i = 0; i < n; i++) objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>');
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const upload = (body, type, name, token = SVC, path = '/svc/v1/files') => fetch(`${base}${path}`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type, 'x-file-name': encodeURIComponent(name) }, body,
}).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const svc = (body) => fetch(`${base}/svc/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${SVC}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));
const get = (path, headers = {}) => fetch(`${base}${path}`, { headers: { cookie, ...headers } });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vesper-docs-'));
  mkdirSync(join(dir, 'files')); mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>Vesper</title>');
  store = new Store(join(dir, 'holler.db'));
  const config = { vapid: generateVapidKeys(), pushSubject: 'https://example.com', botTokens: { eli: sha256(HANK) }, serviceTokens: { team: sha256(SVC) } };
  app = createApp({ store, config, filesDir: join(dir, 'files'), staticDir: join(dir, 'web'), log: (...a) => logs.push(a.join(' ')),
    pushImpl: async (sub, data) => { pushes.push(data); return { ok: true, status: 201 }; } });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/login?t=${store.mintLoginToken()}`, { redirect: 'manual' });
  cookie = res.headers.get('set-cookie').split(';')[0];
  store.addPushSub({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'k', auth: 'a' } }, 'test');
});

// A page or thumbnail may still be drawing in the background when the last test ends: let it land, then remove.
after(async () => {
  app.close(); server.closeAllConnections(); server.close();
  await new Promise((r) => setTimeout(r, 400));
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('what a file is and how it opens', () => {
  assert.equal(typeFromName('Pat Visit Cheat Sheet (Private).PDF'), 'application/pdf');
  assert.equal(typeFromName('notes.md'), 'text/markdown');
  assert.equal(typeFromName('thing.exe'), null);
  assert.equal(viewKind({ type: 'application/pdf' }), 'pdf');
  assert.equal(viewKind({ type: 'image/png' }), 'image');
  assert.equal(viewKind({ type: 'text/markdown' }), 'text');
  assert.equal(viewKind({ type: 'text/html' }), 'html');
  assert.equal(viewKind({ type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'html');
  assert.equal(viewKind({ type: 'video/mp4' }), 'video');
  assert.equal(viewKind({ type: 'application/zip' }), 'file');
  assert.equal(wantsThumb({ type: 'application/pdf' }), true);
  assert.equal(wantsThumb({ type: 'image/png' }), false);
  const now = Date.parse('2026-11-10T15:00:00-05:00');
  assert.equal(forWords(Date.parse('2026-11-10T16:30:00-05:00'), now), 'for today 4:30 PM');
  assert.equal(forWords(Date.parse('2026-11-11T14:30:00-05:00'), now), 'for tomorrow 2:30 PM');
  assert.equal(forWords(Date.parse('2026-11-13T09:00:00-05:00'), now), 'for Fri 9:00 AM');
});

test('a handed-over PDF: page count, pages as pictures, the list, the New mark, the notification', async () => {
  const up = await upload(pdf(3), 'application/pdf', 'Acme - Pat Visit Cheat Sheet (Private).pdf');
  assert.equal(up.status, 200);
  const f = up.file;
  assert.equal(f.name, 'Acme - Pat Visit Cheat Sheet (Private).pdf', 'the name survives percent-encoding');
  assert.equal(f.view, 'pdf');
  assert.equal(f.seen, false, 'new until he opens it');
  assert.equal(f.thumb, `/files/${f.id}/t`);
  if (POPPLER) { assert.equal(f.pages, 3); assert.equal(f.width, 612); assert.equal(f.height, 792); }

  pushes.length = 0;
  const forAt = Date.now() + 24 * 3600 * 1000;
  const sent = await svc({ as: 'eli', chat_id: 'dm-eli', text: 'Your promises and questions for the visit.', attachments: [f.id], client_id: 'deliver-abc',
    doc: { title: 'Pat visit prep', client: 'Acme Pressure Washing', kind: 'Meeting prep', for_at: forAt } });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.message.doc, { title: 'Pat visit prep', client: 'Acme Pressure Washing', kind: 'Meeting prep', for_at: forAt });
  assert.ok(logs.some((l) => /deliverable \d+ from eli: "Pat visit prep" \(1 files\)/.test(l)));
  const again = await svc({ as: 'eli', chat_id: 'dm-eli', text: 'x', attachments: [f.id], client_id: 'deliver-abc', doc: { title: 'Pat visit prep' } });
  assert.equal(again.id, sent.id, 'the same client_id never posts twice');

  await new Promise((r) => setTimeout(r, 50));
  const push = pushes.find((p) => p.message_id === sent.id);
  assert.ok(push, 'his phone is told');
  assert.match(push.body, /^Pat visit prep\nMeeting prep · for tomorrow /);
  assert.ok(push.images.includes(`/files/${f.id}/t`) && push.images.includes(`/files/${f.id}/pg/1`), 'the first pages ride along');

  const list = await (await get('/api/deliverables')).json();
  const item = list.items.find((d) => d.id === sent.id);
  assert.ok(item);
  assert.equal(item.by, 'eli');
  assert.equal(item.doc.title, 'Pat visit prep');
  assert.equal(item.waiting, false);
  assert.equal(item.files[0].seen, false);
  assert.equal((await fetch(`${base}/api/deliverables`)).status, 401, 'signed in only');

  if (POPPLER) {
    const pg = await get(`/files/${f.id}/pg/2`);
    assert.equal(pg.status, 200);
    assert.equal(pg.headers.get('content-type'), 'image/jpeg');
    const bytes = Buffer.from(await pg.arrayBuffer());
    assert.equal(bytes.readUInt16BE(0), 0xffd8, 'a JPEG');
    assert.equal((await get(`/files/${f.id}/pg/4`)).status, 404, 'no page past the end');
    assert.equal((await get(`/files/${f.id}/pg/0`)).status, 404);
    const t = await get(`/files/${f.id}/t`);
    assert.equal(t.status, 200);
    assert.equal(t.headers.get('content-type'), 'image/jpeg');
  }
  assert.equal((await get(`/files/${f.id}/x`)).status, 404);
  assert.equal((await fetch(`${base}/files/${f.id}/pg/1`)).status, 401, 'pages are private too');

  const seen = await (await fetch(`${base}/api/files/${f.id}/seen`, { method: 'POST', headers: { cookie } })).json();
  assert.equal(seen.file.seen, true);
  const after = await (await get('/api/deliverables')).json();
  assert.equal(after.items.find((d) => d.id === sent.id).files[0].seen, true);

  const forBots = await (await fetch(`${base}/svc/v1/deliverables`, { headers: { authorization: `Bearer ${SVC}` } })).json();
  assert.deepEqual(forBots.items[0], { id: sent.id, by: 'eli', at: forBots.items[0].at, waiting: false, opened: true, for_at: forAt, client: 'Acme Pressure Washing', kind: 'Meeting prep',
    title: 'Pat visit prep', files: [{ name: f.name, type: 'application/pdf', size: f.size }] });
});

test('a doc needs a title and a file; a bad time is refused', async () => {
  const f = (await upload(pdf(1), 'application/pdf', 'x.pdf')).file;
  assert.equal((await svc({ as: 'eli', chat_id: 'dm-eli', text: 'no file', doc: { title: 'Nothing' } })).status, 400);
  assert.equal((await svc({ as: 'eli', chat_id: 'dm-eli', attachments: [f.id], doc: { title: '  ' } })).status, 400);
  assert.equal((await svc({ as: 'eli', chat_id: 'dm-eli', attachments: [f.id], doc: { title: 'T', for_at: 'soon' } })).status, 400);
  assert.equal((await svc({ as: 'eli', chat_id: 'dm-eli', attachments: [f.id], doc: 'T' })).status, 400);
  const ok = await svc({ as: 'eli', chat_id: 'dm-eli', attachments: [f.id], doc: { title: 'Just the file', extra: 'dropped' } });
  assert.equal(ok.status, 200, 'no words needed when a file is attached');
  assert.deepEqual(ok.message.doc, { title: 'Just the file' });
});

test('a handed-over file can be labelled afterwards: a better name, the client, what it is for', async () => {
  const f = (await upload(pdf(1), 'application/pdf', 'cheat.pdf')).file;
  const sent = await svc({ as: 'eli', chat_id: 'dm-eli', text: 'From the Claude session.', attachments: [f.id], doc: { title: 'Acme: prepare only for Wednesday Pat', kind: 'Claude session' } });
  const patch = (id, body, token = SVC) => fetch(`${base}/svc/v1/messages/${id}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const forAt = Date.now() + 86400000;
  const out = await patch(sent.id, { doc: { title: 'Pat visit prep', client: 'Acme Pressure Washing', kind: 'Meeting prep', for_at: forAt } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.message.doc, { title: 'Pat visit prep', kind: 'Meeting prep', client: 'Acme Pressure Washing', for_at: forAt });
  assert.equal(out.message.text, 'From the Claude session.', 'the words stay');
  const cleared = await patch(sent.id, { doc: { for_at: null } });
  assert.deepEqual(cleared.message.doc, { title: 'Pat visit prep', kind: 'Meeting prep', client: 'Acme Pressure Washing' }, 'null takes a field away');
  assert.equal((await patch(sent.id, { doc: { title: '' } })).status, 400, 'never without a title');
  assert.equal((await patch(sent.id, { doc: 'x' })).status, 400);
  const plain = await svc({ as: 'eli', chat_id: 'dm-eli', text: 'no files here' });
  assert.equal((await patch(plain.id, { doc: { title: 'Nothing' } })).status, 400, 'only a message that carries files');
  const list = await (await get('/api/deliverables')).json();
  assert.equal(list.items.find((d) => d.id === sent.id).doc.title, 'Pat visit prep');
});

test('types come from the name when the sender only says bytes; HTML and text open safely', async () => {
  const md = (await upload(Buffer.from('# Plan\n\nDo the thing.'), 'application/octet-stream', 'plan.md')).file;
  assert.equal(md.type, 'text/markdown');
  assert.equal(md.view, 'text');
  const raw = await get(md.url);
  assert.equal(raw.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await raw.text(), '# Plan\n\nDo the thing.');

  const page = (await upload(Buffer.from('<h1 style="color:red">Hi</h1><script>alert(1)</script>'), 'text/html', 'draft.html')).file;
  assert.equal(page.view, 'html');
  const orig = await get(page.url);
  assert.match(orig.headers.get('content-type'), /^text\/plain/, 'the original never renders as a page');
  const v = await get(`${page.url}/v`);
  assert.equal(v.status, 200);
  assert.match(v.headers.get('content-type'), /^text\/html/);
  const csp = v.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /sandbox/);
  assert.doesNotMatch(csp, /script-src|allow-scripts/, 'no script ever runs');
  assert.equal((await get(`${md.url}/v`)).status, 404, 'only pages have a page view');

  const pct = await fetch(`${base}/svc/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${SVC}`, 'content-type': 'application/pdf', 'x-file-name': '50% off.pdf' }, body: pdf(1) });
  assert.equal((await pct.json()).file.name, '50% off.pdf', 'a bare percent sign in a name is not an error');
  const exe = (await upload(Buffer.from('MZ'), 'application/x-msdownload', 'thing.exe')).file;
  assert.equal(exe.type, 'application/octet-stream');
  assert.equal(exe.view, 'file');
});

test('byte ranges, so a video plays on a phone', async () => {
  const body = Buffer.from('0123456789abcdefghij');
  const f = (await upload(body, 'video/mp4', 'clip.mp4')).file;
  const all = await get(f.url);
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('accept-ranges'), 'bytes');
  const part = await get(f.url, { range: 'bytes=5-9' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 5-9/20');
  assert.equal(await part.text(), '56789');
  const tail = await get(f.url, { range: 'bytes=-4' });
  assert.equal(await tail.text(), 'ghij');
  const open = await get(f.url, { range: 'bytes=15-' });
  assert.equal(await open.text(), 'fghij');
  assert.equal((await get(f.url, { range: 'bytes=40-50' })).status, 416);
});

test('a document on a waiting card shows as waiting; his own uploads are not deliverables', async () => {
  const f = (await upload(pdf(1), 'application/pdf', 'proposal.pdf')).file;
  const card = await svc({ as: 'eli', chat_id: 'dm-eli', text: '**Team**: Send Mark the winter plan? (#300)', attachments: [f.id], buttons: [[{ label: 'Send', data: 'a|300|x', style: 'primary' }]] });
  assert.equal(card.status, 200);
  const mine = await (await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie, 'content-type': 'application/pdf', 'x-file-name': 'mine.pdf' }, body: pdf(1) })).json();
  assert.equal(mine.file.seen, true, 'his own upload is never new');
  await fetch(`${base}/api/chats/dm-eli/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'here', attachments: [mine.file.id] }) });
  const list = await (await get('/api/deliverables')).json();
  const item = list.items.find((d) => d.id === card.id);
  assert.equal(item.waiting, true);
  assert.equal(item.card, true);
  assert.ok(!list.items.some((d) => d.files.some((x) => x.id === mine.file.id)));
  const forBots = await (await fetch(`${base}/svc/v1/deliverables?limit=5`, { headers: { authorization: `Bearer ${SVC}` } })).json();
  assert.equal(forBots.items.find((d) => d.id === card.id).title, 'Team: Send Mark the winter plan?');
});

test('a bot hears that its document is already with him, not that a card is waiting', async () => {
  const f = (await upload(pdf(1), 'application/pdf', 'packet.pdf')).file;
  await svc({ as: 'eli', chat_id: 'dm-eli', attachments: [f.id], doc: { title: 'Robin guide' } });
  const ctx = store.turnContext('eli', store.chat('dm-eli'), { id: 1e9, at: Date.now() });
  assert.match(ctx, /already in Alex's Vesper Deliverables: "Robin guide" \(1 file, /);
  assert.doesNotMatch(ctx.split('\n').find((l) => l.includes('Robin guide')), /waiting on Alex/);
});
