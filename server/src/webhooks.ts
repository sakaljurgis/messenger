import { inArray } from 'drizzle-orm';
import type { MessageDTO, UserDTO } from '@messenger/shared';
import type { Db } from './db/index.js';
import { users, type ChatRow } from './db/schema.js';
import type { ChatEvents } from './events.js';

/**
 * Webhook fan-out for bots. Subscribes to the shared event bus and, for every
 * chat member who is a bot with a `webhookUrl` (other than the sender — never
 * echo a bot's own message back to it), POSTs the new message to that URL.
 * This is the bot counterpart of push.ts: push notifies offline humans,
 * webhooks notify bots, both off the same `message:new` event.
 *
 * The same subscriber also delivers action callbacks: when a member taps a bot
 * message's action button (`action:triggered`), it POSTs an `{ type: 'action',
 * … }` payload to the bot that sent the buttons — same URL, headers, timeout
 * and retry as a message webhook.
 *
 * Delivery is best-effort: a 5s timeout, one retry after ~1s on network error
 * or a non-2xx response, then a `console.warn` and give-up. Never throws —
 * one dead bot must never take down message sending for everyone else.
 */

/** JSON body POSTed to a bot's webhookUrl for a new message in one of its chats. */
export interface WebhookPayload {
  message: MessageDTO;
  chat: { id: number; type: ChatRow['type']; name: string | null };
}

/**
 * JSON body POSTed to a bot's webhookUrl when a member taps one of its action
 * buttons. `type: 'action'` distinguishes it from the (untagged) message
 * payload above; `message` is the DTO of the message carrying the button,
 * `user` the tapper, `action.id` the tapped button's id.
 */
export interface ActionWebhookPayload {
  type: 'action';
  action: { id: string };
  message: MessageDTO;
  user: UserDTO;
  chatId: number;
}

export interface WebhookHandle {
  /**
   * Resolves when the most recent `message:new` fan-out (incl. retries) has
   * finished. Reassigned on every event — tests `await handle.lastDispatch`
   * after POSTing a message to deterministically assert on which webhooks fired.
   */
  lastDispatch: Promise<void>;
}

const TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A bot row with the two fields guaranteed present for a deliverable webhook. */
interface DeliverableBot {
  webhookUrl: string;
  apiToken: string;
}

/**
 * Delivers one JSON `body` to one bot: try, and on network error or non-2xx
 * retry once after `retryDelayMs`; if that also fails, warn and give up.
 * Swallows every error itself so callers can fire-and-forget via
 * `Promise.allSettled`. Shared verbatim by message and action delivery, so
 * both carry identical headers/timeout/retry semantics.
 */
async function deliver(
  fetchFn: typeof fetch,
  bot: DeliverableBot,
  body: WebhookPayload | ActionWebhookPayload,
  retryDelayMs: number,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchFn(bot.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bot-Token': bot.apiToken },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return;
    } catch {
      // Network error/timeout — fall through to retry (or give up below).
    }
    if (attempt === 1) await sleep(retryDelayMs);
  }
  console.warn(`[webhooks] giving up on ${bot.webhookUrl} after 2 attempts`);
}

/**
 * Wires webhook fan-out onto the event bus. `fetchFn` is injected (defaults to
 * the global `fetch`) so tests can supply a spy without hitting the network;
 * `retryDelayMs` is injected too, purely so tests don't have to eat a real
 * ~1s sleep on the failure-retry path.
 */
export function initWebhooks(
  db: Db,
  events: ChatEvents,
  fetchFn: typeof fetch = fetch,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
): WebhookHandle {
  const handle: WebhookHandle = { lastDispatch: Promise.resolve() };

  async function dispatch(message: MessageDTO, chat: ChatRow, memberIds: number[]): Promise<void> {
    const recipientIds = memberIds.filter((id) => id !== message.sender.id);
    if (recipientIds.length === 0) return;

    const bots = db
      .select()
      .from(users)
      .where(inArray(users.id, recipientIds))
      .all()
      .filter(
        (u): u is typeof u & DeliverableBot =>
          u.isBot && !!u.webhookUrl && !!u.apiToken,
      );
    if (bots.length === 0) return;

    const payload: WebhookPayload = {
      message,
      chat: { id: chat.id, type: chat.type, name: chat.name },
    };

    await Promise.allSettled(
      bots.map((bot) => deliver(fetchFn, bot, payload, retryDelayMs)),
    );
  }

  // An action tap: POST the callback to the one bot that sent the buttons. The
  // route already guaranteed `bot` is a live bot with a webhookUrl; the
  // apiToken guard mirrors the message path (a token-less bot can't be proven
  // to the receiver, so it's skipped).
  async function dispatchAction(
    bot: typeof users.$inferSelect,
    payload: ActionWebhookPayload,
  ): Promise<void> {
    if (!bot.webhookUrl || !bot.apiToken) return;
    await deliver(fetchFn, { webhookUrl: bot.webhookUrl, apiToken: bot.apiToken }, payload, retryDelayMs);
  }

  events.on('message:new', ({ message, chat, memberIds }) => {
    handle.lastDispatch = dispatch(message, chat, memberIds);
  });

  events.on('action:triggered', ({ bot, actionId, message, user, chat }) => {
    handle.lastDispatch = dispatchAction(bot, {
      type: 'action',
      action: { id: actionId },
      message,
      user,
      chatId: chat.id,
    });
  });

  return handle;
}
