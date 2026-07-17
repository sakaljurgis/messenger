// The message-rendering core shared by the main chat list (ChatPage) and the
// thread overlay (ThreadView): per-message layout precomputation (buildRows)
// and the single-row renderer (MessageRow) with its bubble stack, actions
// popover, reactions, attachments, and quoted-reply chip. All behavior is
// injected via callbacks — no page state is captured here, which is what lets
// the thread overlay render the exact same rows with a different handler set
// (no Reply, a "Show in chat" item, no quote chips).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  REACTION_EMOJIS,
  type AttachmentDTO,
  type MessageActionDTO,
  type MessageDTO,
  type ReactionGroupDTO,
  type LinkPreviewDTO,
  type ReplyToDTO,
  type UserDTO,
} from '@messenger/shared';
import { MessageMarkdown } from '../lib/markdown';
import { accentColor, formatDaySeparator, formatMessageTime, sameCalendarDay } from '../lib/chats';
import { attachmentUrl, formatBytes } from '../lib/attachments';
import Avatar from './Avatar';
import VoiceNotePlayer from './VoiceNotePlayer';

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
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
 * `onReply` (every non-deleted message), `onShowInChat` (thread overlay only —
 * locate this message in the main conversation), and `onEdit`/`onDelete` (own
 * messages only), when provided, add Copy/Reply/Show in chat/Edit/Delete rows
 * below it. Closes on an outside tap/click or Escape.
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
  onShowInChat,
  onEdit,
  onDelete,
  children,
}: {
  isMine: boolean;
  onReact: (emoji: string) => void;
  onCopy?: () => void;
  onReply?: () => void;
  onShowInChat?: () => void;
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
    // Matches the main chat scroller AND the thread overlay's (both carry the
    // data-message-scroll marker; they have distinct testids).
    const scrollRect = wrap.closest('[data-message-scroll]')?.getBoundingClientRect();
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
      if (e.key !== 'Escape') return;
      // This Escape belongs to the popover alone: without stopPropagation it
      // would travel on to window-level listeners (the thread overlay's close
      // handler) and dismiss two layers with one keypress.
      e.stopPropagation();
      setOpen(false);
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
          {onShowInChat && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onShowInChat();
              }}
              className="block w-full px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Show in chat
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
export interface Row {
  message: MessageDTO;
  isMine: boolean;
  separatorLabel: string | null;
  showSender: boolean; // group + other + first of run
  showAvatar: boolean; // group + other + last of run
  showTime: boolean; // last of run
  isRunStart: boolean;
}

