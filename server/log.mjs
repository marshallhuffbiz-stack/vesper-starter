// One-line timestamped logs to stdout (launchd sends them to ~/.vesper/logs/launchd.log).

export function log(...parts) {
  const text = parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? p.stack || p.message : JSON.stringify(p))).join(' ');
  process.stdout.write(`${new Date().toISOString()} ${text}\n`);
}
