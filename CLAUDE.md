# Messenger PWA (proof of concept)

Mobile-first PWA messenger: email/password auth, DMs, group chats with
@mentions, web push notifications, webhook bots. See PLAN.md for the full plan
and phase checklist.

## Layout

- `shared/` — TypeScript types shared by client and server (`@messenger/shared`). Imported as TS source; no build step.
- `server/` — Express 5 + Socket.IO + Drizzle/better-sqlite3. Runs via tsx (no build step).
- `client/` — Vite + React 19 + Tailwind CSS v4 + React Router.

## Commands (run from repo root)

- `npm run dev` — server (:3001) + Vite (:5173, proxies /api and /socket.io)
- `npm test` — all workspace tests (vitest, `vitest run` mode)
- `npm run typecheck` — tsc --noEmit in all workspaces
- `npm run build` — production client build
- `npm run db:generate -w server` — regenerate Drizzle migrations after editing `server/src/db/schema.ts`

## Conventions

- **Dependency injection:** the Express app is built by `createApp(db)` (server/src/app.ts); tests create isolated DBs with `createDb(':memory:')` and never share state. Migrations run automatically in `createDb`.
- **Tests are colocated:** `src/**/*.test.ts(x)`. Server tests use supertest against `createApp`. Write tests for every feature you add; run them plus typecheck before declaring done.
- **API responses** use the DTO types from `@messenger/shared`. Never return `passwordHash`, `apiToken`, or raw DB rows.
- **Errors:** JSON `{ "error": "message" }` with a proper status code.
- **Express 5:** do not use `'*'` route patterns (path-to-regexp v8); use plain middleware for fallbacks.
- **Tailwind v4:** styles come from `@import "tailwindcss"` in client/src/index.css. No tailwind.config file — use CSS/utility classes.
- **No new npm dependencies** unless truly unavoidable — everything needed is installed.
- Auth: httpOnly session cookie `sid`; sessions table; passwords hashed with node:crypto scrypt (no bcrypt).
