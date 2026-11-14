# Vesper: design

Vesper (working name Holler, which is why the code, the Hermes platform and the HOLLER_* settings say holler) is a private chat app for a Hermes agent team. It looks and behaves like iMessage: one team room plus a direct thread with each bot. It is its own app: its own server, its own home-screen icon. Each bot's routines (cron) can deliver to that bot's own thread (`--deliver holler`, `HOLLER_HOME_CHANNEL=dm-<bot>`).

## Pieces

1. **Server** (`server/`): Node 24+, built-in `node:sqlite`, no npm dependencies (Web Push is done with node:crypto in `server/push.mjs`). Runs on your Mac as launchd `com.vesper.app`, port 8802 on 127.0.0.1 (add your Tailscale address to `hosts` in the config to reach it from your phone). HTTPS through `tailscale serve` once tailnet HTTPS certificates are on (needed for iPhone push).
2. **Hermes plugin** (`hermes-plugin/holler/`, installed to `~/.hermes/plugins/holler`): a Hermes messaging platform, same role Telegram plays. Each bot profile connects to the server as itself with its own token, receives messages over a server-sent event stream, replies over HTTP, shows typing, and renders Hermes approval prompts and clarify questions as tappable buttons.
3. **Web app** (`web/`): installable PWA, vanilla JS, no build step. iMessage look and behavior. Push notifications through a service worker when served over HTTPS.

## Data

SQLite at `~/.vesper/data/vesper.db` (WAL). Uploaded files in `~/.vesper/data/files/`. Config and secrets in `~/.config/vesper/config.json` (0600): session secret, VAPID keys, bot token hashes. Plain bot tokens live only in each profile's `.env` (0600) as `HOLLER_BOT_TOKEN`.

Members come from `team.json` (`~/.config/vesper/team.json`, read by `server/team.mjs`): you (the one human) and your bots, each mapped to a Hermes profile. Chats: `room` (everyone, titled by `room.title`) and one DM per bot (`dm-<bot>`).

## Who answers (server/routing.mjs)

Every message in a chat is delivered to every bot in that chat, flagged `addressed` true or false. Only addressed messages wake a bot (a model call). Unaddressed room messages are kept by the plugin as context and handed to the bot with its next addressed message, so every bot knows what was said in the room without paying for it.

- DM from the owner: that bot is addressed.
- Room message from the owner: addressed bots are those @mentioned, named as the first word ("Ben, ..."), or the author of the message being replied to. "@all" addresses every bot. If nobody is addressed, the default responder (`defaultResponder` in team.json, else the first bot) is.
- Room message from a bot: only bots it @mentions, names first, or replies to are addressed, never itself. A chain cap stops bot-to-bot ping-pong: after 4 bot-woken turns since the owner's last message in that chat, bot messages wake nobody.
- Only the owner can press buttons. The server refuses a press from a bot token, so a bot can never approve its own or another bot's dangerous command.

## API

Human (cookie `vesper_sid`, HttpOnly, SameSite=Strict, Secure on HTTPS; sign-in through a one-time link minted by `bin/login-link`, valid 30 minutes, single use):

| Route | Purpose |
|---|---|
| `GET /api/bootstrap` | `{me, members[], chats[], vapidPublicKey, push}` |
| `GET /api/chats/:id/messages?before=&limit=` | `{messages[], more, reads}` oldest first |
| `POST /api/chats/:id/messages` | `{text, reply_to?, client_id, attachments?: [fileId]}` returns `{message}`; `client_id` makes retries idempotent |
| `POST /api/chats/:id/read` | `{last_id}` |
| `POST /api/messages/:id/react` | `{emoji}` or `{emoji: null}` to clear |
| `POST /api/messages/:id/press` | `{data}` presses a card button |
| `POST /api/files` | raw body, `content-type`, `x-file-name`; returns `{file}` |
| `GET /files/:id` | file bytes (cookie or bot token) |
| `GET /api/events` | SSE: `message`, `update`, `typing`, `read`, `presence`, keepalive comments |
| `POST /api/presence` | `{visible, chat_id}` so push is skipped while the owner is looking at that chat |
| `POST /api/push/subscribe`, `/api/push/unsubscribe` | Web Push subscription |
| `POST /api/logout` | ends the session |

Bot (`Authorization: Bearer <token>`):

| Route | Purpose |
|---|---|
| `GET /bot/v1/events` | SSE of `message` and `press` events for this bot; resumes from `Last-Event-ID` or the stored cursor; skips events older than 24 hours |
| `POST /bot/v1/messages` | `{chat_id, text, reply_to?, buttons?, client_id?, attachments?}` returns `{id}` |
| `PATCH /bot/v1/messages/:id` | `{text?, buttons?, resolved?}` own messages only |
| `DELETE /bot/v1/messages/:id` | own messages only |
| `POST /bot/v1/typing` | `{chat_id, on}` |
| `GET /bot/v1/chats/:id` | chat info and members |
| `POST /bot/v1/files` | same as the human upload |

Service (`Authorization: Bearer <token>`, hash in `serviceTokens` in the config; `node server/main.mjs --install-service-token <name>` writes that service's key to ~/.config/vesper/service-<name>.json):

| Route | Purpose |
|---|---|
| `POST /svc/v1/messages` | `{as, chat_id, text, buttons?, silent?, client_id?}`: a card posted as bot `as`, only into that bot's own DM; `silent` skips push (quiet hours) |
| `PATCH /svc/v1/messages/:id` | `{text?, buttons?, resolved?}` on this service's cards only; the bot cannot edit or delete them |
| `GET /svc/v1/said?id=<n or last>&chat_id=` | one of the owner's messages (`{id, chat_id, sender, kind, at, text}`), by id or their newest in that chat, so a service can check a bot's claim that the owner said something |
| `GET /svc/v1/updates?offset=&wait=` | long poll for the owner's presses on this service's cards (the bot never sees them); `offset` confirms everything before it, `wait` up to 30 s |

Message shape: `{id, chat_id, sender, text, at, edited_at, kind: "text"|"card"|"system", reply_to: {id, sender, text}|null, buttons: [[{label, data, style}]]|null, resolved: {label, by, at}|null, attachments: [{id, name, type, size, url}], reactions: [{member_id, emoji}]}`. Bots write light Markdown; the app renders bold, italics, inline code, code blocks, links and lists, and escapes everything else.

## Reliability

- Versioned deploy: `bin/deploy.sh` runs tests, copies HEAD to `~/.vesper/releases/<sha>`, swaps `current`, restarts launchd, probes, rolls back on a failed probe. Plugin installs from the same release.
- Probe checks the artifact: `/health` reports database write/read, and how many bots have a live event stream. An optional heartbeat (`beatUrl` and `beatToken` in the config) pings an outside monitor every 5 minutes while the database answers and every bot is connected, so silence means something is down.
- Nightly SQLite backup (`.backup`) kept 14 days, optionally copied off the Mac (`VESPER_OFFSITE`).
- Every outbound fetch in the plugin has a timeout; posts carry `client_id` so retries never double-send; the event stream reconnects with backoff and jitter.
- Secrets 0600, never in URLs except the single-use login link.

## Not in v1

Voice notes, message editing by the owner, a native iOS app.
