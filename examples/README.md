# Bot examples

Phase 6 (webhook bots): a bot is just a `users` row with `isBot=true`, an
`apiToken`, and an optional `webhookUrl`. It's DM'd and added to groups
exactly like a human. See `PLAN.md` for the full design.

## 1. Create a bot

Bots are created by an authenticated human via `POST /api/bots`. Register (or
log in) first to get a session cookie, then create the bot:

```bash
# Register a human (skip if you already have an account) and save the cookie.
curl -c /tmp/cookies.txt -X POST http://localhost:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"supersecret","displayName":"You"}'

# Create the bot. webhookUrl is where the server will POST new messages.
curl -b /tmp/cookies.txt -X POST http://localhost:3001/api/bots \
  -H 'Content-Type: application/json' \
  -d '{"name":"Echo Bot","webhookUrl":"http://localhost:4001"}'
```

The response is `{ "bot": {...UserDTO }, "apiToken": "..." }`. **Copy the
`apiToken` now** — it's returned only in this response and can't be fetched
again.

## 2. Run the echo bot

```bash
BOT_TOKEN=<apiToken> node examples/echo-bot.mjs
# optional: MESSENGER_URL=http://localhost:3001 PORT=4001
```

This starts a plain `node:http` server on `PORT` (default 4001). It has no
dependencies — just `node:http` and the global `fetch`.

## 3. Try it in the app

- Open the app, go to People, and tap **Echo Bot** to open (or create) a DM.
  Send "hi" — within a second or two you'll see "Echo: hi" appear, sent by
  the bot itself.
- Add the bot to a group the same way you'd add any user (`New Group` or
  `PATCH /api/chats/:id/members`); it echoes there too.

## How delivery works

Sending a message is always `POST .../messages` — bots use
`POST /api/bot/messages` (`Authorization: Bearer <apiToken>`), humans use
`POST /api/chats/:id/messages` (session cookie). Both go through the exact
same server-side path (`chats/service.ts#createMessage`), so bots follow the
same membership/mention/unread rules as humans.

After a message is persisted, the server fans it out three ways from one
event (`message:new`):

- Socket.IO to members with a live connection,
- web push to members without one,
- a webhook POST to any **bot** member (regardless of whether it's "online" —
  bots have no socket, so they always get a webhook, never a push).

The bot's own message is excluded from its own webhook fan-out, so an echo
bot can't trigger an infinite loop with itself.

Webhook delivery has a 5s timeout and retries once (~1s later) on a network
error or non-2xx response; if that also fails, the server logs a warning and
gives up silently — a dead bot never blocks message delivery for anyone else.
