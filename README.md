# Messenger

A proof-of-concept mobile-first PWA messenger: email/password auth, user
directory, 1:1 and group chats, @mentions with autocomplete, real-time
delivery over Socket.IO, web push notifications when the app is closed,
webhook-based bots, attachments (images with client-side compression + HD
toggle, server-side thumbnails, lightbox, file downloads), message edit/delete
with tombstones, read receipts, typing indicators, and online presence dots. See [PLAN.md](PLAN.md) for the
architecture and [examples/README.md](examples/README.md) for bots.

## Quick start (dev)

```bash
npm install
npm run dev          # server on :3001, client on :5173 (proxies /api + /socket.io)
```

Open http://localhost:5173, register two users in two browser profiles, and
chat. Push notifications work on localhost without HTTPS — generate keys once
and put them in a root `.env`:

```bash
npx web-push generate-vapid-keys
cp .env.example .env   # paste the keys in
```

Then enable notifications from the Settings tab (or the banner on the chat
list). You'll get a system notification for messages received while no tab is
connected — mentions get a "X mentioned you in …" title.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | server + client dev servers, concurrently |
| `npm test` | all workspace tests (236 tests: vitest + supertest + real-socket integration) |
| `npm run typecheck` | `tsc --noEmit` in all workspaces |
| `npm run build` | production client build |
| `npm run db:generate -w server` | regenerate Drizzle migrations after editing `server/src/db/schema.ts` |

## Deployment (Docker)

```bash
docker compose up --build
# app on http://localhost:3001; SQLite + uploaded attachments persisted in the
# messenger-data volume (/data/messenger.db, /data/uploads)
```

Set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (and `APP_ORIGIN`) in the
environment or a `.env` next to docker-compose.yml. **Push requires HTTPS**
outside localhost — run the container behind your TLS reverse proxy. Make
sure the proxy forwards WebSocket upgrades for `/socket.io` (nginx example:
`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection
"upgrade"; proxy_http_version 1.1;` on that location), otherwise real-time
silently falls back to polling. On iOS (16.4+), push only works after the
PWA is installed to the home screen. Compose is a dev/test convenience —
plain `docker run` with the same env vars works identically.

## Bots

A bot is a user with an API token and an optional webhook URL. Create one,
run the example echo bot, and DM it:

```bash
# with a logged-in session cookie in cookies.txt:
curl -b cookies.txt -X POST localhost:3001/api/bots \
  -H 'Content-Type: application/json' \
  -d '{"name":"Echo Bot","webhookUrl":"http://localhost:4001"}'
# → {"bot":{...},"apiToken":"<token — shown only once>"}

BOT_TOKEN=<token> node examples/echo-bot.mjs
```

Incoming messages in the bot's chats are POSTed to its webhook (5s timeout,
one retry); the bot replies through `POST /api/bot/messages` with its Bearer
token and the reply fans out to sockets and push like any human message.

## Architecture in one paragraph

npm workspaces monorepo: `shared/` (TypeScript DTO + socket event types),
`server/` (Express 5 + Drizzle/better-sqlite3 + Socket.IO, runs via tsx),
`client/` (Vite + React 19 + Tailwind v4). Every message write goes through
one service function which emits on a typed in-process event bus; Socket.IO
(online users), web push (offline users), and bot webhooks are three
independent subscribers to that bus. Auth is an httpOnly session cookie backed
by a sessions table, shared by REST and the socket handshake. The PWA layer is
a hand-rolled service worker (offline app shell, push, notification click →
deep link into the chat) — no build-plugin magic.

## Known limits (deliberate PoC cuts)

No E2E encryption, no email verification/password reset, single node only
(in-process socket registry and event bus — fine for one container).
Attachments are capped at 25MB; SVGs are never rendered inline (download
only, XSS hygiene); videos upload fine but render as file cards, not players.
