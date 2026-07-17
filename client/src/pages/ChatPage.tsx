import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  type AttachmentDTO,
  type ChatMemberDTO,
  type MessageDTO,
  type UserDTO,
} from '@messenger/shared';
import { apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MessageMarkdown } from '../lib/markdown';
import {
  chatTitle,
  groupColors,
  firstUnreadMessageId,
  markRead,
  otherMember,
  readPositions,
  useChat,
  useChatTyping,
  useMessages,
  type OutboxItem,
} from '../lib/chats';
import { useOnlineUsers } from '../lib/presence';
import Avatar from '../components/Avatar';
import Composer from '../components/Composer';
import GroupInfo from '../components/GroupInfo';
import Lightbox from '../components/Lightbox';
import MessageRow, { buildRows } from '../components/MessageRow';
import PdfViewer from '../components/PdfViewer';
import ThreadView from '../components/ThreadView';

const NEAR_BOTTOM_PX = 100;

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function DownArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m-6-6l6 6 6-6" />
    </svg>
  );
}

/**
 * Read-receipt row: mini overlapping avatars of every member whose read
 * position is anchored on this message, right-aligned under the row (in a DM
 * this is just the other member — Messenger-style "seen"). `title` exposes
 * the names for a hover tooltip.
 */
function ReadReceipts({ members }: { members: ChatMemberDTO[] }) {
  if (members.length === 0) return null;
  const names = members.map((m) => m.displayName).join(', ');
  return (
    <div className="flex justify-end px-3" title={names}>
      <div className="flex -space-x-1">
        {members.map((m) => (
          <Avatar key={m.id} name={m.displayName} id={m.id} size="xs" color={m.color} />
        ))}
      </div>
    </div>
  );
}

/**
 * Centered rule marking the boundary between already-read and unread
 * messages, rendered immediately before the first unread other-sender
 * message. Frozen once per chat open (see ChatPage) so it survives the
 * automatic mark-read call that fires the instant the chat opens — a
 * live-recomputed boundary would vanish before the user ever saw it. `id`
 * lets the initial-scroll effect target it directly.
 */
function UnreadDivider() {
  return (
    <div
      id="unread-divider"
      role="separator"
      aria-label="New messages"
      className="my-2 flex items-center gap-2 px-3"
    >
      <div className="h-px flex-1 bg-red-400" />
      <span className="text-xs font-semibold text-red-500">New messages</span>
      <div className="h-px flex-1 bg-red-400" />
    </div>
  );
}

