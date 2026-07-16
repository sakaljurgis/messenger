import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  REACTION_EMOJIS,
  type AttachmentDTO,
  type ChatMemberDTO,
  type MessageActionDTO,
  type MessageDTO,
  type ReactionGroupDTO,
  type LinkPreviewDTO,
  type ReplyToDTO,
  type UserDTO,
} from '@messenger/shared';
import { apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MessageMarkdown } from '../lib/markdown';
import {
  accentColor,
  chatTitle,
  groupColors,
  firstUnreadMessageId,
  formatDaySeparator,
  formatMessageTime,
  markRead,
  otherMember,
  readPositions,
  sameCalendarDay,
  useChat,
  useChatTyping,
  useMessages,
  type OutboxItem,
} from '../lib/chats';
import { useOnlineUsers } from '../lib/presence';
import { attachmentUrl, formatBytes } from '../lib/attachments';
import Avatar from '../components/Avatar';
import Composer from '../components/Composer';
import GroupInfo from '../components/GroupInfo';
import Lightbox from '../components/Lightbox';
import VoiceNotePlayer from '../components/VoiceNotePlayer';

const NEAR_BOTTOM_PX = 100;

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
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

/** How long a touch must be held before the actions menu opens (mobile long-press). */
const LONG_PRESS_MS = 500;

/** Gap between a bubble and its actions popover (the mt-1/mb-1 spacing). */
const MENU_GAP_PX = 4;

/** A deleted message: a muted, italic outline bubble with no fill and no menu. */
function TombstoneBubble() {
  return (
    <div className="rounded-2xl border border-gray-200 px-3 py-2 text-sm italic text-gray-400 dark:border-gray-700 dark:text-gray-500">
      Message deleted
    </div>
  );
}

/**
 * Wraps a non-deleted bubble with a message-actions affordance: a '⋯' button
 * that fades in on hover (desktop) and a long-press / right-click on the bubble
 * itself (mobile) — both open a small popover. The popover always leads with the
 * emoji reaction picker (every member may react); `onCopy` (any message with
 * text — mobile's replacement for the OS long-press copy UI we suppress below),
 * `onReply` (every non-deleted message), and `onEdit`/`onDelete` (own messages
 * only), when provided, add Copy/Reply/Edit/Delete rows below it. Closes on an
 * outside tap/click or Escape.
 *
 * `isMine` picks the side everything hangs off: the '⋯' button sits toward the
 * screen center (after the bubble for received messages, before it for mine) so
 * it never pushes a bubble away from its screen edge, and the popover anchors
 * to that same edge (left-0 for received, right-0 for mine) so it always opens
 * inward — a short bubble near an edge can't push it off-screen.
 */
