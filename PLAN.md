# Messenger PWA — Project Plan

A proof-of-concept mobile-first PWA messenger: email/password auth, user directory,
1:1 and group chats, @mentions, web push notifications, and (later) webhook-based bots.
No E2E encryption.

## Stack

| Layer      | Choice                                             |
|------------|----------------------------------------------------|
| Frontend   | React 19 + TypeScript, Vite, Tailwind CSS, React Router |
| Real-time  | Socket.IO (client + server)                        |
| Backend    | Node 24, Express, TypeScript                       |
| Database   | SQLite via better-sqlite3 + Drizzle ORM (drizzle-kit migrations) |
| Auth       | httpOnly cookie sessions (sessions table, `crypto.scrypt` password hashing — no native deps) |
| Push       | Web Push API, `web-push` package, VAPID keys       |
| PWA        | hand-rolled service worker in client/public (no build plugin) |
| Deployment | Single Docker container: Express serves API, Socket.IO, and the built React app. SQLite on a volume. |

## Repository layout

```
messenger/
├── client/            # Vite + React app
│   ├── src/
│   │   ├── pages/     # Login, Register, Users, ChatList, Chat, NewGroup, Settings
│   │   ├── components/
│   │   └── lib/       # api client, socket client, push helpers
│   ├── public/        # manifest, icons, sw.js (offline shell + push handlers)
│   └── ...
├── server/
│   ├── src/
│   │   ├── db/        # drizzle schema, migrations, connection
│   │   ├── routes/    # auth, users, chats, messages, push, bots
│   │   ├── socket.ts  # Socket.IO setup, rooms, auth middleware
│   │   ├── push.ts    # web-push sending
│   │   └── index.ts
│   └── ...
├── shared/            # types shared by client & server (API DTOs, socket events)
├── Dockerfile         # multi-stage build
├── docker-compose.yml # app + volume (+ optional Caddy for HTTPS later)
└── PLAN.md
```

npm workspaces tie the three packages together.

## Data model

```
users              id, email (unique), password_hash, display_name,
                   is_bot, webhook_url?, api_token?, created_at
sessions           token, user_id, expires_at
chats              id, type ('dm'|'group'), name (null for dm), dm_key (unique,
                   "minUserId:maxUserId", null for groups), created_by, created_at
chat_members       chat_id, user_id, joined_at, last_read_message_id   [PK: chat_id+user_id]
messages           id, chat_id, sender_id, content, created_at
message_mentions   message_id, user_id
push_subscriptions id, user_id, endpoint (unique), p256dh, auth, created_at
```

Notes:
- `dm_key` enforces one DM per user pair at the DB level.
- `last_read_message_id` drives unread counts.
- Bots are rows in `users` with `is_bot = true` — they join chats, send and
  receive messages through the same tables as humans. This is what makes the
  webhook phase cheap.

## API surface

```
POST   /api/auth/register        email, password, displayName
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/users                directory (excludes self)
GET    /api/chats                my chats + last message + unread count
POST   /api/chats                { userId } → DM (idempotent via dm_key)
                                 { name, memberIds } → group
PATCH  /api/chats/:id/members    add members to a group
GET    /api/chats/:id/messages   cursor-paginated, newest first
POST   /api/chats/:id/messages   { content, mentions?: userId[] }
POST   /api/chats/:id/read       mark read up to message id

POST   /api/push/subscribe       store PushSubscription
DELETE /api/push/subscribe
GET    /api/push/vapid-key

POST   /api/bots                 create bot { name, webhookUrl } → apiToken
POST   /api/bot/messages         Bearer <apiToken>; { chatId, content } — bot replies
```

**Message flow (one path for humans and bots):** sending is always REST `POST
…/messages`, funneled through one `createMessage` service function that emits
on a typed event bus. Three independent subscribers fan out: Socket.IO to each
member's user room, web push to members with no live socket, webhook POST to
bot members. Sockets are receive-only — the bot API is identical to the human
one and the send path exists exactly once.

## Socket.IO design

- Handshake middleware authenticates via the session cookie.
- On connect, the socket joins `user:{id}`; all fan-out targets user rooms
  (covers chats created after connect and multi-tab for free).
- Server → client events: `message:new`, `chat:new`, `chat:updated`.
- Client → server: `typing` (stretch goal).
- Track connected user ids in memory to decide who gets web push instead.

## Push notifications

