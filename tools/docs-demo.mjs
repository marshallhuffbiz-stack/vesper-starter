#!/usr/bin/env node
// A throwaway Vesper on real server code with real files in it, for looking at documents and Deliverables in a
// browser without touching the live app. Everything lives in a temp folder that is removed on exit.
//
//   node tools/docs-demo.mjs [--port 8791] [file.pdf ...]
//
// Prints a sign-in link. Extra PDFs given on the command line are handed over by Eli as a meeting prep.
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { Store, sha256 } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';

function pdf(lines, n = 3) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i = 0; i < n; i++) {
    const body = `BT /F1 26 Tf 64 700 Td (${lines[0]}) Tj ET BT /F1 13 Tf 64 664 Td (Page ${i + 1} of ${n}) Tj ET ` +
      lines.slice(1).map((l, k) => `BT /F1 13 Tf 64 ${620 - k * 26} Td (${l}) Tj ET`).join(' ');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  }
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
function png(w, h, rgb) {
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

export async function startDemo({ port = 0, pdfs = [], log = () => {} } = {}) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'vesper-docs-demo-'));
  mkdirSync(join(dir, 'files'));
  const store = new Store(join(dir, 'holler.db'));
  const SVC = 'demo-service-token-0123456789';
  const BOT = (id) => `demo-${id}-token-0123456789`;
  const bots = ['ada', 'ben', 'cleo', 'dora', 'eli'];
  const config = { botTokens: Object.fromEntries(bots.map((b) => [b, sha256(BOT(b))])), serviceTokens: { team: sha256(SVC) } };
  // No Hermes, no team files: the demo never reads the live team's data.
  const hermes = { runs: () => ({ bots: [] }), agent: () => ({}), searchMemory: () => [] };
  const teamops = { catchup: () => ({ since: Date.now() - 3600e3, when: '', paused: [], summary: 'All quiet', note: null, failed: 0, lines: [] }), clients: () => [], audit: () => ({ items: [] }), activity: () => ({ since: 0, items: [] }), claudeJobs: () => null };
  const app = createApp({ store, config, filesDir: join(dir, 'files'), staticDir: join(ROOT, 'web'), log, hermes, teamops });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const given = pdfs;
  const up = async (body, type, name) => (await (await fetch(`${base}/svc/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${SVC}`, 'content-type': type, 'x-file-name': encodeURIComponent(name) }, body })).json()).file.id;
  const say = async (body) => (await fetch(`${base}/svc/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${SVC}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const bot = async (id, body) => (await fetch(`${base}/bot/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${BOT(id)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const botUp = async (id, body, type, name) => (await (await fetch(`${base}/bot/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${BOT(id)}`, 'content-type': type, 'x-file-name': encodeURIComponent(name) }, body })).json()).file.id;

  const tomorrow = new Date(Date.now() + 86400000); tomorrow.setHours(14, 30, 0, 0);
  await bot('ben', { chat_id: 'dm-ben', text: 'Monday report for Acme is attached.', attachments: [await botUp('ben', pdf(['Acme Pressure Washing', 'Weekly report', 'Leads: 14', 'Booked jobs: 6'], 2), 'application/pdf', 'Acme weekly report.pdf')] });
  await say({ as: 'cleo', chat_id: 'dm-cleo', text: 'Sunday lineup numbers, as a table and as notes.', attachments: [
    await up(Buffer.from('Truck,Sales,Tickets\nHickory House,1840,212\nLa Palma,1320,160\nSweet Fern,940,131\n'), 'text/csv', 'sunday-lineup.csv'),
    await up(Buffer.from('# Sunday notes\n\n- Hickory House sold out by 3\n- Add a second dessert truck\n\n**Next:** confirm La Palma for the 22nd.\n'), 'text/markdown', 'sunday-notes.md'),
  ], doc: { title: 'Sunday lineup recap', client: 'Dune Eats', kind: 'Report' } });
  await say({ as: 'ben', chat_id: 'dm-ben', text: '**Cedar Boutique**: Post the first two ads? (#310)\n\nBoth go to the $5 a day test.', attachments: [
    await up(png(540, 675, [214, 196, 170]), 'image/png', 'ad-1.png'), await up(png(540, 675, [150, 170, 150]), 'image/png', 'ad-2.png'),
    await up(pdf(['Cedar', 'Ads plan, two months', 'Budget: $150 a month'], 4), 'application/pdf', 'Cedar ads plan.pdf')],
    buttons: [[{ label: 'Approve', data: 'a|310|x', style: 'primary' }, { label: 'Decline', data: 'n|310|x', style: 'danger' }]] });
  await say({ as: 'eli', chat_id: 'dm-eli', text: 'Mark’s winter test and April roadmap, with the cover email as a Word file.', attachments: [
    await up(pdf(['Piedmont Lines', 'Winter test plan', 'Low-cost test through March', 'April roadmap'], 5), 'application/pdf', 'Piedmont Lines - Winter Test Plan.pdf'),
    await up(Buffer.from('<html><body style="font:16px -apple-system;padding:24px"><h1>Cover email</h1><p>Mark, here is the winter plan we talked about.</p><p>Alex</p><p id="js">No script ran.</p><script>document.getElementById("js").textContent = "A SCRIPT RAN";</script></body></html>'), 'text/html', 'Cover email.html'),
  ], doc: { title: 'Mark winter test plan', client: 'Piedmont Lines', kind: 'Proposal' } });
  const real = [];
  for (const p of given) real.push(await up(readFileSync(p), 'application/pdf', basename(p)));
  await say({ as: 'eli', chat_id: 'dm-eli', text: 'Your promises and questions for the visit. Ben has a copy.', attachments: real.length ? real : [
    await up(pdf(['Pat visit', 'Cheat sheet, private', 'What you promised', 'What to ask', 'Watch-outs'], 3), 'application/pdf', 'Acme - Pat Visit Cheat Sheet (Private).pdf')],
    doc: { title: 'Pat visit prep', client: 'Acme Pressure Washing', kind: 'Meeting prep', for_at: tomorrow.getTime() } });

  const close = () => { app.close(); server.closeAllConnections(); server.close(); store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); };
  return { base, dir, store, close, login: () => `${base}/login?t=${store.mintLoginToken()}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--port');
  const demo = await startDemo({ port: pi >= 0 ? Number(args[pi + 1]) : 8791, pdfs: args.filter((a, i) => !a.startsWith('--') && !(pi >= 0 && i === pi + 1)), log: (...a) => console.log('[vesper]', ...a) });
  console.log(`\nVesper demo: ${demo.login().replace('127.0.0.1', 'localhost')}\n(temp data in ${demo.dir}; Ctrl-C removes it)`);
  const bye = () => { demo.close(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
