#!/usr/bin/env node
// examples/echo-bot.mjs — a minimal webhook bot: echoes back whatever it's sent.
//
// Setup:
//   1. Register/login as a human (for the session cookie) and create the bot:
//        curl -c /tmp/cookies.txt -X POST http://localhost:3001/api/auth/register \
//          -H 'Content-Type: application/json' \
//          -d '{"email":"you@example.com","password":"supersecret","displayName":"You"}'
//        curl -b /tmp/cookies.txt -X POST http://localhost:3001/api/bots \
//          -H 'Content-Type: application/json' \
//          -d '{"name":"Echo Bot","webhookUrl":"http://localhost:4001"}'
//      Save the returned `apiToken` — it is shown only once.
//
//   2. Run this script with that token:
//        BOT_TOKEN=<apiToken> node examples/echo-bot.mjs
//
//   3. DM the bot from the app (or via the API — see README.md). Anything you
//      send comes back as "Echo: <your message>", in the DM or any group the
//      bot is a member of.
//
// How it works: the messenger server POSTs every new message in a chat the
// bot belongs to (except the bot's own) to this bot's webhookUrl, with an
// X-Bot-Token header carrying the bot's own apiToken — proof the call came
// from the server, since only the server and the bot know that token. This
// handler checks the header, then calls back into POST /api/bot/messages
// (Bearer-authenticated with the same token) to send the reply. No loop risk:
// the server never webhooks a bot about its own message.
//
// This bot also demos interactive ACTION BUTTONS: every echo reply carries two
// buttons. The same webhookUrl receives an { type: 'action', ... } payload when
// a member taps one (the message payload has no `type` field), and the bot
// replies naming the tapped button.

import http from 'node:http';

const MESSENGER_URL = process.env.MESSENGER_URL ?? 'http://localhost:3001';
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT ?? 4001);

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var (the apiToken returned by POST /api/bots).');
  process.exit(1);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// `actions` is optional (≤6 buttons: { id ≤64, label ≤40, style? 'primary'|'danger' }).
// When omitted it's dropped from the JSON — a plain text message.
async function reply(chatId, content, actions) {
  const res = await fetch(`${MESSENGER_URL}/api/bot/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BOT_TOKEN}` },
    body: JSON.stringify({ chatId, content, actions }),
  });
  if (!res.ok) {
    console.error(`[echo-bot] reply failed: ${res.status} ${await res.text()}`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/') {
    res.writeHead(404).end();
    return;
  }
  if (req.headers['x-bot-token'] !== BOT_TOKEN) {
    res.writeHead(403).end();
    return;
  }

  // Acknowledge immediately — the server fires webhooks and moves on, it
  // doesn't wait for our reply, so there's no reason to hold the connection.
  res.writeHead(200).end();

  readJson(req)
    .then((payload) => {
      // An action button was tapped (only this kind of payload carries `type`).
      if (payload.type === 'action') {
        const { action, user, chatId } = payload;
        console.log(`[echo-bot] ${user.displayName} tapped "${action.id}"`);
        return reply(chatId, `You tapped: ${action.id}`);
      }
      // Otherwise it's a new message — echo it back with two demo buttons.
      const { message, chat } = payload;
      console.log(
        `[echo-bot] ${message.sender.displayName} in chat ${chat.id}: ${message.content}`,
      );
      return reply(chat.id, `Echo: ${message.content}`, [
        { id: 'like', label: '👍 Like', style: 'primary' },
        { id: 'nope', label: '👎 Nope', style: 'danger' },
      ]);
    })
    .catch((err) => console.error('[echo-bot] failed to handle webhook:', err));
});

server.listen(PORT, () => {
  console.log(`[echo-bot] listening on http://localhost:${PORT}, replying via ${MESSENGER_URL}`);
});