/** "Ana is typing…", "Ana and Ben are typing…", "Ana, Ben and Cara are typing…". */
function typingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing…`;
}

/**
 * Messenger-style typing bubble: a small gray pill with three staggered bouncing
 * dots and a tiny label. Rendered below the last message, inside the scroll area,
 * so it never yanks the viewport around. Nothing shows when no one is typing.
 */
function TypingIndicator({ names, isGroup }: { names: string[]; isGroup: boolean }) {
  if (names.length === 0) return null;
  return (
    <div className="mt-2 flex justify-start px-3" aria-live="polite">
      <div className="flex items-end gap-2">
        {isGroup && <div className="w-8 flex-shrink-0" />}
        <div className="flex flex-col items-start gap-0.5">
          <div className="flex items-center gap-1 rounded-2xl bg-gray-200 px-3.5 py-3 dark:bg-gray-700">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-2 w-2 animate-bounce rounded-full bg-gray-400 dark:bg-gray-500"
                style={{ animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </div>
          <span className="ml-1 text-[10px] text-gray-400 dark:text-gray-500">{typingLabel(names)}</span>
        </div>
      </div>
    </div>
  );
}

/** The little clock glyph shown where a queued bubble's timestamp would go. */
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l2.5 1.5" />
    </svg>
  );
}

/**
 * An optimistic bubble for a text send held in the offline outbox (see
 * lib/chats). Styled like my own (blue, right-aligned) message but visually
 * pending: reduced opacity with a 'Sending…' clock label while queued, or — if a
 * flush hit an HTTP error — a red 'failed — tap to retry' affordance (tapping the
 * bubble re-queues it) plus a ✕ to discard. Rendered at the live edge only.
 */
function OutboxBubble({
  item,
  members,
  meId,
  onRetry,
  onDiscard,
}: {
  item: OutboxItem;
  members: UserDTO[];
  meId: number;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const failed = item.status === 'failed';
  const bubble = (
    // Same wrapping rules as a real bubble (see MessageStack): anywhere-wrap +
    // max-w-full so a long unbroken word can't widen the thread.
    <div
      className={`max-w-full rounded-2xl bg-[#0084ff] px-3 py-2 text-white [overflow-wrap:anywhere] ${
        failed ? '' : 'opacity-60'
      }`}
    >
      <MessageMarkdown content={item.content} mentions={item.mentions} members={members} meId={meId} isMine />
    </div>
  );

  return (
    <div className="mt-0.5 flex justify-end px-3">
      <div className="flex min-w-0 max-w-[75%] flex-col items-end">
        {failed ? (
          <button type="button" onClick={onRetry} aria-label="Retry sending message" className="block max-w-full text-left">
            {bubble}
          </button>
        ) : (
          bubble
        )}
        {failed ? (
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-red-500">
            <button
              type="button"
              onClick={onRetry}
              className="font-medium underline decoration-dotted underline-offset-2"
            >
              failed — tap to retry
            </button>
            <button
              type="button"
              onClick={onDiscard}
              aria-label="Discard message"
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-red-500 transition-colors hover:bg-red-100 dark:hover:bg-red-500/20"
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </span>
        ) : (
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500">
            <ClockIcon />
            <span>Sending…</span>
          </span>
        )}
      </div>
    </div>
  );
}

export default function ChatPage() {
  const params = useParams();
  const chatId = Number(params.id);
  const { user } = useAuth();
  const meId = user?.id ?? -1;

  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Focus mode: `?message=<id>` opens a window CENTRED on that message (search
  // jump / reply-jump-fallback / deep link) rather than the newest page. Kept
  // in the URL so the view is shareable and back-button friendly.
  const focusParam = Number(searchParams.get('message'));
  const focusId = Number.isFinite(focusParam) && focusParam > 0 ? focusParam : null;
  // Thread overlay: `?thread=<id>` shows the reply thread that message belongs
  // to. In the URL (like focus mode) so the Android back button closes the
  // overlay instead of leaving the chat.
  const threadParam = Number(searchParams.get('thread'));
  const threadAnchorId = Number.isFinite(threadParam) && threadParam > 0 ? threadParam : null;

  const { chat, removed } = useChat(chatId);
  const {
    messages,
    loadOlder,
    loadNewer,
    hasMore,
    atLiveEdge,
    newWhileWindowed,
    sendMessage,
    editMessage,
    deleteMessage,
    toggleReaction,
    outbox,
    retryOutbox,
    discardOutbox,
    loading,
  } = useMessages(chatId, { targetMessageId: focusId, meId });

  // I'm no longer a member (left the group, maybe in another tab) — bail out.
  useEffect(() => {
    if (removed) navigate('/chats');
  }, [removed, navigate]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null); // scroller's content, for growth re-pinning
  const stickToBottom = useRef(true); // is the viewport near the bottom?
  const didInitialScroll = useRef(false);
  // Identifies the current window (chat + focus target). When it changes the
  // initial-scroll effect re-runs (re-centres a new focus, or bottoms a fresh
  // newest-page open). Reset render-phase so it settles before layout effects.
  const scrollKeyRef = useRef<string>('');
  const lastMarkedId = useRef<number>(-1);
  const [lightbox, setLightbox] = useState<AttachmentDTO | null>(null);
  const [pdfPreview, setPdfPreview] = useState<AttachmentDTO | null>(null);
  const [editing, setEditing] = useState<MessageDTO | null>(null);
  const [replyingTo, setReplyingTo] = useState<MessageDTO | null>(null);
  // The message currently flashed by a reply "jump to original" tap.
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  // Unread divider: frozen once per chat (see the render-phase block below),
  // and never recomputed afterwards, so the automatic mark-read call (which
  // fires the instant the chat opens) can't make it vanish before it's seen.
  const frozenChatIdRef = useRef<number | null>(null);
  const [unreadBoundaryId, setUnreadBoundaryId] = useState<number | null>(null);

  // Jump-to-bottom pill. `atBottom` is real state (unlike `stickToBottom`,
  // which is a ref purely to avoid render-thrash on every scroll tick)
  // because it drives the pill's visibility. `newMessageCount` counts other
  // members' messages appended to the list while scrolled away from bottom.
  const [atBottom, setAtBottom] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const prevNewestIdRef = useRef<number | null>(null);

  // Auto-load older/newer: an IntersectionObserver sentinel near each edge of
  // the loaded window triggers the next page fetch just before the user
  // reaches it (rootMargin below). Falls back to the old manual buttons when
  // IntersectionObserver doesn't exist (ancient browsers) — checked once at
  // mount since the global never changes mid-session.
  const [hasIntersectionObserver] = useState(() => typeof IntersectionObserver !== 'undefined');
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null); // "load newer" edge, windowed mode only
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  // Synchronous guards (state lags a tick behind an in-flight fetch) so a burst
  // of intersection entries can never kick off a second overlapping load.
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);

  const isGroup = chat?.type === 'group';
  const title = chat ? chatTitle(chat, meId) : 'Chat';
  const members = chat?.members ?? [];
  const rows = buildRows(messages, meId, isGroup);

  // A change of chat or focus target re-arms the initial-scroll effect. Adjusted
  // render-phase (refs, no state) so it's settled before the layout effect runs.
  const scrollKey = `${chatId}:${focusId ?? 'live'}`;
  if (scrollKeyRef.current !== scrollKey) {
    scrollKeyRef.current = scrollKey;
    didInitialScroll.current = false;
  }

  // Freeze the unread boundary the moment this chat's first non-empty message
  // list is available. Adjusted during render (not an Effect) — same "adjust
  // state while rendering" idea as the resetRef pattern in useExpiringTyping
  // (lib/chats.ts) — so it's already settled by the time the initial-scroll
  // layout effect below runs. The `messages[0].chatId === chatId` guard skips
  // the transitional render where `chat`/`messages` still hold the PREVIOUS
  // chat's data (chatId flips a render before useChat/useMessages catch up),
  // so switching chats never freezes on the wrong chat's data. In focus mode we
  // freeze with NO boundary — a windowed open never shows an unread divider.
  if (
    frozenChatIdRef.current !== chatId &&
    chat &&
    messages.length > 0 &&
    messages[0]!.chatId === chatId
  ) {
    frozenChatIdRef.current = chatId;
    if (focusId != null) {
      if (unreadBoundaryId !== null) setUnreadBoundaryId(null);
    } else {
      const myLastRead = chat.members.find((m) => m.id === meId)?.lastReadMessageId ?? 0;
      const boundary = firstUnreadMessageId(messages, myLastRead, meId);
      if (boundary !== unreadBoundaryId) setUnreadBoundaryId(boundary);
    }
  }

  // Presence + typing. The header dot is DM-only (the other member); the typing
  // indicator names live typers (mapped to member display names).
  const onlineIds = useOnlineUsers();
  const dmOther = chat && !isGroup ? otherMember(chat, meId) : undefined;
  const otherOnline = dmOther ? onlineIds.has(dmOther.id) : false;
  // Header-avatar owner for a DM: the other member, or ME for notes-to-self
  // (no presence dot there — dmOther stays undefined so otherOnline is false).
  const dmPeer =
    chat && !isGroup ? (dmOther ?? chat.members.find((m) => m.id === meId)) : undefined;
  const typingIds = useChatTyping(chatId, meId);
  const typingNames = [...typingIds]
    .map((id) => members.find((m) => m.id === id)?.displayName)
    .filter((name): name is string => Boolean(name));
  // Anchor message id -> members whose read position lands there. Recomputed
  // from live state (messages + chat.members, which useChat patches in place
  // on `read:updated`), so receipts move on their own without extra plumbing.
  const receiptsByMessageId = useMemo(
    () => readPositions(messages, members, meId),
    [messages, members, meId],
  );

  // Every photo in the loaded window, in thread order — the lightbox gallery.
  // Deleted messages carry no attachments, so tombstones drop out naturally.
  const galleryImages = useMemo(
    () => messages.flatMap((m) => m.attachments.filter((a) => a.kind === 'image')),
    [messages],
  );

  /** True when the viewport currently sits within NEAR_BOTTOM_PX of the thread's end. */
  function measureNearBottom(): boolean {
    const el = scrollRef.current;
    return el ? el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX : true;
  }

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = measureNearBottom();
    stickToBottom.current = nearBottom;
    // Only ever setState on an actual flip — scrolling fires constantly, and
    // this is the one piece of scroll-position state that must re-render.
    if (nearBottom !== atBottom) {
      setAtBottom(nearBottom);
      if (nearBottom) setNewMessageCount(0);
    }
  }

  // Auto-scroll. On first load of a window: in focus mode centre + flash the
  // target message (waiting for it to land in the DOM); otherwise jump to the
  // frozen unread divider, or the bottom if there isn't one. Afterwards only
  // follow new messages when the user is already near the bottom.
  useLayoutEffect(() => {
    if (messages.length === 0) return;
    // Skip the transitional render where the list still holds the previous
    // chat's data (chatId flips a render before useMessages catches up).
    if (messages[0]!.chatId !== chatId) return;
    if (!didInitialScroll.current) {
      if (focusId != null) {
        const el = document.getElementById(`message-${focusId}`);
        if (!el) return; // the around-window hasn't loaded yet — wait for it
        didInitialScroll.current = true;
        el.scrollIntoView({ block: 'center' });
        setHighlightId(focusId);
        window.setTimeout(() => setHighlightId((cur) => (cur === focusId ? null : cur)), 1200);
        stickToBottom.current = false;
      } else {
        didInitialScroll.current = true;
        if (unreadBoundaryId !== null) {
          document.getElementById('unread-divider')?.scrollIntoView({ block: 'center' });
          // The divider may sit pages up — only keep following the bottom when
          // the jump actually landed near it, else growth/new messages would
          // yank the user away from the unread boundary they're reading.
          stickToBottom.current = measureNearBottom();
        } else {
          bottomRef.current?.scrollIntoView({ block: 'end' });
          stickToBottom.current = true;
        }
      }
    } else if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages, unreadBoundaryId, chatId, focusId]);

  // Keep a freshly queued (outbox) send in view when we're pinned to the bottom.
  // A queued send changes `outbox`, not `messages`, so the message-driven scroll
  // effect above won't fire for it.
  useEffect(() => {
    if (atLiveEdge && stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [outbox.length, atLiveEdge]);

  // Late-loading content (images without reserved height, video/audio players,
  // link-preview cards) grows the thread AFTER the initial scroll ran, leaving
  // the viewport stranded slightly above the true bottom. While pinned to the
  // bottom, re-pin whenever the content's size changes; scrolled-up reading is
  // untouched (stickToBottom is false then). jsdom has no ResizeObserver — the
  // effect no-ops in tests that don't stub one.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (!didInitialScroll.current || !stickToBottom.current) return;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [chatId]);

  // Auto-load older: observe the top sentinel only while there IS an older
  // page (hasMore) — this is what stops the loop that would otherwise fire
  // forever once there's nothing left to fetch, and it's also why a short
  // thread with no more history never mounts (or observes) the sentinel at
  // all. rootMargin extends the scroller's top edge by 200px so the fetch
  // starts just before the user physically reaches it. Re-runs (disconnect +
  // re-observe) whenever `hasMore` flips, which covers both "ran out of
  // history" and "switched chats". jsdom has no IntersectionObserver — the
  // effect no-ops there, same pattern as the ResizeObserver effect above.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    if (!hasMore) return;
    const el = topSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void handleLoadOlder();
      },
      { root: scrollRef.current, rootMargin: '200px 0px 0px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore]);

  // Auto-load newer: the mirror of the above for the bottom edge, only
  // meaningful in windowed (focus) mode — observed only while `!atLiveEdge`.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    if (atLiveEdge) return;
    const el = bottomSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void handleLoadNewer();
      },
      { root: scrollRef.current, rootMargin: '0px 0px 200px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [atLiveEdge]);

  // Reset the jump-to-bottom pill's per-chat counters when the chat or focus
  // target changes. The unread-boundary freeze above self-heals via the
  // chatId/messages guard, but the append counter has no equivalent reset.
  useEffect(() => {
    prevNewestIdRef.current = null;
    setAtBottom(true);
    setNewMessageCount(0);
  }, [chatId, focusId]);

  // Count other members' messages appended to the list while scrolled away
  // from the bottom, for the jump-to-bottom pill's "N new" badge. A prepend
  // (loadOlder) or an in-place edit/delete never raises the newest id, so
  // only a genuine append is counted; my own messages never count. Only runs at
  // the live edge — while windowed, `newWhileWindowed` (from useMessages) drives
  // the pill instead, and a `loadNewer` append must not be miscounted as "new".
  useEffect(() => {
    const newest = messages[messages.length - 1];
    if (!newest) return;
    if (!atLiveEdge) {
      // Keep the ref current so the live-edge transition doesn't count a batch.
      prevNewestIdRef.current = newest.id;
      return;
    }
    const prevNewestId = prevNewestIdRef.current;
    prevNewestIdRef.current = newest.id;
    if (prevNewestId === null || newest.id <= prevNewestId || atBottom) return;
    const appended = messages.filter((m) => m.id > prevNewestId && m.sender.id !== meId).length;
    if (appended > 0) setNewMessageCount((c) => c + appended);
  }, [messages, atBottom, meId, atLiveEdge]);

  // Mark read up to the newest message whenever the list changes — but ONLY at
  // the live edge. Marking read from the middle of a windowed view is wrong when
  // newer unread messages exist beyond the window. Best-effort/fire-and-forget.
  useEffect(() => {
    if (!atLiveEdge) return;
    const newest = messages[messages.length - 1];
    if (!newest || newest.id === lastMarkedId.current) return;
    lastMarkedId.current = newest.id;
    markRead(chatId, newest.id).catch(() => {
      /* best-effort — the read marker is re-sent on the next message anyway */
    });
  }, [chatId, messages, atLiveEdge]);

  async function handleLoadOlder() {
    if (loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      await loadOlder();
      // Keep the viewport anchored on the same message after prepending.
      requestAnimationFrame(() => {
        const el2 = scrollRef.current;
        if (el2) el2.scrollTop = el2.scrollHeight - prevHeight;
      });
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }

  async function handleLoadNewer() {
    if (loadingNewerRef.current) return;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    try {
      await loadNewer();
    } finally {
      loadingNewerRef.current = false;
      setLoadingNewer(false);
    }
  }

  /** Drop the `?message=` focus param, returning to (and re-fetching) the live
   *  newest window. `replace` so the reset doesn't add a history entry. */
  function resetToLiveEdge() {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('message');
        return next;
      },
      { replace: true },
    );
  }

  /**
   * Jump-to-bottom pill. In a windowed view it resets to the live newest window
   * (a refetch — the older window's newest is NOT the present); at the live edge
   * it just smooth-scrolls to the sentinel and clears the count.
   */
  function handleJumpToBottom() {
    if (!atLiveEdge) {
      resetToLiveEdge();
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    stickToBottom.current = true;
    setAtBottom(true);
    setNewMessageCount(0);
  }

  async function handleSend(
    content: string,
    mentions: number[],
    attachmentIds: number[],
    replyToId?: number,
  ) {
    stickToBottom.current = true;
    await sendMessage(content, mentions, attachmentIds, replyToId);
    // Only clears once the send resolves — a failed send keeps the reply banner
    // up (the composer restores the text) so the user can retry.
    setReplyingTo(null);
  }

  function handleDelete(message: MessageDTO) {
    if (window.confirm('Delete this message?')) {
      if (editing?.id === message.id) setEditing(null);
      if (replyingTo?.id === message.id) setReplyingTo(null);
      void deleteMessage(message.id);
    }
  }

  // Reply and edit modes are mutually exclusive — entering one clears the other.
  function startReply(message: MessageDTO) {
    setEditing(null);
    setReplyingTo(message);
  }

  function startEdit(message: MessageDTO) {
    setReplyingTo(null);
    setEditing(message);
  }

  /**
   * Open the thread overlay anchored on a message (the quote chip's target —
   * any member of the chain yields the same thread). Pushed (not replaced) so
   * the back button closes the overlay, like focus mode.
   */
  function openThread(messageId: number) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('thread', String(messageId));
        return next;
      },
      { replace: false },
    );
  }

  /** Close the thread overlay (the ✕ / Escape). `replace` so the dead
   *  `?thread=` entry doesn't linger for the back button to reopen. */
  function closeThread() {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('thread');
        return next;
      },
      { replace: true },
    );
  }

  /**
   * "Show in chat" from the thread overlay: close the thread and reveal the
   * message in the main conversation — scroll + flash when it's in the loaded
   * window, else focus mode (`?message=`) re-fetches a window centred on it
   * (the initial-scroll effect then centres + flashes it). Both params change
   * in ONE setSearchParams call — two calls in the same tick would each read
   * the stale pre-navigation params and the last write would win.
   */
  function handleShowInChat(messageId: number) {
    const el = document.getElementById(`message-${messageId}`);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('thread');
        if (!el) next.set('message', String(messageId));
        return next;
      },
      { replace: true },
    );
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightId(messageId);
      window.setTimeout(() => setHighlightId((cur) => (cur === messageId ? null : cur)), 1200);
    }
  }

  function handleReact(message: MessageDTO, emoji: string) {
    // Fire-and-forget: the returned DTO (and the socket echo) patch state in place.
    void toggleReaction(message.id, emoji).catch(() => {
      /* transient failure — the chips just stay as they were */
    });
  }

  function handleCopy(message: MessageDTO) {
    // Fire-and-forget: a denied clipboard permission shouldn't throw into the UI.
    void navigator.clipboard.writeText(message.content).catch(() => {});
  }

  /**
   * Tap a bot message's action button: POST { actionId } (204). Fire-and-forget
   * — actions are one-shot, so the real feedback is the `message:updated` that
   * flips the buttons to a record line for everyone. A 409 ('Action already
   * taken', someone tapped first) is swallowed just like any transient error:
   * no UI error surfaces, and the incoming message:updated renders the record
   * naturally. Returns the promise so the button tracks its own in-flight/busy
   * state (which clears on completion, success OR failure).
   */
  function handleTriggerAction(messageId: number, actionId: string): Promise<void> {
    return apiPost<void>(`/api/chats/${chatId}/messages/${messageId}/actions`, { actionId }).catch(
      () => {
        /* one-shot 409 or transient failure — the record arrives via message:updated */
      },
    );
  }

  async function handleEditSubmit(messageId: number, content: string, mentions: number[]) {
    await editMessage(messageId, content, mentions);
    setEditing(null);
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col bg-white dark:bg-gray-900">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 px-2 py-2 dark:border-gray-700">
        <Link
          to="/chats"
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-full text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <BackIcon />
        </Link>
        {chat && (
          <Avatar
            name={title}
            id={isGroup ? chat.id : (dmPeer?.id ?? chat.id)}
            online={otherOnline}
            color={isGroup ? undefined : dmPeer?.color}
            colors={isGroup ? groupColors(chat.members) : undefined}
          />
        )}
        {isGroup ? (
          <button
            type="button"
            onClick={() => setShowInfo(true)}
            aria-label="Group info"
            className="min-w-0 flex-1 rounded-lg px-1 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <h1 className="truncate font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
            {chat && <p className="truncate text-xs text-gray-500 dark:text-gray-400">{chat.members.length} members</p>}
          </button>
        ) : (
          <div className="min-w-0">
            <h1 className="truncate font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
          </div>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-testid="message-scroll"
          data-message-scroll=""
          // overflow-x-hidden: an overflow-y scroller's x-axis computes to
          // auto, so any stray too-wide bubble would make the whole thread
          // horizontally scrollable — clip it instead.
          className="h-full overflow-x-hidden overflow-y-auto py-2"
        >
          {/* Wrapper so the growth-repin ResizeObserver can watch the content's
              height (observing the scroller itself only reports its fixed box). */}
          <div ref={contentRef}>
          {hasMore &&
            (hasIntersectionObserver ? (
              <>
                <div ref={topSentinelRef} data-testid="top-sentinel" aria-hidden="true" className="h-px" />
                {loadingOlder && (
                  <div className="flex justify-center py-2" role="status" aria-label="Loading older messages">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-200 border-t-[#0084ff] dark:border-gray-700 dark:border-t-[#0084ff]" />
                  </div>
                )}
              </>
            ) : (
              <div className="flex justify-center py-2">
                <button
                  type="button"
                  onClick={() => void handleLoadOlder()}
                  className="rounded-full bg-gray-100 px-4 py-1 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  Load older
                </button>
              </div>
            ))}

          {loading && messages.length === 0 ? (
            <div className="flex justify-center py-10" role="status" aria-label="Loading messages">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-[#0084ff] dark:border-gray-700 dark:border-t-[#0084ff]" />
            </div>
          ) : messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-400 dark:text-gray-500">No messages yet. Say hi!</p>
          ) : (
            rows.map((row) => (
              <div
                key={row.message.id}
                id={`message-${row.message.id}`}
                className={`rounded-lg transition-colors duration-500 ${
                  highlightId === row.message.id ? 'bg-[#0084ff]/10' : ''
                }`}
              >
                {row.separatorLabel && (
                  <div className="flex justify-center py-3">
                    <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                      {row.separatorLabel}
                    </span>
                  </div>
                )}
                {focusId == null && unreadBoundaryId === row.message.id && <UnreadDivider />}
                <MessageRow
                  row={row}
                  members={members}
                  meId={meId}
                  isGroup={isGroup}
                  onOpenImage={setLightbox}
                  onOpenPdf={setPdfPreview}
                  onEdit={startEdit}
                  onDelete={handleDelete}
                  onReact={handleReact}
                  onCopy={handleCopy}
                  onReply={startReply}
                  onOpenThread={openThread}
                  onTriggerAction={handleTriggerAction}
                />
                <ReadReceipts members={receiptsByMessageId.get(row.message.id) ?? []} />
              </div>
            ))
          )}

          {/* Mirror of "Load older" for the newer side — only present in a
              windowed (focus-mode) view that hasn't reached the present yet. */}
          {!atLiveEdge &&
            messages.length > 0 &&
            (hasIntersectionObserver ? (
              <>
                {loadingNewer && (
                  <div className="flex justify-center py-2" role="status" aria-label="Loading newer messages">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-200 border-t-[#0084ff] dark:border-gray-700 dark:border-t-[#0084ff]" />
                  </div>
                )}
                <div ref={bottomSentinelRef} data-testid="bottom-sentinel" aria-hidden="true" className="h-px" />
              </>
            ) : (
              <div className="flex justify-center py-2">
                <button
                  type="button"
                  onClick={() => void handleLoadNewer()}
                  className="rounded-full bg-gray-100 px-4 py-1 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  Load newer
                </button>
              </div>
            ))}

          {/* Optimistic bubbles for text sends queued while offline. Live edge
              only — a windowed view suppresses them (like live message:new). */}
          {atLiveEdge &&
            outbox.map((item) => (
              <OutboxBubble
                key={item.tempKey}
                item={item}
                members={members}
                meId={meId}
                onRetry={() => retryOutbox(item.tempKey)}
                onDiscard={() => discardOutbox(item.tempKey)}
              />
            ))}

          <TypingIndicator names={typingNames} isGroup={isGroup} />
          <div ref={bottomRef} />
          </div>
        </div>

        {(!atBottom || !atLiveEdge) && (
          <button
            type="button"
            onClick={handleJumpToBottom}
            aria-label="Jump to latest messages"
            className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-lg ring-1 ring-gray-200 transition-colors hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-700 dark:hover:bg-gray-700"
          >
            <DownArrowIcon />
            {(atLiveEdge ? newMessageCount : newWhileWindowed) > 0 && (
              <span>{atLiveEdge ? newMessageCount : newWhileWindowed} new</span>
            )}
          </button>
        )}
      </div>

      <Composer
        onSend={handleSend}
        members={members}
        meId={meId}
        chatId={chatId}
        editing={editing}
        onEditSubmit={handleEditSubmit}
        onCancelEdit={() => setEditing(null)}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
      />

      {lightbox && (
        <Lightbox
          attachment={lightbox}
          images={galleryImages}
          onNavigate={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}
      {pdfPreview && <PdfViewer attachment={pdfPreview} onClose={() => setPdfPreview(null)} />}
      {showInfo && isGroup && chat && (
        <GroupInfo chat={chat} meId={meId} onClose={() => setShowInfo(false)} />
      )}
      {threadAnchorId != null && chat && (
        <ThreadView
          chatId={chatId}
          anchorId={threadAnchorId}
          members={members}
          meId={meId}
          isGroup={isGroup}
          onClose={closeThread}
          onShowInChat={handleShowInChat}
          sendMessage={sendMessage}
          editMessage={editMessage}
          deleteMessage={deleteMessage}
          toggleReaction={toggleReaction}
          onTriggerAction={handleTriggerAction}
        />
      )}
    </div>
  );
}
