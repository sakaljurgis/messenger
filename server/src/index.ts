import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.js';
import { startAttachmentCleanup } from './cleanup.js';
import { createDb } from './db/index.js';
import { createChatEvents } from './events.js';
import { initPush } from './push.js';
import { initSocket } from './socket.js';
import { createStorage } from './storage.js';
import { initWebhooks } from './webhooks.js';

// Best-effort: load a repo-root `.env` (VAPID keys, APP_ORIGIN, …) so dev works
// without any dotenv dependency. Node 24's built-in loader; ignored if absent.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // No root .env (prod/CI supply env directly) — carry on.
}

const PORT = Number(process.env.PORT ?? 3001);

const db = createDb();
// Attachment blob store on the volume. Ensure the directory exists before serving.
const storage = createStorage();
storage.ensureDir();
// Reap orphaned attachments (tombstone leftovers + never-linked uploads) once at
// boot, then on a 6h interval. The handle's timer is unref'd so it never holds
// the process open; we don't need to keep the handle (it lives for the process).
startAttachmentCleanup(db, storage);
// Shared fan-out bus. Phase 3 (Socket.IO), phase 5 (web push) and phase 6
// (webhooks) will subscribe to this same instance to relay chat/message events.
const events = createChatEvents();
const app = createApp(db, events, storage);
const server = http.createServer(app);

// Socket.IO: authenticates via the session cookie and relays fan-out events on
// `events` to connected members. The returned handle (presence registry) is
// consumed by phase 5 to route web push to offline members only.
const socket = initSocket(server, db, events);

// Web push: notifies members without a live socket. Uses the same presence
// registry so a message is never both pushed and delivered live to one member.
initPush(db, events, socket.isUserConnected);

// Webhooks: POSTs new messages to any bot member's webhookUrl (see webhooks.ts).
initWebhooks(db, events);

// In production the container serves the built client from ../client/dist.
if (process.env.NODE_ENV === 'production') {
  const clientDist = fileURLToPath(new URL('../../client/dist', import.meta.url));
  app.use(express.static(clientDist));
  // SPA fallback (plain middleware — Express 5 forbids '*' patterns).
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
