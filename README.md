# Messenger

A mobile-first PWA messenger for a small circle of people, self-hosted in a
single container. Started as a proof of concept, now feature-complete for
daily use. See [PLAN.md](PLAN.md) for the architecture history and
[examples/README.md](examples/README.md) for bots.

**Live demo:** https://messenger.sklk.lt/

## Features

**Conversations**
- 1:1 DMs, group chats (create, rename, add/remove members, leave — the last
  member out deletes the chat), and a notes-to-self DM
- Replies with quoted snippets — tapping a quote opens the whole reply chain
  in a full-screen thread view (collected server-side, so it's complete even
  deep into history) with its own composer: everything you send there replies
  to the thread root, so conversations thread without ever nesting
- Emoji reactions (fixed six-emoji picker, tap-to-toggle chips)
- Edit and delete your own messages (deletes leave a neutral tombstone)
- Long-press / hover popover per bubble: react, copy, reply, edit, delete —
  position-aware so it never opens off-screen (inside a thread, Reply becomes
  "Show in chat", which jumps to the message in the main conversation)

**Writing**
- Markdown subset: **bold**, *italic*, ~~strike~~, `code`, code blocks,
  links, lists, quotes — safe by default (raw HTML inert, images stripped,
  `javascript:` links neutralized); configurable renderer ready for richer
  bot messages
- @mentions with autocomplete; being mentioned is highlighted
- Multiline composer: Enter = newline, Shift/Ctrl/Cmd+Enter = send
- Per-chat drafts survive switching chats and reloads
- Offline outbox: text sends queue while offline ("sending…" bubbles) and
  flush in order on reconnect; failures offer tap-to-retry
- Scheduled messages: the clock button sends later ("in 1 hour", "this
  evening", "tomorrow 09:00", or any time) — doubles as reminders; pending
  ones are listed and cancelable per chat
- Paste or drag images straight into the composer

**Media & attachments**
- Images with client-side compression + an HD toggle, server-side
  thumbnails, and a lightbox
- Inline video playback (mp4/webm/mov, streamed with HTTP Range so seeking
  and iOS work); browsers that can't decode a codec get a download card
- Voice messages: tap the mic, record, send — inline audio player on the
  bubble (webm/opus, or mp4/AAC on iOS)
- PDFs open in the browser's native viewer (magic-bytes-verified before
  serving inline)
- Everything else becomes a download card (25MB cap; SVGs never render
  inline — XSS hygiene)

**Finding things**
- Full-text message search (SQLite FTS5) across your chats, with highlighted
  snippets — tapping a hit opens the chat centered on that message, with
  "load newer/older" paging from anywhere in history
- Unread divider ("New messages") frozen where you left off, plus a
  jump-to-bottom pill with a live new-message count
- History loads automatically as you scroll up (no "load more" buttons)

**Presence & notifications**
- Real-time delivery over Socket.IO; typing indicators; online presence dots
- Read receipts (Messenger-style "seen up to" avatars)
- Web push when the app is closed — mentions get a "X mentioned you" title,
  and tapping the notification deep-links into the chat
- Per-chat mute (no push from that chat; unread counts still work)

**Links**
- Pasted links grow an Open Graph preview card (title, description, image),
  fetched server-side behind an SSRF guard (private-range blocking, redirect
  re-vetting, size/time caps)

**Personalization**
- Dark / light / system theme (no white flash on load; PWA chrome follows)
- Pick your accent color: it colors your avatar, your name in group chats,
  and blends into the group avatar (a pie of all members' colors)
- Profile editing: display name and password

**Bots**
- Webhook bots with a management UI at `/bots`: incoming messages POST to
  the bot's webhook; it replies via a Bearer-token API and fans out like any
  human message (see [examples/README.md](examples/README.md))
- Interactive actions: a bot can attach up to six buttons to a message;
  tapping one calls the bot's webhook back — enough for confirmations,
  menus, and quick-reply workflows. Actions are one-shot: the first tap
  becomes a visible "✓ choice — member" record for everyone
- Bots can schedule, list, and cancel send-later messages of their own

**PWA & ops**
- Installable, offline app shell, hand-rolled service worker
- Share target: share a photo/link from any app straight into a chat via
  the OS share sheet (Android; iOS doesn't support Web Share Target)
- Unread-count badge on the app icon
- `/healthz` endpoint for the reverse proxy / Docker healthcheck
- Automatic cleanup of orphaned attachment files (abandoned uploads, deleted
  messages)

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
list).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | server + client dev servers, concurrently |
| `npm test` | all workspace tests (vitest + supertest + real-socket integration) |
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
silently falls back to polling. Point your proxy/container healthcheck at
`GET /healthz`. On iOS (16.4+), push only works after the PWA is installed
to the home screen. Compose is a dev/test convenience — plain `docker run`
with the same env vars works identically.

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
(online users), web push (offline users), bot webhooks, and the link-preview
fetcher are four independent subscribers to that bus. Auth is an httpOnly
session cookie backed by a sessions table, shared by REST and the socket
handshake. The PWA layer is a hand-rolled service worker (offline app shell,
push, notification click → deep link into the chat) — no build-plugin magic.

## Known limits (deliberate cuts)

No E2E encryption, no email verification/password reset, single node only
(in-process socket registry and event bus — fine for one container). No
WebRTC calls. Backups are expected to happen at the system level
(`DATABASE_PATH` + `UPLOADS_DIR` are the whole state). The offline outbox
has no idempotency key, so a send whose response is lost can duplicate on
flush. Link-preview fetching re-vets every redirect but can't pin the
connection IP (documented DNS-rebinding residual — acceptable for a
private, small-circle deployment).
