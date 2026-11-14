// Team operations: the hooks Vesper offers for whatever runs your bots' outside actions (an approvals service, an
// outbox of texts and emails, a pause switch per client, a ledger of coding sessions the bots start). The original
// build read all of that from a separate service; this starter ships the hooks empty, so the screens that use them
// (Catch me up, Activity, the per-client pause switch, "Done without a tap") simply stay hidden.
//
// To wire your own: return real data from these functions. The shapes the app expects:
//   catchup(sinceMs)      -> { since, lines: [string], summary?, note?, when?, failed?, paused: [name] }
//   clients()             -> [{ id, short, name, bot, paused, since }]      (per-client pause switch)
//   setPaused(id, on)     -> { id, short, paused }
//   audit()               -> { ok: bool, items: [{ at, bot, ask, result }] } ("Done without a tap")
//   activity(sinceMs)     -> { since, items: [...] }                         (Activity sheet)
//   claudeJobs()          -> null or { running: [], queued: [], today: n, stopped: bool }
//   clientActions(sinceS) -> null or outbox rows for the client board (built in: set VESPER_OUTBOX_DB)
//   systemChecks(now)     -> [{ key, label, level: 'ok'|'warn'|'bad', detail }] (System sheet)
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TZ } from './team.mjs';
import { HttpError } from './store.mjs';

const HOME = homedir();

export function createTeamOps({
  outboxDb = process.env.VESPER_OUTBOX_DB || null, // optional: a SQLite file with an `actions` table (see clientActions)
  backupLog = process.env.VESPER_BACKUP_LOG || join(process.env.VESPER_HOME || join(HOME, '.vesper'), 'logs', 'backup.log'),
  diskPath = HOME,
  now = () => Date.now(),
} = {}) {
  function systemChecks(t = now()) {
    const out = [];
    const add = (key, label, level, detail) => out.push({ key, label, level, detail });
    try {
      const last = readFileSync(backupLog, 'utf8').trim().split('\n').pop() || '';
      const at = Date.parse(last.split(' ')[0]);
      const age = t - at;
      const good = /db ok/.test(last);
      const when = Number.isFinite(at) ? new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at) : 'never';
      add('backup', 'Backup', good && age < 36 * 3600000 ? 'ok' : 'warn', good && age < 36 * 3600000 ? `Saved ${when}` : good ? `Last good one was ${when}` : `Last night's did not finish (${when})`);
    } catch { add('backup', 'Backup', 'warn', 'No backup has run yet'); }
    try {
      const f = statfsSync(diskPath);
      const gb = (Number(f.bavail) * Number(f.bsize)) / 1e9;
      add('disk', 'Disk', gb >= 8 ? 'ok' : gb >= 4 ? 'warn' : 'bad', `${gb.toFixed(gb < 10 ? 1 : 0)} GB free${gb < 8 ? '. Under 8 GB a Mac slows down and can freeze.' : ''}`);
    } catch { /* not measurable here */ }
    return out;
  }

  // The client board's outbox (optional): open actions plus everything decided or created since `sinceSec`. Columns:
  // id, created (unix s), bot (Hermes profile), ask, kind (text|email|task), client_name, status (posted, grace,
  // approved, running, doing, fixing, done, failed, ...), auto, decided_at, card_message_id, card_where, contact_name.
  function clientActions(sinceSec) {
    if (!outboxDb || !existsSync(outboxDb)) return null;
    let db;
    try {
      db = new DatabaseSync(outboxDb, { readOnly: true });
      return db.prepare(
        `SELECT id, created, bot, ask, kind, client_name, status, auto, decided_at, card_message_id, card_where, target_display, contact_name
           FROM actions WHERE status IN ('posted', 'grace', 'approved', 'running', 'doing', 'fixing') OR decided_at >= ? OR created >= ?
           ORDER BY id DESC LIMIT 400`).all(sinceSec, sinceSec);
    } catch { return null; } finally { try { db?.close(); } catch { /* ignore */ } }
  }

  return {
    catchup: (since) => ({ since: since || 0, lines: [], paused: [] }),
    clients: () => [],
    setPaused: () => { throw new HttpError(404, 'no such client'); },
    audit: () => ({ ok: false, items: [] }),
    activity: (since) => ({ since: since || 0, items: [] }),
    claudeJobs: () => null,
    clientActions,
    systemChecks,
  };
}
