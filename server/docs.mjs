// Documents (11-10, the owner: the bots say "it's ready in Downloads" and there is no place in Vesper to read it).
// A PDF is drawn page by page into JPEGs here, so his phone gets one light picture per page over the Tailscale
// relay instead of the whole file and a PDF engine. Word files become plain HTML (macOS textutil), and anything
// Quick Look can draw gets a first-page thumbnail. Everything made here lives in data/previews and is rebuilt
// on demand. Poppler (pdftoppm, pdfinfo) is the one outside tool; without it a PDF shows its first page only
// (sips) and System says so.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

export const PAGE_W = 1400; // a page at 3x on the widest phone, sharp enough to zoom once
export const THUMB_W = 420;
export const MAX_PAGES = 400;
const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
const find = (name) => BIN_DIRS.map((d) => join(d, name)).find((p) => existsSync(p)) || null;

const WORD = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'application/rtf']);
const OFFICE = new Set([...WORD, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation']);
const TEXTY = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

// What a file is by its name, for uploads that arrive as plain bytes (a bot's uploader does not always know).
const BY_EXT = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.rtf': 'application/rtf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/x-m4a', '.wav': 'audio/wav', '.zip': 'application/zip',
};
export const typeFromName = (name) => BY_EXT[extname(String(name || '')).toLowerCase()] || null;
const EXT_OF = Object.fromEntries(Object.entries(BY_EXT).map(([e, t]) => [t, e]).reverse());

// How the app opens a file: its pages, a picture, words, a framed page, a player, or only a name and a share button.
export function viewKind(f) {
  const t = String(f?.type || '');
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf') return 'pdf';
  if (TEXTY.has(t)) return 'text';
  if (t === 'text/html' || WORD.has(t)) return 'html';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return 'file';
}
// Files that get a small first-page picture in lists.
// (Not HTML: Quick Look would load the page to draw it, and nothing a bot sends is ever loaded outside the viewer's frame.)
export const wantsThumb = (f) => f?.type === 'application/pdf' || OFFICE.has(f?.type);

export function createDocs({ filesDir, previewDir, log = () => {}, pdftoppm = find('pdftoppm'), pdfinfo = find('pdfinfo') }) {
  const pending = new Map();
  let running = 0;
  const waiting = [];
  const okId = (id) => /^[a-f0-9]{32}$/.test(String(id || ''));
  const out = (id, tail) => join(previewDir, `${id}.${tail}`);
  const src = (f) => join(filesDir, f.id);

  // Two drawings at a time: a phone that scrolls a long PDF asks for many pages at once, and the Mac is small.
  function run(bin, args, opts = {}) {
    return new Promise((resolve) => {
      const go = () => {
        running++;
        execFile(bin, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout) => {
          running--;
          waiting.shift()?.();
          resolve(err ? null : String(stdout ?? ''));
        });
      };
      if (running < 2) go(); else waiting.push(go);
    });
  }

  function once(key, make) {
    if (pending.has(key)) return pending.get(key);
    const job = make().catch((e) => { log(`docs ${key} failed: ${e?.message || e}`); return null; }).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }

  // A PDF's page count and the shape of its first page, read once at upload.
  async function inspect(f) {
    if (!f || !okId(f.id) || f.type !== 'application/pdf' || !existsSync(src(f))) return null;
    if (!pdfinfo) return { pages: 1, width: null, height: null };
    const text = await run(pdfinfo, [src(f)]);
    if (text == null) return null;
    const pages = Math.min(MAX_PAGES, Number(/^Pages:\s+(\d+)/m.exec(text)?.[1]) || 0);
    const size = /^Page size:\s+([\d.]+) x ([\d.]+)/m.exec(text);
    const turned = /^Page rot:\s+(90|270)/m.test(text);
    let w = size ? Math.round(Number(size[1])) : null;
    let h = size ? Math.round(Number(size[2])) : null;
    if (turned) [w, h] = [h, w];
    return pages ? { pages, width: w, height: h } : null;
  }

  async function draw(f, n, width, dest) {
    mkdirSync(previewDir, { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${process.pid}.tmp`;
    if (pdftoppm) {
      // -singlefile writes <prefix>.jpg
      const done = await run(pdftoppm, ['-f', String(n), '-l', String(n), '-jpeg', '-jpegopt', 'quality=80', '-scale-to-x', String(width), '-scale-to-y', '-1', '-singlefile', src(f), tmp]);
      if (done != null && existsSync(`${tmp}.jpg`)) { renameSync(`${tmp}.jpg`, dest); return dest; }
      try { unlinkSync(`${tmp}.jpg`); } catch { /* nothing written */ }
      return null;
    }
    if (n !== 1) return null;
    const done = await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '--resampleWidth', String(width), src(f), '--out', tmp]);
    if (done != null && existsSync(tmp)) { renameSync(tmp, dest); return dest; }
    return null;
  }

  // One page of a PDF as a JPEG; null when there is no such page or it cannot be drawn.
  function page(f, n) {
    n = Number(n);
    if (!f || !okId(f.id) || f.type !== 'application/pdf' || !Number.isInteger(n) || n < 1 || n > (f.pages || MAX_PAGES)) return Promise.resolve(null);
    const dest = out(f.id, `pg${n}`);
    if (existsSync(dest)) return Promise.resolve(dest);
    if (!existsSync(src(f))) return Promise.resolve(null);
    const started = Date.now();
    return once(`${f.id}:pg${n}`, async () => {
      const made = await draw(f, n, PAGE_W, dest);
      if (made) log(`page ${f.id.slice(0, 8)} #${n} ${Math.round(statSync(made).size / 1024)} KB in ${Date.now() - started} ms`);
      return made;
    });
  }

  // The small first-page picture shown in lists. A PDF through poppler; Word, Excel and PowerPoint through
  // Quick Look, which needs the file to carry its extension, so it works on a short-lived copy.
  function thumb(f) {
    if (!f || !okId(f.id) || !wantsThumb(f)) return Promise.resolve(null);
    const dest = out(f.id, 't');
    if (existsSync(dest)) return Promise.resolve(dest);
    if (existsSync(out(f.id, 'not'))) return Promise.resolve(null); // tried once, nothing came out: do not try on every list
    if (!existsSync(src(f))) return Promise.resolve(null);
    return once(`${f.id}:t`, async () => {
      mkdirSync(previewDir, { recursive: true, mode: 0o700 });
      let made = null;
      if (f.type === 'application/pdf') made = await draw(f, 1, THUMB_W, dest);
      else made = await quickLook(f, dest);
      if (!made) { try { copyFileSync('/dev/null', out(f.id, 'not')); } catch { /* next time, then */ } }
      return made;
    });
  }

  async function quickLook(f, dest) {
    const ext = EXT_OF[f.type] || extname(f.name || '') || '';
    if (!ext) return null;
    const dir = mkdtempSync(join(tmpdir(), 'vesper-ql-'));
    try {
      const copy = join(dir, `doc${ext}`);
      copyFileSync(src(f), copy);
      await run('/usr/bin/qlmanage', ['-t', '-s', String(THUMB_W * 2), '-o', dir, copy], { timeout: 20000 });
      const png = readdirSync(dir).find((n) => n.endsWith('.png'));
      if (!png) return null;
      const tmp = `${dest}.${process.pid}.tmp`;
      const done = await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '--resampleWidth', String(THUMB_W), join(dir, png), '--out', tmp]);
      if (done == null || !existsSync(tmp)) return null;
      renameSync(tmp, dest);
      return dest;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // A Word file as HTML, made once. The app shows it in a frame that runs no scripts.
  function html(f) {
    if (!f || !okId(f.id) || !WORD.has(f.type)) return Promise.resolve(null);
    const dest = out(f.id, 'html');
    if (existsSync(dest)) return Promise.resolve(dest);
    if (!existsSync(src(f))) return Promise.resolve(null);
    return once(`${f.id}:html`, async () => {
      mkdirSync(previewDir, { recursive: true, mode: 0o700 });
      const format = f.type === 'application/msword' ? 'doc' : f.type === 'application/rtf' ? 'rtf' : 'docx';
      const tmp = `${dest}.${process.pid}.tmp`;
      const done = await run('/usr/bin/textutil', ['-convert', 'html', '-format', format, '-output', tmp, src(f)]);
      if (done == null || !existsSync(tmp)) return null;
      renameSync(tmp, dest);
      return dest;
    });
  }

  return { inspect, page, thumb, html, ready: { pdf: !!pdftoppm, info: !!pdfinfo } };
}
