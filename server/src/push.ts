import webpush from 'web-push';
import { eq, inArray } from 'drizzle-orm';
import type { MessageDTO } from '@messenger/shared';
import type { Db } from './db/index.js';
import { pushSubscriptions, type ChatRow } from './db/schema.js';
import type { ChatEvents } from './events.js';

/**
 * Web push fan-out. Subscribes to the shared event bus and, for every member who
 * is NOT currently connected via Socket.IO, sends a notification to each of their
 * stored push subscriptions. This is the offline counterpart to the socket relay:
 * online members get a live `message:new`, offline ones get a push.
 *
 * VAPID keys come from the environment. When they're absent (the common dev case)
 * push is a documented no-op — the app still works, just without notifications.
 */

/** JSON shape the service worker's `push` handler consumes (see client/public/sw.js). */
export interface PushPayload {
  title: string;
  body: string;
  data: { chatId: number; messageId: number };
}

export interface PushHandle {
  /** The VAPID public key clients subscribe with, or null when push is unconfigured. */
  vapidPublicKey: string | null;
  /**
   * Resolves when the most recent `message:new` fan-out has finished sending.
   * Reassigned on every event — tests `await handle.lastDispatch` after POSTing a
   * message to deterministically assert on which sends happened.
   */
  lastDispatch: Promise<void>;
}

/** Max chars of message content shown in the notification body before truncation. */
const MAX_BODY_CHARS = 120;

/** The configured VAPID public key (non-empty), or null when push is unconfigured. */
export function getVapidPublicKey(): string | null {
  const key = process.env.VAPID_PUBLIC_KEY?.trim();
  return key ? key : null;
}

/** Truncate a message preview to at most `max` visible chars, adding an ellipsis when cut. */
function truncate(text: string, max = MAX_BODY_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Pure builder for the notification payload a single recipient should receive.
 * Title rules:
 *   - the recipient is @-mentioned → "<sender> mentioned you in <chat name | 'a chat'>"
 *   - group (not mentioned)        → "<sender> in <group name>"
 *   - DM                           → "<sender>"
 * Exported for direct unit testing without a running server.
 */
export function buildPushPayload(
  message: MessageDTO,
  chat: ChatRow,
  forUserId: number,
): PushPayload {
  const sender = message.sender.displayName;
  let title: string;
  if (message.mentions.includes(forUserId)) {
    title = `${sender} mentioned you in ${chat.name ?? 'a chat'}`;
  } else if (chat.type === 'group') {
    title = `${sender} in ${chat.name}`;
  } else {
    title = sender;
  }
  return {
    title,
    body: truncate(message.content),
    data: { chatId: message.chatId, messageId: message.id },
  };
}

/** True when the error carries an "endpoint is gone" status (expired subscription). */
function isExpiredSubscription(err: unknown): boolean {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return code === 404 || code === 410;
}

/**
 * Wires push fan-out onto the event bus. `send` is injected (defaults to the real
 * web-push sender) so tests can supply a spy without hitting the network.
 *
 * Returns a handle whose `lastDispatch` promise tracks the in-flight send batch,
 * making the otherwise fire-and-forget listener awaitable in tests.
 */
export function initPush(
  db: Db,
  events: ChatEvents,
  isUserConnected: (userId: number) => boolean,
  send: typeof webpush.sendNotification = webpush.sendNotification,
): PushHandle {
  const publicKey = getVapidPublicKey();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = process.env.APP_ORIGIN?.trim() || 'mailto:admin@localhost';

  const handle: PushHandle = { vapidPublicKey: publicKey, lastDispatch: Promise.resolve() };

  if (!publicKey || !privateKey) {
    console.warn('[push] VAPID keys not configured — web push disabled');
    return handle;
  }

  // Passed per-call rather than via setVapidDetails so nothing depends on global
  // web-push state (and so an injected fake `send` can ignore it entirely).
  const vapidDetails = { subject, publicKey, privateKey };

  async function dispatch(message: MessageDTO, chat: ChatRow, memberIds: number[]): Promise<void> {
    // Notify every member who isn't the sender and has no live socket.
    const recipients = memberIds.filter(
      (id) => id !== message.sender.id && !isUserConnected(id),
    );
    if (recipients.length === 0) return;

    const subs = db
      .select()
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, recipients))
      .all();
    if (subs.length === 0) return;

    // allSettled + per-sub try/catch: one dead endpoint never blocks the others,
    // and the whole batch can never throw out of the event handler.
    await Promise.allSettled(
      subs.map(async (sub) => {
        const payload = buildPushPayload(message, chat, sub.userId);
        try {
          await send(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            { vapidDetails, TTL: 60 * 60 * 24 },
          );
        } catch (err) {
          if (isExpiredSubscription(err)) {
            // 404/410 mean the browser dropped the subscription: prune it.
            db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).run();
          } else {
            console.warn(
              `[push] send to ${sub.endpoint} failed:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }),
    );
  }

  events.on('message:new', ({ message, chat, memberIds }) => {
    handle.lastDispatch = dispatch(message, chat, memberIds);
  });

  return handle;
}