function MessageActions({
  isMine,
  onReact,
  onCopy,
  onReply,
  onEdit,
  onDelete,
  children,
}: {
  isMine: boolean;
  onReact: (emoji: string) => void;
  onCopy?: () => void;
  onReply?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Flipped true when the popover would clip the bottom of the visible message
  // area (bubbles low on screen) and there's room above the bubble instead.
  const [openUp, setOpenUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  // Measure after the popover renders but before paint: the popover lives
  // inside the chat's scroll container, so opening past its bottom edge doesn't
  // overlay the composer — it extends the scroll area and lands out of view.
  // The usable bottom is therefore the scroll container's edge, further capped
  // by the visual viewport (innerHeight lies when the mobile keyboard is up).
  useLayoutEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    const menu = menuRef.current;
    if (!wrap || !menu) return;
    const wrapRect = wrap.getBoundingClientRect();
    const menuHeight = menu.offsetHeight + MENU_GAP_PX;
    const scrollRect = wrap.closest('[data-testid="message-scroll"]')?.getBoundingClientRect();
    const viewportBottom = window.visualViewport?.height ?? window.innerHeight;
    const bottomLimit = scrollRect ? Math.min(scrollRect.bottom, viewportBottom) : viewportBottom;
    const topLimit = scrollRect ? Math.max(scrollRect.top, 0) : 0;
    const clipsBelow = wrapRect.bottom + menuHeight > bottomLimit;
    const fitsAbove = wrapRect.top - menuHeight >= topLimit;
    setOpenUp(clipsBelow && fitsAbove);
    return () => setOpenUp(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function cancelPress() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  const dotsButton = (
    <button
      type="button"
      aria-label="Message actions"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-gray-400 opacity-0 transition-opacity hover:bg-gray-100 focus:opacity-100 group-hover:opacity-100 dark:text-gray-500 dark:hover:bg-gray-700"
    >
      <DotsIcon />
    </button>
  );

  return (
    // max-w-full is load-bearing: this row sits in an items-start/items-end
    // column, so without it the row sizes to its content's min-content width
    // (a long unbroken word, a nowrap reply preview) and overflows the 75%
    // bubble column — the source of the thread's horizontal scrolling.
    <div ref={wrapRef} className="group relative flex max-w-full items-center gap-1">
      {isMine && dotsButton}
      <div
        // Suppress the OS long-press UI (text-selection handles / copy callout)
        // on touch devices so only our popover appears; pointer:coarse keeps
        // desktop mouse selection working.
        className="min-w-0 [-webkit-touch-callout:none] [@media(pointer:coarse)]:select-none"
        onTouchStart={() => {
          cancelPress();
          timerRef.current = window.setTimeout(() => setOpen(true), LONG_PRESS_MS);
        }}
        onTouchEnd={cancelPress}
        onTouchMove={cancelPress}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </div>
      {!isMine && dotsButton}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className={`absolute z-10 min-w-[8rem] overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800 ${
            isMine ? 'right-0' : 'left-0'
          } ${openUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
        >
          <div className="flex gap-0.5 px-1.5 py-1">
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                aria-label={`React ${emoji}`}
                onClick={() => {
                  setOpen(false);
                  onReact(emoji);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-full text-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {emoji}
              </button>
            ))}
          </div>
          {onCopy && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onCopy();
              }}
              className="block w-full px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Copy
            </button>
          )}
          {onReply && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onReply();
              }}
              className="block w-full px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Reply
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
              className="block w-full px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Edit
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="block w-full px-4 py-2 text-left text-sm text-red-600 transition-colors hover:bg-gray-100 dark:text-red-400 dark:hover:bg-gray-700"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The chips row shown directly under a bubble: one pill per emoji group (emoji +
 * count), visually distinct when my id is among the reactors. Tapping a chip
 * toggles my reaction. Renders nothing when the message has no reactions.
 */
function ReactionChips({
  reactions,
  meId,
  onToggle,
}: {
  reactions: ReactionGroupDTO[];
  meId: number;
  onToggle: (emoji: string) => void;
}) {
  if (reactions.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reactions.map((r) => {
        const mine = r.userIds.includes(meId);
        return (
          <button
            key={r.emoji}
            type="button"
            onClick={() => onToggle(r.emoji)}
            aria-pressed={mine}
            aria-label={`${r.emoji} ${r.userIds.length}${mine ? ', including you' : ''}`}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
              mine
                ? 'border-[#0084ff] bg-[#0084ff]/10 text-[#0084ff]'
                : 'border-gray-200 bg-gray-100 text-gray-600 hover:bg-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            }`}
          >
            <span aria-hidden="true">{r.emoji}</span>
            <span aria-hidden="true">{r.userIds.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Tailwind classes per action style: primary = the app blue, danger = red
 *  accent, default = neutral gray. Each has a dark variant. */
function actionButtonClasses(style: MessageActionDTO['style']): string {
  if (style === 'primary') {
    return 'bg-[#0084ff] text-white hover:bg-[#0079f2]';
  }
  if (style === 'danger') {
    return 'bg-red-500 text-white hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-500';
  }
  return 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600';
}

/**
 * The row of tappable action buttons under a bot message's bubble (bot messages
 * only — humans never carry `actions`; tombstones drop them server-side, so
 * this never renders on a deleted message). Each button POSTs the tap
 * fire-and-forget via `onTrigger`; a per-button busy flag disables it for the
 * duration so a double-tap can't double-fire, and clears on completion (success
 * OR failure — the bot's reply arriving over the socket is the real feedback).
 * Wraps to multiple lines when six buttons don't fit a narrow screen.
 */
function MessageActionButtons({
  actions,
  onTrigger,
}: {
  actions: MessageActionDTO[];
  onTrigger: (actionId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {actions.map((action) => {
        const isBusy = busy.has(action.id);
        return (
          <button
            key={action.id}
            type="button"
            disabled={isBusy}
            onClick={() => {
              if (busy.has(action.id)) return;
              setBusy((prev) => new Set(prev).add(action.id));
              void onTrigger(action.id).finally(() =>
                setBusy((prev) => {
                  const next = new Set(prev);
                  next.delete(action.id);
                  return next;
                }),
              );
            }}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60 ${actionButtonClasses(
              action.style,
            )}`}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The one-shot "gravestone": replaces a bot message's action buttons the moment
 * one is tapped (actions resolve exactly once, first tap wins server-side). A
 * subdued single line in the buttons' old spot, e.g. "✓ 👍 — Jurgis". The
 * tapped action's label is resolved from the message's own `actions` by id
 * (falling back to the raw id if that action has since vanished), and the
 * tapper's name from the chat members (falling back to 'Someone' if they've
 * left).
 */
function ActionRecord({
  actionTaken,
  actions,
  members,
}: {
  actionTaken: { actionId: string; userId: number };
  actions: MessageActionDTO[];
  members: UserDTO[];
}) {
  const label = actions.find((a) => a.id === actionTaken.actionId)?.label ?? actionTaken.actionId;
  const name = members.find((m) => m.id === actionTaken.userId)?.displayName ?? 'Someone';
  return (
    <div
      data-testid="action-record"
      className="mt-1 text-xs text-gray-400 dark:text-gray-500"
    >{`✓ ${label} — ${name}`}</div>
  );
}

/** Precomputed per-message layout: run grouping + day breaks. */
interface Row {
  message: MessageDTO;
  isMine: boolean;
  separatorLabel: string | null;
  showSender: boolean; // group + other + first of run
  showAvatar: boolean; // group + other + last of run
  showTime: boolean; // last of run
  isRunStart: boolean;
}

function buildRows(messages: MessageDTO[], meId: number, isGroup: boolean): Row[] {
  return messages.map((message, i): Row => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const newDay = !prev || !sameCalendarDay(prev.createdAt, message.createdAt);
    const runStart = newDay || !prev || prev.sender.id !== message.sender.id;
    const runEnd =
      !next || next.sender.id !== message.sender.id || !sameCalendarDay(next.createdAt, message.createdAt);
    const isMine = message.sender.id === meId;
    return {
      message,
      isMine,
      separatorLabel: newDay ? formatDaySeparator(message.createdAt) : null,
      showSender: isGroup && !isMine && runStart,
      showAvatar: isGroup && !isMine && runEnd,
      showTime: runEnd,
      isRunStart: runStart,
    };
  });
}

/** Render message text as chat-safe markdown (lib/markdown), which also styles
 *  any `@mention` of a chat member — mentions of ME get a subtle highlight in
 *  others' (gray) bubbles so being tagged stands out. */
function MessageContent({
  message,
  members,
  meId,
  isMine,
}: {
  message: MessageDTO;
  members: UserDTO[];
  meId: number;
  isMine: boolean;
}) {
  return (
    <MessageMarkdown
      content={message.content}
      mentions={message.mentions}
      members={members}
      meId={meId}
      isMine={isMine}
    />
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />
    </svg>
  );
}

/** Image attachments: one bare rounded image, or a 2-column grid of square tiles. */
function AttachmentImages({
  images,
  onOpen,
}: {
  images: AttachmentDTO[];
  onOpen: (a: AttachmentDTO) => void;
}) {
  if (images.length === 1) {
    const img = images[0]!;
    return (
      <button type="button" onClick={() => onOpen(img)} className="block overflow-hidden rounded-2xl">
        <img
          src={attachmentUrl(img.id, { thumb: img.hasThumb })}
          alt={img.originalName}
          width={img.width ?? undefined}
          height={img.height ?? undefined}
          loading="lazy"
          className="max-h-80 max-w-full object-cover"
        />
      </button>
    );
  }

  return (
    <div className="grid w-full grid-cols-2 gap-1">
      {images.map((img) => (
        <button
          key={img.id}
          type="button"
          onClick={() => onOpen(img)}
          className="block aspect-square overflow-hidden rounded-lg"
        >
          <img
            src={attachmentUrl(img.id, { thumb: img.hasThumb })}
            alt={img.originalName}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        </button>
      ))}
    </div>
  );
}

/**
 * A 'video' attachment (mp4/webm only — see AttachmentKind): an inline
 * `<video>` with native controls, capped at the same height as a bare single
 * image so it never dominates the thread. `playsInline` keeps iOS from
 * hijacking playback into fullscreen; `preload="metadata"` fetches just
 * enough (via the Range-enabled serving endpoint) to know duration/size
 * without downloading the whole file up front. Always its own block — never
 * placed inside the image grid.
 */
function AttachmentVideo({ video, isMine }: { video: AttachmentDTO; isMine: boolean }) {
  // Codec support varies (e.g. HEVC .mov from iPhones won't decode in every
  // browser) — when the element errors, degrade to the plain download card.
  const [failed, setFailed] = useState(false);
  if (failed) return <AttachmentFile file={video} isMine={isMine} />;
  return (
    <video
      controls
      playsInline
      preload="metadata"
      src={attachmentUrl(video.id)}
      onError={() => setFailed(true)}
      data-testid="video-attachment"
      className="max-h-80 max-w-full rounded-2xl bg-black"
    />
  );
}

/**
 * Non-image attachment: a download card styled like the message bubble. A PDF
 * is the one exception — the server serves it inline (Content-Disposition:
 * inline), so instead of forcing a download it opens in the browser's native
 * PDF viewer: no `?download=1`, no `download` attribute. Deliberately the SAME
 * browsing context (no `target="_blank"`): in the installed PWA a `_blank`
 * same-origin link opens a fresh context with no history, leaving the phone
 * user stranded on the PDF with no way back but killing the app. A same-tab
 * navigation keeps the history entry, so the system back gesture / browser
 * back returns to the chat. The subtitle swaps to "PDF · <size>" as a small
 * visual hint that it opens rather than saves. Every other file type keeps
 * the plain download behavior unchanged.
 */
function AttachmentFile({ file, isMine }: { file: AttachmentDTO; isMine: boolean }) {
  const bubble = isMine ? 'bg-[#0084ff] text-white' : 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100';
  const sub = isMine ? 'text-white/70' : 'text-gray-500 dark:text-gray-400';
  const isPdf = file.mimeType === 'application/pdf';
  const linkProps = isPdf
    ? { href: attachmentUrl(file.id) }
    : { href: attachmentUrl(file.id, { download: true }), download: file.originalName };
  return (
    <a {...linkProps} className={`flex max-w-[16rem] items-center gap-3 rounded-2xl px-3 py-2 ${bubble}`}>
      <FileIcon />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{file.originalName}</span>
        <span className={`text-xs ${sub}`}>
          {isPdf ? `PDF · ${formatBytes(file.sizeBytes)}` : formatBytes(file.sizeBytes)}
        </span>
      </span>
    </a>
  );
}

/**
 * The quoted-reply block shown above a bubble's content when the message replies
 * to another. Resolves the original sender's name from the chat members (falling
 * back to 'Unknown' if they've since left), and previews the snapshot: a deleted
 * original reads italic 'Message deleted'; an attachment-only original reads
 * '📎 Attachment'; otherwise the (server-truncated) text. Tapping it asks the
 * page to jump to the original (a no-op when that message isn't loaded).
 */
function ReplyQuote({
  replyTo,
  members,
  isMine,
  onJump,
}: {
  replyTo: ReplyToDTO;
  members: UserDTO[];
  isMine: boolean;
  onJump: () => void;
}) {
  const name = members.find((m) => m.id === replyTo.senderId)?.displayName ?? 'Unknown';
  let body: ReactNode;
  if (replyTo.isDeleted) body = <span className="italic">Message deleted</span>;
  else if (replyTo.content.length === 0 && replyTo.hasAttachments) body = '📎 Attachment';
  else body = replyTo.content;

  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={`Replying to ${name}`}
      className={`flex max-w-full flex-col overflow-hidden rounded-lg border-l-2 border-[#0084ff] bg-gray-100 px-2 py-1 text-left dark:bg-gray-700 ${
        isMine ? 'items-end self-end' : 'items-start self-start'
      }`}
    >
      <span className="max-w-full truncate text-xs font-semibold text-[#0084ff]">{name}</span>
      <span className="max-w-full truncate text-xs text-gray-600 dark:text-gray-300">{body}</span>
    </button>
  );
}

/** The stacked content of a bubble: an optional quoted-reply block, then the
 *  image block, file cards, and the text bubble (the text bubble is omitted for
 *  attachment-only messages, whose images render bare). */
function MessageStack({
  message,
  members,
  meId,
  isMine,
  onOpenImage,
  onJumpToMessage,
  onTriggerAction,
}: {
  message: MessageDTO;
  members: UserDTO[];
  meId: number;
  isMine: boolean;
  onOpenImage: (a: AttachmentDTO) => void;
  onJumpToMessage: (messageId: number) => void;
  onTriggerAction: (actionId: string) => Promise<void>;
}) {
  const images = message.attachments.filter((a) => a.kind === 'image');
  const videos = message.attachments.filter((a) => a.kind === 'video');
  const audios = message.attachments.filter((a) => a.kind === 'audio');
  const files = message.attachments.filter((a) => a.kind === 'file');
  const hasText = message.content.length > 0;
  const bubble = isMine ? 'bg-[#0084ff] text-white' : 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100';

  return (
    <div className={`flex w-full flex-col gap-1 ${isMine ? 'items-end' : 'items-start'}`}>
      {message.replyTo && (
        <ReplyQuote
          replyTo={message.replyTo}
          members={members}
          isMine={isMine}
          onJump={() => onJumpToMessage(message.replyTo!.id)}
        />
      )}
      {images.length > 0 && <AttachmentImages images={images} onOpen={onOpenImage} />}
      {videos.map((v) => (
        <AttachmentVideo key={v.id} video={v} isMine={isMine} />
      ))}
      {audios.map((a) => (
        <VoiceNotePlayer key={a.id} audio={a} />
      ))}
      {files.map((f) => (
        <AttachmentFile key={f.id} file={f} isMine={isMine} />
      ))}
      {hasText && (
        // No whitespace-pre-wrap: the markdown renderer owns line breaks (remark-breaks).
        // overflow-wrap:anywhere (not break-words) because only `anywhere`
        // shrinks the min-content width — long URLs/words must wrap instead of
        // widening the bubble past its column; max-w-full caps it in the
        // items-start/items-end column, which never stretches children.
        <div className={`max-w-full rounded-2xl px-3 py-2 [overflow-wrap:anywhere] ${bubble}`}>
          <MessageContent message={message} members={members} meId={meId} isMine={isMine} />
        </div>
      )}
      {message.linkPreview && <LinkPreviewCard preview={message.linkPreview} />}
      {message.actionTaken ? (
        // One-shot: once tapped, the buttons are permanently replaced by a
        // record line for every member (delivered live via message:updated).
        <ActionRecord
          actionTaken={message.actionTaken}
          actions={message.actions ?? []}
          members={members}
        />
      ) : (
        message.actions &&
        message.actions.length > 0 && (
          <MessageActionButtons actions={message.actions} onTrigger={onTriggerAction} />
        )
      )}
    </div>
  );
}

/**
 * Compact Open Graph card under a bubble whose message resolved a link preview
 * (delivered async via message:updated). The og:image is hotlinked — the
 * server never proxies it — so it loads lazily and quietly hides itself if the
 * remote image fails. Tapping opens the ORIGINAL typed URL.
 */
function LinkPreviewCard({ preview }: { preview: LinkPreviewDTO }) {
  let host = '';
  try {
    host = new URL(preview.url).hostname.replace(/^www\./, '');
  } catch {
    /* keep '' — the card just omits the host line */
  }
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-64 max-w-full overflow-hidden rounded-xl border border-gray-200 bg-white transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
    >
      {preview.imageUrl && (
        <img
          src={preview.imageUrl}
          alt=""
          loading="lazy"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
          className="max-h-32 w-full object-cover"
        />
      )}
      <span className="flex flex-col gap-0.5 px-3 py-2">
        <span className="line-clamp-2 text-sm font-medium text-gray-900 dark:text-gray-100">
          {preview.title}
        </span>
        {preview.description && (
          <span className="line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
            {preview.description}
          </span>
        )}
        {(preview.siteName ?? host) && (
          <span className="truncate text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
            {preview.siteName ?? host}
          </span>
        )}
      </span>
    </a>
  );
}

/** The `14:32 (edited)` line under the last bubble of a run. */
function TimeLabel({ message, indent }: { message: MessageDTO; indent: boolean }) {
  return (
    <span className={`mt-0.5 text-[10px] text-gray-400 dark:text-gray-500 ${indent ? 'ml-1' : ''}`}>
      {formatMessageTime(message.createdAt)}
      {message.editedAt && <span className="ml-1">(edited)</span>}
    </span>
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

function MessageRow({
  row,
  members,
  meId,
  isGroup,
  onOpenImage,
  onEdit,
  onDelete,
  onReact,
  onCopy,
  onReply,
  onJumpToMessage,
  onTriggerAction,
}: {
  row: Row;
  members: UserDTO[];
  meId: number;
  isGroup: boolean;
  onOpenImage: (a: AttachmentDTO) => void;
  onEdit: (message: MessageDTO) => void;
  onDelete: (message: MessageDTO) => void;
  onReact: (message: MessageDTO, emoji: string) => void;
  onCopy: (message: MessageDTO) => void;
  onReply: (message: MessageDTO) => void;
  onJumpToMessage: (messageId: number) => void;
  onTriggerAction: (messageId: number, actionId: string) => Promise<void>;
}) {
  const { message, isMine, showSender, showAvatar, showTime, isRunStart } = row;
  const spacing = isRunStart ? 'mt-3' : 'mt-0.5';
  // Tapping the sender avatar reveals the name on this row (mobile has no hover).
  const [nameRevealed, setNameRevealed] = useState(false);
  // Copy is only meaningful when there's text to copy — not for attachment-only
  // or (already excluded above) deleted messages.
  const copyHandler = message.content.length > 0 ? () => onCopy(message) : undefined;

  if (isMine) {
    return (
      <div className={`flex justify-end px-3 ${spacing}`}>
        <div className="flex min-w-0 max-w-[75%] flex-col items-end">
          {message.isDeleted ? (
            <TombstoneBubble />
          ) : (
            <MessageActions
              isMine
              onReact={(emoji) => onReact(message, emoji)}
              onCopy={copyHandler}
              onReply={() => onReply(message)}
              onEdit={() => onEdit(message)}
              onDelete={() => onDelete(message)}
            >
              <MessageStack
                message={message}
                members={members}
                meId={meId}
                isMine
                onOpenImage={onOpenImage}
                onJumpToMessage={onJumpToMessage}
                onTriggerAction={(actionId) => onTriggerAction(message.id, actionId)}
              />
            </MessageActions>
          )}
          {!message.isDeleted && (
            <ReactionChips
              reactions={message.reactions}
              meId={meId}
              onToggle={(emoji) => onReact(message, emoji)}
            />
          )}
          {showTime && <TimeLabel message={message} indent={false} />}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex justify-start px-3 ${spacing}`}>
      <div className="flex min-w-0 max-w-[75%] items-end gap-2">
        {isGroup && (
          <div className="w-8 flex-shrink-0">
            {showAvatar && (
              <button
                type="button"
                title={message.sender.displayName}
                aria-label={`Sent by ${message.sender.displayName}`}
                onClick={() => setNameRevealed((v) => !v)}
                className="block rounded-full"
              >
                <Avatar
                  name={message.sender.displayName}
                  id={message.sender.id}
                  size="sm"
                  color={message.sender.color}
                />
              </button>
            )}
          </div>
        )}
        <div className="flex min-w-0 flex-col items-start">
          {(showSender || nameRevealed) && (
            <span
              className="mb-0.5 ml-1 max-w-full truncate text-xs font-medium"
              style={{ color: accentColor(message.sender) }}
            >
              {message.sender.displayName}
            </span>
          )}
          {message.isDeleted ? (
            <TombstoneBubble />
          ) : (
            <MessageActions
              isMine={false}
              onReact={(emoji) => onReact(message, emoji)}
              onCopy={copyHandler}
              onReply={() => onReply(message)}
            >
              <MessageStack
                message={message}
                members={members}
                meId={meId}
                isMine={false}
                onOpenImage={onOpenImage}
                onJumpToMessage={onJumpToMessage}
                onTriggerAction={(actionId) => onTriggerAction(message.id, actionId)}
              />
            </MessageActions>
          )}
          {!message.isDeleted && (
            <ReactionChips
              reactions={message.reactions}
              meId={meId}
              onToggle={(emoji) => onReact(message, emoji)}
            />
          )}
          {showTime && <TimeLabel message={message} indent />}
        </div>
      </div>
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
   * Jump to a message (e.g. a reply's quoted original). When it's already in the
   * loaded window, scroll + flash it directly. Otherwise fall back to focus mode
   * via the `?message=` param, which re-fetches a window centred on it (the
   * initial-scroll effect then centres + flashes it). Routing through the URL
   * makes the jump shareable and back-button friendly.
   */
  function jumpToMessage(messageId: number) {
    const el = document.getElementById(`message-${messageId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightId(messageId);
      window.setTimeout(() => setHighlightId((cur) => (cur === messageId ? null : cur)), 1200);
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('message', String(messageId));
        return next;
      },
      { replace: false },
    );
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
                  onEdit={startEdit}
                  onDelete={handleDelete}
                  onReact={handleReact}
                  onCopy={handleCopy}
                  onReply={startReply}
                  onJumpToMessage={jumpToMessage}
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
      {showInfo && isGroup && chat && (
        <GroupInfo chat={chat} meId={meId} onClose={() => setShowInfo(false)} />
      )}
    </div>
  );
}
