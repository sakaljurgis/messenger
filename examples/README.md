# Bot API reference

A bot is a regular `users` row with `isBot=true`, an `apiToken`, and an
**optional** `webhookUrl`. It's DM'd and added to groups exactly like a human,
and it sends messages through the exact same server-side path a human does
(`chats/service.ts#createMessage`), so it obeys the same membership, mention,
unread and fan-out rules. See `PLAN.md` for the design.

Two independent capabilities, either of which a bot can use alone:

- **Receiving** needs a `webhookUrl` — the server POSTs new messages and action
  taps there. A bot with no `webhookUrl` simply never hears anything.
- **Sending / scheduling** needs only the `apiToken` — a bot with no webhook can
  still push messages in on a timer or in response to something outside the app.

`examples/echo-bot.mjs` is a complete, dependency-free bot that does both.

## 1. Create a bot

Either in the app (**Settings → Bots**, or `/bots`), or over the API as an
authenticated human:

```bash
# Register a human (skip if you already have an account) and save the cookie.
curl -c /tmp/cookies.txt -X POST http://localhost:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"supersecret","displayName":"You"}'

# Create the bot. webhookUrl is optional (omit it for a send-only bot).
curl -b /tmp/cookies.txt -X POST http://localhost:3001/api/bots \
  -H 'Content-Type: application/json' \
  -d '{"name":"Echo Bot","webhookUrl":"http://localhost:4001"}'
```

The response is `{ "bot": { ...UserDTO }, "apiToken": "..." }`. **Copy the
`apiToken` now** — it's returned only in this response and can't be fetched
again (regenerate by deleting and recreating the bot). `webhookUrl` is editable
later via `PATCH /api/bots/:id`.

## 2. Auth model — two tokens, two directions

Everything uses the bot's single `apiToken`, but in two different headers
depending on who is calling whom:

| Direction | Request | Header |
| --- | --- | --- |
| **Server → bot** (webhook delivery) | the server POSTs to your `webhookUrl` | `X-Bot-Token: <apiToken>` |
| **Bot → server** (send / schedule) | you POST to `/api/bot/*` | `Authorization: Bearer <apiToken>` |

The `X-Bot-Token` on an inbound webhook is your proof the call really came from
the messenger server (only the server and the bot know that token) — **check
it** and reject anything else, as `echo-bot.mjs` does. The bot API never accepts
the session cookie; humans and bots are separate auth worlds.

## 3. Receiving — webhook payloads

For every new message in a chat the bot belongs to (**except the bot's own
messages** — no echo loop), the server POSTs to the bot's `webhookUrl` with an
`X-Bot-Token` header and this body. Note there is **no `type` field** on a
message payload — that's how you tell it apart from an action tap:

```json
{
  "message": { "...": "the full MessageDTO — id, sender, content, mentions, replyTo, attachments, ..." },
  "chat": { "id": 1, "type": "group", "name": "Deploys" }
}
```

`chat` is a thin summary (`id`, `type` = `"dm"` | `"group"`, `name` = `null`
for DMs), not the full chat object. When a member **taps an action button** on a
message the bot sent, the server POSTs a different, `type`-tagged payload to the
same URL (same header, timeout and retry):

```json
{
  "type": "action",
  "action": { "id": "go" },
  "message": { "...": "the MessageDTO that carried the buttons" },
  "user": { "...": "the UserDTO of whoever tapped" },
  "chatId": 1
}
```

**Delivery semantics.** Best-effort and fire-and-forget: a **5s timeout**, and
**one retry ~1s later** on a network error or non-2xx response; if that also
fails the server logs a warning and gives up — a dead bot never blocks message
delivery for anyone else. So **respond fast** (ack with `200` immediately, then
do your work), and treat delivery as at-most-once. A bot without a `webhookUrl`
is skipped entirely.

## 4. Sending — `POST /api/bot/messages`

`Authorization: Bearer <apiToken>`. The bot must already be a member of the
chat (non-member → `404 "Chat not found"`, no existence leak). Body:

| Field | Rules |
| --- | --- |
| `chatId` | required; a chat the bot is a member of |
| `content` | trimmed, ≤4000 chars; may be empty **only** if `attachmentIds` is non-empty |
| `mentions` | optional user ids; silently filtered to actual chat members |
| `replyToId` | optional; must be a **live** message in the same chat, else `400 "Invalid reply target"` |
| `actions` | optional button row, **bots only** (see below) |
| `attachmentIds` | optional ids of already-uploaded attachments — but there is no Bearer upload endpoint, so bots rarely use this |

`actions` — up to **6** tappable buttons, each `{ id, label, style? }`: `id`
non-empty ≤64 chars (echoed back on tap), `label` non-empty ≤40 chars, optional
`style` `"primary"` (blue) or `"danger"` (red) — omit for neutral gray. Ids must
be unique within the message. Any violation → `400`.

