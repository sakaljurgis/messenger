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

## Interactive action buttons

A bot can attach up to **6 tappable buttons** to any message it sends, by
adding an `actions` array to the send body. Each action is
`{ id, label, style? }` — `id` ≤64 chars (echoed back on tap), `label` ≤40
chars, and an optional `style` of `"primary"` (blue) or `"danger"` (red);
omit it for a neutral gray button. Ids must be unique within a message.
Buttons are a bot-only feature — a human client that sends `actions` has the
field ignored.

```bash
# The bot sends a message with two buttons (Bearer-authenticated like any send).
curl -X POST http://localhost:3001/api/bot/messages \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"chatId":1,"content":"Deploy to production?","actions":[
        {"id":"go","label":"Deploy","style":"primary"},
        {"id":"stop","label":"Cancel","style":"danger"}
      ]}'
```

When a member taps a button, the server POSTs an **action callback** to the
same `webhookUrl` (same `X-Bot-Token` header, same timeout/retry). Its shape is
distinguished from a message webhook by a `type` field:

```json
{
  "type": "action",
  "action": { "id": "go" },
  "message": { "...": "the MessageDTO that carried the buttons" },
  "user": { "...": "the UserDTO of whoever tapped" },
  "chatId": 1
}
```

The bot reacts however it likes — usually by sending a follow-up message. The
tap itself returns `204` immediately; the callback is fire-and-forget, so the
bot's reply arriving in the chat is the visible feedback. Tombstoned (deleted)
messages drop their buttons, and taps on them are rejected. See
`echo-bot.mjs` — it echoes every message back with 👍/👎 buttons and replies
when one is tapped.