- VAPID keypair from env; `web-push` on the server.
- Client asks for Notification permission after login (from Settings and via a
  soft prompt), registers the subscription.
- Service worker `push` handler shows: sender + preview; title becomes
  "X mentioned you in <group>" when the recipient is in `message_mentions`.
- `notificationclick` focuses/opens the app at `/chats/:id`.
- Constraint to remember: push requires HTTPS (localhost exempt), and on iOS
  only works for home-screen-installed PWAs (16.4+).

## @mentions

- Composer detects `@` and shows an autocomplete of chat members; selected
  mentions are submitted as `mentions: userId[]` alongside the text.
- Rendered highlighted in the message bubble.
- Mentioned users get the boosted push title even in muted/busy groups (PoC:
  just the different title).

## UI (mobile-first, Tailwind)

Single-column navigation, width-capped and centered on desktop.

- `/register`, `/login` — minimal forms.
- `/users` — directory; tap a user → opens (or creates) the DM.
- `/chats` — chat list: avatar, name, last message preview, unread badge.
- `/chats/:id` — conversation: bubbles (own right/blue, others left/gray),
  sticky composer, mention autocomplete, day separators.
- `/chats/new-group` — name + member multi-select.
- `/settings` — display name, notification toggle, logout.
- Bottom tab bar: Chats / People / Settings.

## Docker

Multi-stage: build client + server → `node:24-slim` runtime with production
deps only. SQLite file at `/data/messenger.db` (volume). Env: `PORT`,
`DATABASE_PATH`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `APP_ORIGIN`
(sessions are random DB-backed tokens — no signing secret needed).
Migrations run on container start. For real-device push testing,
add Caddy (automatic HTTPS) to docker-compose or tunnel via something like
cloudflared.

## Phases

- [x] **0 — Scaffolding**: workspaces, Vite + React + Tailwind, Express + TS,
      Drizzle schema + first migration, dev scripts (concurrent client/server
      with Vite proxy), Dockerfile skeleton.
- [x] **1 — Auth**: register/login/logout, sessions, route guards, `/me`.
- [x] **2 — Chats over REST**: user directory, DM creation, group creation,
      chat list with unread counts, conversation view, sending/paging messages.
- [x] **3 — Real-time**: Socket.IO wiring, live `message:new`/`chat:new`,
      live unread badges.
- [x] **4 — Mentions**: autocomplete composer, `message_mentions`, highlighting.
- [x] **5 — PWA + push**: manifest, icons, service worker, offline app shell,
      subscribe flow, push fan-out with mention-aware titles, notification click.
- [x] **6 — Bots**: bot registration, webhook delivery (with retry/timeout),
      inbound bot message endpoint, a tiny example echo-bot script.
- [ ] **7 — Polish (stretch)**: typing indicators, online presence dots,
      docker-compose with Caddy, avatar colors/initials, smoke tests
      (vitest + supertest) for auth and message fan-out.

Each phase ends in a working, demoable state.

## Deliberate PoC cuts

No E2E encryption, no message editing/deletion, no attachments/images, no read
receipts (beyond unread counts), no rate limiting beyond the basics, no email
verification/password reset, single-node only (in-memory socket registry —
fine for one container).

## Phase 6 implementation notes

- `server/src/chats/service.ts#createMessage` is now the single message-write
  path (persist, filter mentions to members, bump the sender's own read
  marker, emit `message:new`); both `routes/chats.ts` (humans) and
  `routes/bot-api.ts` (bots) call it, so there's exactly one place the rules
  for "sending a message" can drift.
- `server/src/routes/bots.ts` (`POST /api/bots`, session auth) creates the bot
  user and returns the `apiToken` exactly once. `server/src/routes/bot-api.ts`
  (mounted at `/api/bot`) authenticates the *reverse* direction —
  `Authorization: Bearer <apiToken>` instead of the session cookie.
- `server/src/webhooks.ts#initWebhooks` is push.ts's sibling: same
  event-bus-subscriber shape, same injectable-fn-plus-`lastDispatch`
  testability hook, but fans out to bot members' `webhookUrl`s instead of
  push subscriptions. 5s timeout, one retry after ~1s, then a `console.warn`
  and give up — never throws out of the event handler.
- `examples/echo-bot.mjs` + `examples/README.md`: a dependency-free
  `node:http` bot that echoes messages back, and the curl walkthrough to
  create/run/DM it.