export function buildRows(messages: MessageDTO[], meId: number, isGroup: boolean): Row[] {
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
 * is the one exception — instead of downloading, its card opens the in-app
 * pdf.js viewer (PdfViewer) via `onOpenPdf`. It must NOT be a navigation:
 * both same-tab and `target="_blank"` navigations strand the installed-PWA
 * phone user on a PDF view with no back affordance (a `_blank` same-origin
 * link even gets a fresh, history-less context), and the origin's manifest
 * scope means it can never get the external-URL custom-tab treatment. The
 * subtitle swaps to "PDF · <size>" as a small visual hint that it opens
 * rather than saves. Every other file type keeps the plain download behavior
 * unchanged (as does a PDF with no `onOpenPdf` wired, e.g. the video-fallback
 * call site — a plain download link, never a trap).
 */
function AttachmentFile({
  file,
  isMine,
  onOpenPdf,
}: {
  file: AttachmentDTO;
  isMine: boolean;
  onOpenPdf?: (a: AttachmentDTO) => void;
}) {
  const bubble = isMine ? 'bg-[#0084ff] text-white' : 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100';
  const sub = isMine ? 'text-white/70' : 'text-gray-500 dark:text-gray-400';
  const isPdf = file.mimeType === 'application/pdf';
  const inner = (
    <>
      <FileIcon />
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate font-medium">{file.originalName}</span>
        <span className={`text-xs ${sub}`}>
          {isPdf ? `PDF · ${formatBytes(file.sizeBytes)}` : formatBytes(file.sizeBytes)}
        </span>
      </span>
    </>
  );
  const cardClass = `flex max-w-[16rem] items-center gap-3 rounded-2xl px-3 py-2 ${bubble}`;

  if (isPdf && onOpenPdf) {
    return (
      <button type="button" onClick={() => onOpenPdf(file)} className={cardClass}>
        {inner}
      </button>
    );
  }
  return (
    <a
      href={attachmentUrl(file.id, { download: true })}
      download={file.originalName}
      className={cardClass}
    >
      {inner}
    </a>
  );
}

/**
 * The quoted-reply block shown above a bubble's content when the message replies
 * to another. Resolves the original sender's name from the chat members (falling
 * back to 'Unknown' if they've since left), and previews the snapshot: a deleted
 * original reads italic 'Message deleted'; an attachment-only original reads
 * '📎 Attachment'; otherwise the (server-truncated) text. Tapping it opens the
 * thread view for the reply chain this message belongs to.
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
  onOpenPdf,
  onOpenThread,
  onTriggerAction,
}: {
  message: MessageDTO;
  members: UserDTO[];
  meId: number;
  isMine: boolean;
  onOpenImage: (a: AttachmentDTO) => void;
  onOpenPdf: (a: AttachmentDTO) => void;
  /** Tap on the quoted-reply chip: open the thread this message belongs to.
   *  Doubles as the chip's render gate — the thread overlay omits it, and no
   *  quote chips render there (the chain itself is the context). */
  onOpenThread?: (messageId: number) => void;
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
      {message.replyTo && onOpenThread && (
        <ReplyQuote
          replyTo={message.replyTo}
          members={members}
          isMine={isMine}
          onJump={() => onOpenThread(message.replyTo!.id)}
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
        <AttachmentFile key={f.id} file={f} isMine={isMine} onOpenPdf={onOpenPdf} />
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

export default function MessageRow({
  row,
  members,
  meId,
  isGroup,
  onOpenImage,
  onOpenPdf,
  onEdit,
  onDelete,
  onReact,
  onCopy,
  onReply,
  onShowInChat,
  onOpenThread,
  onTriggerAction,
}: {
  row: Row;
  members: UserDTO[];
  meId: number;
  isGroup: boolean;
  onOpenImage: (a: AttachmentDTO) => void;
  onOpenPdf: (a: AttachmentDTO) => void;
  onEdit: (message: MessageDTO) => void;
  onDelete: (message: MessageDTO) => void;
  onReact: (message: MessageDTO, emoji: string) => void;
  onCopy: (message: MessageDTO) => void;
  /** Start a reply to this message. Omitted in the thread overlay — replying
   *  to an arbitrary thread message would start a sub-thread. */
  onReply?: (message: MessageDTO) => void;
  /** Thread overlay only: reveal this message in the main conversation. */
  onShowInChat?: (message: MessageDTO) => void;
  /** Tap on the quoted-reply chip: open this message's thread (main list only). */
  onOpenThread?: (messageId: number) => void;
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
              onReply={onReply && (() => onReply(message))}
              onShowInChat={onShowInChat && (() => onShowInChat(message))}
              onEdit={() => onEdit(message)}
              onDelete={() => onDelete(message)}
            >
              <MessageStack
                message={message}
                members={members}
                meId={meId}
                isMine
                onOpenImage={onOpenImage}
                onOpenPdf={onOpenPdf}
                onOpenThread={onOpenThread}
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
              onReply={onReply && (() => onReply(message))}
              onShowInChat={onShowInChat && (() => onShowInChat(message))}
            >
              <MessageStack
                message={message}
                members={members}
                meId={meId}
                isMine={false}
                onOpenImage={onOpenImage}
                onOpenPdf={onOpenPdf}
                onOpenThread={onOpenThread}
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
