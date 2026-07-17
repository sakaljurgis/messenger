# Messenger PWA

Mobile-first PWA messenger, feature-complete for daily use: email/password
auth, profile editing (name + password + accent color), DMs + group chats
(group-info sheet: add members, rename, mute, leave; last member out deletes
the chat), notes-to-self DMs, @mentions, markdown messages (react-markdown
behind a configurable module in client/src/lib/markdown), emoji reactions,
replies with a thread view (tapping the quote chip opens a full-screen overlay
with the whole reply chain — server-collected via recursive CTE at
GET /messages/:id/thread so it spans beyond the loaded window; its composer
replies to the thread ROOT, Reply is hidden inside so no sub-threads, and
"Show in chat" in the long-press menu jumps to the original; ?thread= URL
param so the back button closes it), FTS5 message search with windowed history
(?around=/?after=), Socket.IO real-time, web push + per-chat mute, webhook
bots (management UI at /bots; deletes are soft — users.deletedAt — so message
history keeps its sender), attachments (client compression + HD toggle, sharp
thumbnails, sliding-gallery lightbox, inline video/audio with Range streaming,
voice messages; PDFs open in an in-app pdf.js viewer — pdfjs-dist is
lazy-loaded, and PDF cards must NEVER be links: any navigation strands the
installed PWA on a view with no back affordance), link previews
(SSRF-guarded server fetcher in
server/src/link-previews.ts, a 4th event-bus subscriber), message edit/delete
(tombstones), offline outbox + per-chat drafts, read receipts, typing
indicators, presence dots, dark/light/system theme, orphaned-attachment
cleanup + /healthz. Personal app for a couple of users — multi-node scaling
is explicitly out of scope. PLAN.md has the architecture/phase history;
README.md has run/deploy instructions; examples/README.md covers bots.
DB migrations: journal `when` values MUST be strictly increasing (the
migrator skips otherwise — guarded by db/migrations.test.ts), and any
hand-written schema migration needs a matching drizzle meta snapshot.

## Layout (npm workspaces)

- `shared/src/index.ts` — ALL DTO + socket-event types, imported as TS source
  by both sides (no build step). This is the API contract; change it first.
- `server/` — Express 5 + Socket.IO + Drizzle/better-sqlite3, runs via tsx.
  - `src/app.ts` — `createApp(db, events?, storage?)` DI factory (routes only);
    `src/index.ts` — boot: env, static serving, socket/push/webhook wiring.
  - `src/db/schema.ts` + `drizzle/` migrations (auto-run in `createDb`).
  - `src/events.ts` — typed in-process event bus; THE fan-out spine. Every
    message write goes through `createMessage` in `src/chats/service.ts`,
    which emits `message:new`; sockets (`socket.ts`), web push (`push.ts`),
    and bot webhooks (`webhooks.ts`) are three independent subscribers.
  - `src/routes/` — auth, users (+profile/password), chats (+messages
    edit/delete, rename, members, leave), attachments, push, bots
    (human-facing management), bot-api (Bearer-token inbound for bots).
  - `src/storage.ts` — filesystem attachment store (UPLOADS_DIR, default
    ./data/uploads); interface kept minimal so S3 could replace it.
  - `src/auth/` — scrypt password hashing + session cookie (`sid`, httpOnly);
    `getSessionUser` is shared by REST middleware and the socket handshake.
- `client/` — Vite + React 19 + Tailwind v4 + React Router 7.
  - `src/lib/` — api (fetch wrapper + ApiError), auth (context; connects
    socket), socket (lazy singleton), chats (ALL data hooks: useChats,
    useMessages, useChat, typing stores, readPositions), mentions (pure
    mention logic), attachments (compression, XHR upload, URLs), presence
    (online-users store), push (subscribe flow), pwa (SW registration).
  - `src/pages/` — Login, Register, Users, ChatList, Chat, NewGroup,
    Settings, Bots.
  - `src/components/` — AppLayout (bottom tabs), Avatar (sizes + presence
    dot), Composer (mentions autocomplete, attachments, HD toggle, edit
    mode), GroupInfo (members/add/rename/leave sheet), Lightbox, RequireAuth.
  - `public/` — manifest.webmanifest, sw.js (hand-rolled: offline shell,
    push, notification click → /chats/:id), icons/ (source icon.svg; PNGs
    regenerated via `npm run icons -w client`, sharp-based script).
- `Dockerfile` — multi-stage, single container; `docker-compose.yml` is
  DEV/TEST ONLY (production runs behind the user's HTTPS reverse proxy via
  plain `docker run`; proxy must forward WebSocket upgrades on /socket.io).

## Commands (run from repo root)

- `npm run dev` — server :3001 + Vite :5173 (proxies /api and /socket.io)
- `npm test` / `npm run typecheck` / `npm run build` — all workspaces
- `npm run db:generate -w server` — regenerate migration after schema edits

Env (root `.env`, auto-loaded by server in dev): VAPID_PUBLIC_KEY /
VAPID_PRIVATE_KEY (`npx web-push generate-vapid-keys`), APP_ORIGIN,
DATABASE_PATH, UPLOADS_DIR, PORT.

## Conventions

- **DI everywhere:** tests build isolated apps via
  `createApp(createDb(':memory:'), createChatEvents(), createStorage(tmpdir))`.
  Side-effect senders are injectable (`initPush(..., send)`,
  `initWebhooks(..., fetchFn)`) and return `{ lastDispatch }` promises for
  awaiting in tests.
- **Tests colocated** (`src/**/*.test.ts(x)`), written per feature, run before
  declaring done. Server: supertest + real-TCP Socket.IO integration tests.
  Client: testing-library + mocked fetch/socket.
- **DTOs only** over the wire (from `@messenger/shared`); never leak
  passwordHash/apiToken/raw rows. Deleted messages are tombstoned SERVER-side
  (content '', empty mentions/attachments, isDeleted true).
- **Errors:** JSON `{ "error": "message" }` + proper status. Non-member chat
  access → 404 (no existence leaks). Express 5: no `'*'` route patterns.
- **Attachment safety:** SVG never inline (kind 'file'), unknown types forced
  to download; nosniff + CSP sandbox headers on the serving endpoint.
- **Socket fan-out targets `user:{id}` rooms** (never chat rooms) — covers
  new chats and multi-tab. Presence offline-broadcast is debounced 5s;
  `isUserConnected` (push targeting) stays real-time. Membership removals
  emit `chat:removed` to the removed user (a non-member can't receive a
  personalized `chat:updated` summary).
- **No new npm deps** without explicit approval — check what's installed first.
- **Test/process hygiene (hard rules):** never `pkill -f` generic patterns —
  track PIDs or close servers in afterEach; never run `vitest -w` (watch mode,
  hangs CI/agents); in jsdom socket tests emit server events only via the
  `emitFromServer` guard (waits for the component's subscription — a too-early
  emit is silently lost and flakes).
