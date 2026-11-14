// Config and secrets: ~/.config/vesper/config.json (0600), created on first run. Bot tokens are kept
// here only as sha256 hashes; the plain tokens live in each Hermes profile's .env.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateVapidKeys } from './push.mjs';

export const HOME = process.env.VESPER_HOME || join(homedir(), '.vesper');
export const CONFIG_PATH = process.env.VESPER_CONFIG || join(homedir(), '.config', 'vesper', 'config.json');

const DEFAULTS = {
  port: 8802,
  hosts: ['127.0.0.1'], // add your Tailscale IP (tailscale ip -4) to reach it from your phone
  publicUrl: null, // e.g. https://<mac-name>.<tailnet>.ts.net once Tailscale HTTPS is on (needed for phone notifications)
  pushSubject: 'mailto:you@example.com', // Web Push contact (RFC 8292); put your own email or site here
  botTokens: {},
};

export function saveConfig(cfg, path = CONFIG_PATH) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function loadConfig(path = CONFIG_PATH) {
  let cfg = {};
  if (existsSync(path)) cfg = JSON.parse(readFileSync(path, 'utf8'));
  let changed = !existsSync(path);
  for (const [k, v] of Object.entries(DEFAULTS)) if (cfg[k] === undefined) { cfg[k] = v; changed = true; }
  if (!cfg.vapid?.publicKey || !cfg.vapid?.privateJwk) {
    cfg.vapid = generateVapidKeys();
    changed = true;
  }
  if (changed) saveConfig(cfg, path);
  return cfg;
}

export function dataDir(home = HOME) {
  const d = join(home, 'data');
  mkdirSync(join(d, 'files'), { recursive: true, mode: 0o700 });
  return d;
}