```bash
curl -X POST http://localhost:3001/api/bot/messages \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "chatId": 1,
        "content": "Deploy to production?",
        "actions": [
          {"id":"go","label":"Deploy","style":"primary"},
          {"id":"stop","label":"Cancel","style":"danger"}
        ]
      }'
```

Success → `201 { "message": { ...MessageDTO } }`, fanned out to sockets / push /
webhooks exactly like a human send. A tap returns `204` to the tapper
immediately; your action callback (§3) is the bot's cue to follow up — usually
by sending another message. Tombstoned (deleted) messages drop their buttons and
reject taps.

## 5. Scheduling — send later

Three Bearer-authenticated endpoints mirror the human send-later routes. Because
the bot API isn't chat-scoped, the chat id travels in the **body** (POST) or the
**query string** (GET) instead of the path. Validation, bounds and the cap are
identical to the human path.

**`POST /api/bot/scheduled`** — queue one. Body is a send plus a time:

```bash
curl -X POST http://localhost:3001/api/bot/scheduled \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "chatId": 1,
        "content": "Standup in 5 minutes",
        "scheduledAt": "2026-07-10T09:25:00.000Z"
      }'
```

- `chatId` required (missing/malformed → `400`; not a member → `404 "Chat not
  found"`).
- `content` trimmed 1–4000 (text only — **you can't schedule attachments**).
- `scheduledAt` ISO 8601, **≥1 minute** and **≤1 year** in the future.
- `mentions` / `replyToId` optional, same rules as a live send (`replyToId` must
  be live in the chat *at scheduling time*).
- **Cap: 20 pending rows per bot per chat.** The cap is keyed per sender, so a
  bot's budget is entirely its own — independent of humans and of other bots in
  the same chat. The 21st → `400`.

Success → `201 { "scheduled": { ...ScheduledMessageDTO } }`, where
`ScheduledMessageDTO` is `{ id, chatId, content, mentions, replyToId,
scheduledAt, createdAt }`.

**`GET /api/bot/scheduled?chatId=<id>`** — the bot's **own** pending rows for
that chat, soonest first. `chatId` is required (`400` without it); non-member →
`404`. Returns `{ "scheduled": ScheduledMessageDTO[] }` (never another sender's
rows).

**`DELETE /api/bot/scheduled/:id`** — cancel one of the bot's own pending rows →
`204`. Anyone else's row (another bot's, a human's) or an unknown id → `404`, no
leak.

There is **no PATCH** — to *adjust* a scheduled message, `DELETE` the old row
and `POST` a new one.

At the scheduled time a background dispatcher sends the row through the same
`createMessage` path a live send uses, so sockets / push / webhooks all fire as
if the bot had just posted it. Two things can change between scheduling and
sending: if the bot has **left the chat**, the row is dropped silently; if the
`replyToId` target has since been **deleted**, the message still goes out, just
without the quote (degrade, don't drop).

## 6. What a bot can't do

The bot API is deliberately send-shaped. Bots **cannot**:

- edit or delete their own (or any) messages — there is no bot edit/delete route;
- react to messages with emoji;
- tap their own (or anyone's) action buttons — only humans tap; the bot merely
  receives the callback;
- upload or schedule attachments — the upload endpoint is session-only, and
  scheduled messages are text only.

## 7. Walkthrough — `examples/echo-bot.mjs`

Run it against a bot that has a `webhookUrl`:

```bash
BOT_TOKEN=<apiToken> node examples/echo-bot.mjs
# optional: MESSENGER_URL=http://localhost:3001 PORT=4001
```

It's a plain `node:http` server (default port 4001) with no dependencies — just
`node:http` and the global `fetch`. The loop:

1. **Authenticate the caller.** Every request is rejected unless its
   `X-Bot-Token` header equals `BOT_TOKEN` — proof it's the messenger server.
2. **Ack immediately** with `200`, *then* read and handle the body — the server
   doesn't wait, so there's no reason to hold the connection.
3. **Branch on the payload.** A body with `type === 'action'` is a tap → the bot
   replies `"You tapped: <id>"`. Anything else is a new message → the bot replies
   `"Echo: <content>"` **and attaches two demo buttons** (👍 Like / 👎 Nope).
4. **Reply** by calling back into `POST /api/bot/messages` with
   `Authorization: Bearer <BOT_TOKEN>`.

That closes the **action round-trip**: the echo reply carries buttons → a member
taps one → the server POSTs the `type: 'action'` callback back to the same
`webhookUrl` → the bot sends a follow-up naming the tapped button. Adding a timer
that calls `POST /api/bot/scheduled` would extend the same pattern to send-later.

### Try it in the app

- Open the app, go to **People**, tap **Echo Bot** to open (or create) a DM, and
  send "hi" — within a second or two "Echo: hi" appears, sent by the bot, with
  two buttons. Tap one and the bot replies naming it.
- Add the bot to a group like any other user (**New Group**, or
  `PATCH /api/chats/:id/members`); it echoes there too.
