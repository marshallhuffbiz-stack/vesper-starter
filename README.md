# Vesper

A private chat app for your own Hermes agent team. It looks and works like iMessage: one room with the whole team, plus a thread with each bot. It runs on your Mac, and your phone reaches it over Tailscale as a Home Screen app with notifications.

The bots run on [Hermes Agent](https://github.com/NousResearch/hermes-agent), so they use whatever model accounts you sign them in to. Vesper is the place you talk to them and see what they're doing.

## What you get

- A thread per bot plus a team room. In the room, a message goes to the bot you name first ("Max, can you..."), the bots you @mention, or the bot you reply to. Anything else goes to your lead bot.
- Cards with buttons. Hermes approval prompts and questions show up as cards you answer with a tap, and only you can press them.
- **Runs:** every routine (Hermes cron job) for every bot, with today's runs, token use, pause, resume, run now, and new or edited routines.
- **Agent pages:** each bot's week, routines and memory.
- **Later:** reminders and parked items on the home screen. Bots can file them too.
- Pictures, files and documents. PDFs open page by page, with previews sized for a phone.
- Search across every message and every bot's memory.
- Delivery tracking. A message a bot never picks up is flagged so you can send it again. Stop and Start fresh buttons control a bot's conversation.
- Each bot starts a fresh conversation every morning, so long threads don't get re-read in full every turn. Memory, skills and routines are kept.
- Phone notifications through Web Push, with no outside push service.

## What you need

- A Mac with Node 24 or newer (`brew install node`) and git
- Hermes Agent: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`
- A model account for the bots. Hermes can use a ChatGPT / Codex plan (the `openai-codex` sign-in), Nous Portal, GitHub Copilot, or API keys for Anthropic, OpenRouter, Gemini and others. Run `hermes model` to see the full list.
- Tailscale on the Mac and your phone, if you want Vesper on your phone

## Set it up

```bash
git clone <this repo> ~/vesper && cd ~/vesper
bin/setup
```

The first run copies `config/team.example.json` to `~/.config/vesper/team.json` and stops. Edit that file with your name and your bots (see "The team file" below), then run setup again:

```bash
bin/setup
```

The second run:

1. creates a Hermes profile for each bot (`hermes profile create`), with a starting SOUL.md from the team file
2. copies the Vesper plugin into each profile and turns it on
3. makes a token for each bot and writes it into that profile's `.env`
4. runs the tests, installs Vesper as a background service (launchd `com.vesper.app`) and checks that it answers
5. starts or restarts the Hermes gateway, which runs every profile's bots

Then sign each bot in to a model and reload the bots:

```bash
hermes -p ada model                     # pick a provider and model; repeat for each bot
hermes -p ada auth add openai-codex     # or: sign in with your ChatGPT / Codex plan
bin/restart-gateway.sh
```

Open it:

```bash
bin/login-link      # prints a one-time sign-in link (30 minutes, single use)
```

`bin/setup --check` reports what's missing without changing anything. Run `bin/setup` again whenever you add a bot.

## The team file

`~/.config/vesper/team.json`. Restart Vesper after you edit it (`bin/deploy.sh`, or `launchctl kickstart -k gui/$(id -u)/com.vesper.app`). If you added a bot, run `bin/setup` again.

| Field | What it does |
|---|---|
| `you` | `id` (lowercase letters), `name`, `initials`. You are the only human. |
| `bots[]` | `id` (lowercase letters, used in URLs and chat ids), `name`, `role`, and `profile` (the Hermes profile; defaults to the id). Optional: `avatar` (`headset`, `antenna`, `flower`, `glasses`, `cap`, or your own file in `web/icons/agents`), `color`, `glyph` (`compass`, `mega`, `cal`, `bars`, `radar`, `spark`, `globe`, `term`), `clients`, and `soul` (written to SOUL.md when the profile is first created). |
| `room` | `title`, and `faces`: up to three bot ids that make up the room's picture |
| `defaultResponder` | the bot that answers room messages that don't name anyone (default: the first bot) |
| `timezone` | IANA zone used for "today", quiet hours and the morning reset (default: the Mac's) |
| `quietHours` | `[from, to]`, default `[21, 8]`: reminders hold, and the avatars look asleep |
| `clients[]` | optional. `key`, `short`, `name`, `bot`, `match` (a case-insensitive regex), `logo` (a file in `web/icons/clients`, without `.webp`). With clients set, home and Approvals group cards by client. |

Your own avatar: put `<name>.webp` plus `<name>-busy.webp`, `<name>-perk.webp` and `<name>-sleep.webp` (square, about 256 px) in `web/icons/agents`, set `"avatar": "<name>"`, commit, and deploy.

## Phone

1. Install Tailscale on the Mac and the phone, signed in to the same account.
2. Add the Mac's Tailscale address to `hosts` in `~/.config/vesper/config.json`: `"hosts": ["127.0.0.1", "100.x.y.z"]` (find it with `tailscale ip -4`). Restart Vesper.
3. Notifications need HTTPS. In the Tailscale admin console, open DNS and turn on HTTPS Certificates. Then on the Mac run `tailscale serve --bg --https=443 http://127.0.0.1:8802`, and set `"publicUrl": "https://<mac-name>.<tailnet>.ts.net"` in the same config file. Restart Vesper.
4. Run `bin/login-link`, open the link in Safari on the phone, then Share, Add to Home Screen. Open Vesper from the Home Screen and tap Turn on notifications.

Also set `pushSubject` in the config to your own `mailto:` address. Apple's push service wants a real contact there.

## Everyday commands

| Command | What it does |
|---|---|
| `bin/deploy.sh` | Tests, then copies the committed HEAD to `~/.vesper/releases/<sha>`, swaps `current`, updates the plugin in every profile, restarts the service and checks it. Rolls back on its own if the check fails. Commit first. |
| `bin/restart-gateway.sh` | Reloads the bots (after a plugin change, new bot settings or a model sign-in). Running turns finish first. |
| `bin/rollback.sh` | Goes back to the previous release. |
| `bin/login-link` | Prints a sign-in link for a new device. |
| `tail -f ~/.vesper/logs/launchd.log` | Server log. The bots' side is in `~/.hermes/logs/gateway.log`. |
| `curl -s 127.0.0.1:8802/health` | Database check, which bots are connected, and which app builds have been seen recently. |

A nightly backup runs at 3:20 AM (`com.vesper.backup`): a SQLite backup plus your uploaded files, kept 14 days in `~/.vesper/backups`. Set `VESPER_OFFSITE=user@host:/path/` in the backup plist to also copy each night's files off the Mac.

## How it fits together

| Piece | Where |
|---|---|
| Server | `server/`, plain Node with no npm dependencies (`node:sqlite`, Web Push on `node:crypto`). Listens on 127.0.0.1:8802. |
| Web app | `web/`, vanilla JS with no build step. An installable PWA. |
| Hermes plugin | `hermes-plugin/holler/`, a Hermes messaging platform (like the Telegram one). Each bot connects as itself over a server-sent event stream. |
| Data | `~/.vesper/data/vesper.db` (SQLite WAL) and `~/.vesper/data/files/` |
| Config and secrets | `~/.config/vesper/config.json` (0600): VAPID keys and token hashes. Each bot's plain token is in its own profile `.env`. |
| Team | `~/.config/vesper/team.json` |

The code's working name was Holler. That's why the Hermes platform is called `holler` (routines deliver with `--deliver holler`) and the bot settings start with `HOLLER_`. Details: `docs/design.md`, which also lists the full API.

Routines you create in the app go to `hermes -p <profile> cron create` and deliver to that bot's own thread. If `~/vesper-bots/<profile>` exists, it becomes the routine's working folder (`VESPER_WORKDIRS` changes the parent folder).

## Hooks for your own systems

The original build also ran next to an approvals service: bots drafted texts and emails, and they went out after a slide in Vesper. That service isn't included. Vesper keeps the hooks so you can build your own:

- **Service API** (`/svc/v1/...`). `node server/main.mjs --install-service-token <name>` writes a token to `~/.config/vesper/service-<name>.json`. A service can post cards as a bot into that bot's thread, read your presses on them (long poll), attach files, and file Later items. See `docs/design.md`.
- **`server/teamops.mjs`.** The data behind Catch me up, Activity, a per-client pause switch and the System sheet. These ship empty, so those screens stay hidden until you fill them in. The client board can read an outbox database (`VESPER_OUTBOX_DB`); the expected columns are in the file.
- **Always rules.** `VESPER_OUTBOX_DB` with an `always_rules` table shows them on the agent page, and `VESPER_REVOKE_CMD` is the command that revokes one.
- **Heartbeat.** `beatUrl` and `beatToken` in the config ping an outside monitor (Healthchecks.io, Better Stack, your own) every 5 minutes while the database works and every bot is connected. Alerting from outside the Mac means you hear about it when the Mac itself is down.
- **Stripe.** Payment links in messages show their amount. With a restricted key in `~/.config/vesper/stripe.json` (`{"key": "rk_live_..."}`, read access to Payment Links and Checkout Sessions) they also show Paid or Not paid yet.
- **PDFs.** `brew install poppler` lets Vesper draw every page. Without it, a PDF shows its first page only.

## Development

```bash
npm test                                   # server and logic tests, against the test team in test/fixtures/team.json
node tools/mock-server.mjs --port 8790     # the web app against an in-memory fake server (no Hermes needed)
```

The screenshot and gesture checks in `tools/*-shots.mjs`, and `HOLLER_UI=1 node --test test/approvals.ui.test.mjs`, drive WebKit through Playwright. To run them: `npm i -D playwright-core`, then `PLAYWRIGHT_BROWSERS_PATH=~/.vesper/test-browsers npx playwright-core install webkit`. `VESPER_PLAYWRIGHT` can point at a different playwright-core.

`test/plugin_selftest.py` tests the Hermes plugin against a real server. It needs Hermes's Python environment:

```bash
HERMES_HOME=$(mktemp -d) ~/.local/bin/hermes --run-module cProfile -o /dev/null test/plugin_selftest.py
```

That temporary HERMES_HOME builds its own runtime of about 600 MB. Delete it afterwards.

## Other systems

The server and web app are plain Node and run anywhere Node 24 runs. The Mac-specific parts are the launchd scripts in `bin/` and `launchd/`, and the macOS tools behind picture previews and document thumbnails (`sips`, `qlmanage`, `textutil`, in `server/media.mjs` and `server/docs.mjs`). On Linux, swap the launchd parts for a systemd unit and expect those previews to need replacing.

## Security

- Vesper listens on 127.0.0.1 unless you add addresses to `hosts`. Keep it on your tailnet and never on the open internet.
- Sign-in uses one-time links. A session cookie lasts 400 days on that device.
- Bots and services authenticate with their own tokens, and only hashes are stored on the Vesper side.
- Only the human can press card buttons, so a bot can never approve its own prompt.
