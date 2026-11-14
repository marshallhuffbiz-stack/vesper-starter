// Vesper: a private iMessage-style chat app for your Hermes agent team.
//
//   node server/main.mjs                       run the server (launchd com.vesper.app)
//   node server/main.mjs --login-link          print a one-time sign-in link (30 minutes, single use)
//   node server/main.mjs --install-bot-tokens  mint a token per bot, keep its hash here, and write
//                                              HOLLER_* settings into each Hermes profile's .env
//                                              (bots that already have one keep it; --rotate replaces them)
//   node server/main.mjs --install-service-token <name>
//                                              mint a token for an outside service (POST /svc/v1/...)

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, dataDir, HOME, CONFIG_PATH } from './config.mjs';
import { Store, sha256 } from './store.mjs';
import { createApp } from './app.mjs';
import { BOTS, HUMAN } from './team.mjs';
import { createTeamOps } from './teamops.mjs';
import { log } from './log.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));

function baseUrl(cfg) {
  return cfg.publicUrl || `http://${cfg.hosts.find((h) => h !== '127.0.0.1') || '127.0.0.1'}:${cfg.port}`;
}

function setEnvLines(path, values) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const keys = new Set(Object.keys(values));
  const kept = lines.filter((l) => !keys.has(l.split('=')[0].trim()));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const out = [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`), ''];
  writeFileSync(path, out.join('\n'), { mode: 0o600 });
  chmodSync(path, 0o600);
}

if (args.has('--login-link')) {
  const cfg = loadConfig();
  const store = new Store(join(dataDir(), 'vesper.db'));
  console.log(`${baseUrl(cfg)}/login?t=${store.mintLoginToken()}`);
  store.close();
  process.exit(0);
}

if (args.has('--install-bot-tokens')) {
  const cfg = loadConfig();
  const profiles = process.env.HERMES_PROFILES_DIR || join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'profiles');
  const rotate = args.has('--rotate');
  for (const b of BOTS) {
    const env = join(profiles, b.profile, '.env');
    if (!existsSync(dirname(env))) { console.log(`skip ${b.id}: no profile ${b.profile}`); continue; }
    const has = existsSync(env) && /^HOLLER_BOT_TOKEN=./m.test(readFileSync(env, 'utf8'));
    if (has && cfg.botTokens[b.id] && !rotate) { console.log(`${b.id}: already has a token (--rotate to replace it)`); continue; }
    const token = randomBytes(32).toString('base64url');
    cfg.botTokens[b.id] = sha256(token);
    setEnvLines(env, {
      HOLLER_URL: `http://127.0.0.1:${cfg.port}`, HOLLER_BOT_TOKEN: token, HOLLER_BOT_ID: b.id,
      HOLLER_ALLOWED_USERS: [HUMAN, ...BOTS.map((x) => x.id)].join(','), HOLLER_HOME_CHANNEL: `dm-${b.id}`,
    });
    console.log(`${b.id}: token written to ${b.profile}/.env`);
  }
  saveConfig(cfg);
  process.exit(0);
}

// A key for an outside service (an approvals service, a script) that posts cards and files through /svc/v1:
// the hash stays in Vesper's config, the plain token goes to a 0600 file for that service.
if (args.has('--install-service-token')) {
  const name = process.argv[process.argv.indexOf('--install-service-token') + 1];
  if (!name || !/^[a-z][a-z0-9-]{0,30}$/.test(name)) { console.error('usage: --install-service-token <name> (lowercase letters, digits, dashes)'); process.exit(2); }
  const cfg = loadConfig();
  const out = join(dirname(CONFIG_PATH), `service-${name}.json`);
  const token = randomBytes(32).toString('base64url');
  cfg.serviceTokens = { ...(cfg.serviceTokens || {}), [name]: sha256(token) };
  saveConfig(cfg);
  writeFileSync(out, JSON.stringify({ url: `http://127.0.0.1:${cfg.port}`, token }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`${name}: token written to ${out}; restart Vesper to load it`);
  process.exit(0);
}

const cfg = loadConfig();
const store = new Store(join(dataDir(), 'vesper.db'));
const teamops = createTeamOps();
const app = createApp({ store, config: cfg, filesDir: join(dataDir(), 'files'), staticDir: join(ROOT, 'web'), log, remindEvery: 10 * 60 * 1000, laterEvery: 30 * 1000,
  sweepEvery: 30 * 1000, teamops, system: (now) => teamops.systemChecks(now) });
// Pictures from before previews existed get theirs a little after start (never in the way of the deploy probe).
setTimeout(() => { app.warmPreviews().catch((e) => log('previews error', e)); }, 15000).unref();

const servers = [];
function listen(host) {
  const server = http.createServer(app.handler);
  server.requestTimeout = 0; // event streams stay open
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 65000;
  server.on('error', (e) => {
    log(`listen ${host}:${cfg.port} failed: ${e.code || e.message}; retrying in 30 s`);
    setTimeout(() => listen(host), 30000).unref();
  });
  server.listen(cfg.port, host, () => { servers.push(server); log(`listening on http://${host}:${cfg.port}`); });
}
for (const h of cfg.hosts) listen(h);
log(`vesper up (home ${HOME}, config ${CONFIG_PATH}, url ${baseUrl(cfg)})`);

// Optional dead-man beat to an outside monitor (set beatUrl and beatToken in config.json): sent every 5 minutes
// only while the database answers and every bot has a live event stream, so silence means something is down.
// Any heartbeat service works (Healthchecks.io, Better Stack, your own server); it should alert from outside this Mac.
const BEAT_URL = cfg.beatUrl || null;
let beatNote = '';
async function beat() {
  if (!cfg.beatToken || !BEAT_URL) return;
  const offline = BOTS.filter((b) => !app.online(b.id)).map((b) => b.id);
  const note = !store.healthCheck() ? 'database check failed' : offline.length ? `offline: ${offline.join(', ')}` : '';
  if (note) { if (note !== beatNote) log(`beat skipped: ${note}`); beatNote = note; return; }
  beatNote = '';
  try {
    const r = await fetch(BEAT_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-beat-token': cfg.beatToken },
      body: JSON.stringify({ bots: BOTS.length }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) log('beat failed', r.status);
  } catch (e) { log('beat failed', e.message); }
}
setTimeout(beat, 60000).unref();
setInterval(beat, 5 * 60000).unref();

let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  log(`${sig}: shutting down`);
  app.close();
  for (const s of servers) s.close();
  store.close();
  setTimeout(() => process.exit(0), 500).unref();
}
// One bad request must never take the whole app down: on a Mac short of memory a restart can take minutes.
// Log it and keep serving; only a burst of them (something is really broken) hands over to launchd.
let faults = [];
function fault(kind, e) {
  if (closing) return;
  log(`${kind}:`, e?.stack || e);
  const t = Date.now();
  faults = faults.filter((x) => t - x < 60000);
  faults.push(t);
  if (faults.length >= 8) { log('too many faults in a minute: restarting'); shutdown('faults'); }
}
process.on('unhandledRejection', (e) => fault('unhandled rejection', e));
process.on('uncaughtException', (e) => fault('uncaught exception', e));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
