import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { AttachmentDTO, ChatMemberDTO, MessageDTO, UserDTO } from '@messenger/shared';
import { useAuth } from '../lib/auth';
import { splitByMentions } from '../lib/mentions';
import {
  chatTitle,
  formatDaySeparator,
  formatMessageTime,
  markRead,
  otherMember,
  readPositions,
  sameCalendarDay,
  useChat,
  useChatTyping,
  useMessages,
} from '../lib/chats';
import { useOnlineUsers } from '../lib/presence';
import { attachmentUrl, formatBytes } from '../lib/attachments';
import Avatar from '../components/Avatar';
import Composer from '../components/Composer';
import GroupInfo from '../components/GroupInfo';
import Lightbox from '../components/Lightbox';

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

/** How long a touch must be held before the actions menu opens (mobile long-press). */
const LONG_PRESS_MS = 500;

/** A deleted message: a muted, italic outline bubble with no fill and no menu. */
function TombstoneBubble() {
  return (
    <div className="rounded-2xl border border-gray-200 px-3 py-2 text-sm italic text-gray-400">
      Message deleted
    </div>
  );
}

/**
 * Wraps an own, non-deleted bubble with an Edit/Delete affordance: a '⋯' button
 * that fades in on hover (desktop) and a long-press / right-click on the bubble
 * itself (mobile) — both open a small popover menu. The menu closes on an
 * outside tap/click or Escape.
 */
function MessageActions({
  onEdit,
  onDelete,
  children,
}: {
  onEdit: () => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

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

  return (
    <div ref={wrapRef} className="group relative flex items-center gap-1">
      <button
        type="button"
        aria-label="Message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-gray-400 opacity-0 transition-opacity hover:bg-gray-100 focus:opacity-100 group-hover:opacity-100"
      >
        <DotsIcon />
      </button>
      <div
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
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 min-w-[8rem] overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
            className="block w-full px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100"
          >
            Edit
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="block w-full px-4 py-2 text-left text-sm text-red-600 transition-colors hover:bg-gray-100"
          >
            Delete
          </button>
        </div>
      )}
    </div>
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

/** Render message text, styling any `@mention` of a chat member. Mentions of ME
 *  get a subtle highlight in others' (gray) bubbles so being tagged stands out. */
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
  if (message.mentions.length === 0) return <>{message.content}</>;

  const segments = splitByMentions(message.content, members, message.mentions);
  return (
    <>
      {segments.map((seg, i) => {
        if (!seg.mention) return <span key={i}>{seg.text}</span>;
        const base = isMine
          ? 'font-semibold underline decoration-white/60'
          : 'font-semibold text-[#0084ff]';
        const meHighlight = !isMine && seg.mention.id === meId ? ' bg-[#0084ff]/10 rounded px-0.5' : '';
        return (
          <span key={i} className={base + meHighlight}>
            {seg.text}
          </span>
        );
      })}
    </>
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

/** Non-image attachment: a download card styled like the message bubble. */
function AttachmentFile({ file, isMine }: { file: AttachmentDTO; isMine: boolean }) {
  const bubble = isMine ? 'bg-[#0084ff] text-white' : 'bg-gray-200 text-gray-900';
  const sub = isMine ? 'text-white/70' : 'text-gray-500';
  return (
    <a
      href={attachmentUrl(file.id, { download: true })}
      download={file.originalName}
      className={`flex max-w-[16rem] items-center gap-3 rounded-2xl px-3 py-2 ${bubble}`}
    >
      <FileIcon />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{file.originalName}</span>
        <span className={`text-xs ${sub}`}>{formatBytes(file.sizeBytes)}</span>
      </span>
    </a>
  );
}

/** The stacked content of a bubble: image block, file cards, then the text bubble
 *  (omitted for attachment-only messages, whose images render bare). */
function MessageStack({
  message,
  members,
  meId,
  isMine,
  onOpenImage,
}: {
  message: MessageDTO;
  members: UserDTO[];
  meId: number;
  isMine: boolean;
  onOpenImage: (a: AttachmentDTO) => void;
}) {
  const images = message.attachments.filter((a) => a.kind === 'image');
  const files = message.attachments.filter((a) => a.kind === 'file');
  const hasText = message.content.length > 0;
  const bubble = isMine ? 'bg-[#0084ff] text-white' : 'bg-gray-200 text-gray-900';

  return (
    <div className={`flex w-full flex-col gap-1 ${isMine ? 'items-end' : 'items-start'}`}>
      {images.length > 0 && <AttachmentImages images={images} onOpen={onOpenImage} />}
      {files.map((f) => (
        <AttachmentFile key={f.id} file={f} isMine={isMine} />
      ))}
      {hasText && (
        <div className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 ${bubble}`}>
          <MessageContent message={message} members={members} meId={meId} isMine={isMine} />
        </div>
      )}
    </div>
  );
}

/** The `14:32 (edited)` line under the last bubble of a run. */
function TimeLabel({ message, indent }: { message: MessageDTO; indent: boolean }) {
  return (
    <span className={`mt-0.5 text-[10px] text-gray-400 ${indent ? 'ml-1' : ''}`}>
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
          <Avatar key={m.id} name={m.displayName} id={m.id} size="xs" />
        ))}
      </div>
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
}: {
  row: Row;
  members: UserDTO[];
  meId: number;
  isGroup: boolean;
  onOpenImage: (a: AttachmentDTO) => void;
  onEdit: (message: MessageDTO) => void;
  onDelete: (message: MessageDTO) => void;
}) {
  const { message, isMine, showSender, showAvatar, showTime, isRunStart } = row;
  const spacing = isRunStart ? 'mt-3' : 'mt-0.5';
  // Tapping the sender avatar reveals the name on this row (mobile has no hover).
  const [nameRevealed, setNameRevealed] = useState(false);

  if (isMine) {
    return (
      <div className={`flex justify-end px-3 ${spacing}`}>
        <div className="flex max-w-[75%] flex-col items-end">
          {message.isDeleted ? (
            <TombstoneBubble />
          ) : (
            <MessageActions onEdit={() => onEdit(message)} onDelete={() => onDelete(message)}>
              <MessageStack message={message} members={members} meId={meId} isMine onOpenImage={onOpenImage} />
            </MessageActions>
          )}
          {showTime && <TimeLabel message={message} indent={false} />}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex justify-start px-3 ${spacing}`}>
      <div className="flex max-w-[75%] items-end gap-2">
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
                <Avatar name={message.sender.displayName} id={message.sender.id} size="sm" />
              </button>
            )}
          </div>
        )}
        <div className="flex min-w-0 flex-col items-start">
          {(showSender || nameRevealed) && (
            <span className="mb-0.5 ml-1 text-xs text-gray-500">{message.sender.displayName}</span>
          )}
          {message.isDeleted ? (
            <TombstoneBubble />
          ) : (
            <MessageStack
              message={message}
              members={members}
              meId={meId}
              isMine={false}
              onOpenImage={onOpenImage}
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
          <div className="flex items-center gap-1 rounded-2xl bg-gray-200 px-3.5 py-3">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                style={{ animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </div>
          <span className="ml-1 text-[10px] text-gray-400">{typingLabel(names)}</span>
        </div>
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
  const { chat, removed } = useChat(chatId);
  const { messages, loadOlder, hasMore, sendMessage, editMessage, deleteMessage, loading } =
    useMessages(chatId);

  // I'm no longer a member (left the group, maybe in another tab) — bail out.
  useEffect(() => {
    if (removed) navigate('/chats');
  }, [removed, navigate]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true); // is the viewport near the bottom?
  const didInitialScroll = useRef(false);
  const lastMarkedId = useRef<number>(-1);
  const [lightbox, setLightbox] = useState<AttachmentDTO | null>(null);
  const [editing, setEditing] = useState<MessageDTO | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  const isGroup = chat?.type === 'group';
  const title = chat ? chatTitle(chat, meId) : 'Chat';
  const members = chat?.members ?? [];
  const rows = buildRows(messages, meId, isGroup);

  // Presence + typing. The header dot is DM-only (the other member); the typing
  // indicator names live typers (mapped to member display names).
  const onlineIds = useOnlineUsers();
  const dmOther = chat && !isGroup ? otherMember(chat, meId) : undefined;
  const otherOnline = dmOther ? onlineIds.has(dmOther.id) : false;
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

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  // Auto-scroll: jump to bottom on first load; afterwards only follow new
  // messages when the user is already near the bottom (don't yank them up).
  useLayoutEffect(() => {
    if (messages.length === 0) return;
    if (!didInitialScroll.current) {
      didInitialScroll.current = true;
      bottomRef.current?.scrollIntoView({ block: 'end' });
      stickToBottom.current = true;
    } else if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages]);

  // Mark read up to the newest message whenever the list changes. Best-effort
  // and fire-and-forget (nothing in the UI depends on the response) — a
  // transient failure just means the next message/focus/reconnect retries it.
  useEffect(() => {
    const newest = messages[messages.length - 1];
    if (!newest || newest.id === lastMarkedId.current) return;
    lastMarkedId.current = newest.id;
    markRead(chatId, newest.id).catch(() => {
      /* best-effort — the read marker is re-sent on the next message anyway */
    });
  }, [chatId, messages]);

  async function handleLoadOlder() {
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    await loadOlder();
    // Keep the viewport anchored on the same message after prepending.
    requestAnimationFrame(() => {
      const el2 = scrollRef.current;
      if (el2) el2.scrollTop = el2.scrollHeight - prevHeight;
    });
  }

  async function handleSend(content: string, mentions: number[], attachmentIds: number[]) {
    stickToBottom.current = true;
    await sendMessage(content, mentions, attachmentIds);
  }

  function handleDelete(message: MessageDTO) {
    if (window.confirm('Delete this message?')) {
      if (editing?.id === message.id) setEditing(null);
      void deleteMessage(message.id);
    }
  }

  async function handleEditSubmit(messageId: number, content: string, mentions: number[]) {
    await editMessage(messageId, content, mentions);
    setEditing(null);
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col bg-white">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 px-2 py-2">
        <Link
          to="/chats"
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-full text-gray-600 transition-colors hover:bg-gray-100"
        >
          <BackIcon />
        </Link>
        {chat && (
          <Avatar
            name={title}
            id={isGroup ? chat.id : (dmOther?.id ?? chat.id)}
            online={otherOnline}
          />
        )}
        {isGroup ? (
          <button
            type="button"
            onClick={() => setShowInfo(true)}
            aria-label="Group info"
            className="min-w-0 flex-1 rounded-lg px-1 text-left transition-colors hover:bg-gray-50"
          >
            <h1 className="truncate font-semibold text-gray-900">{title}</h1>
            {chat && <p className="truncate text-xs text-gray-500">{chat.members.length} members</p>}
          </button>
        ) : (
          <div className="min-w-0">
            <h1 className="truncate font-semibold text-gray-900">{title}</h1>
          </div>
        )}
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-2">
        {hasMore && (
          <div className="flex justify-center py-2">
            <button
              type="button"
              onClick={handleLoadOlder}
              className="rounded-full bg-gray-100 px-4 py-1 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200"
            >
              Load older
            </button>
          </div>
        )}

        {loading && messages.length === 0 ? (
          <div className="flex justify-center py-10" role="status" aria-label="Loading messages">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-[#0084ff]" />
          </div>
        ) : messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-400">No messages yet. Say hi!</p>
        ) : (
          rows.map((row) => (
            <div key={row.message.id}>
              {row.separatorLabel && (
                <div className="flex justify-center py-3">
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-500">
                    {row.separatorLabel}
                  </span>
                </div>
              )}
              <MessageRow
                row={row}
                members={members}
                meId={meId}
                isGroup={isGroup}
                onOpenImage={setLightbox}
                onEdit={setEditing}
                onDelete={handleDelete}
              />
              <ReadReceipts members={receiptsByMessageId.get(row.message.id) ?? []} />
            </div>
          ))
        )}
        <TypingIndicator names={typingNames} isGroup={isGroup} />
        <div ref={bottomRef} />
      </div>

      <Composer
        onSend={handleSend}
        members={members}
        meId={meId}
        chatId={chatId}
        editing={editing}
        onEditSubmit={handleEditSubmit}
        onCancelEdit={() => setEditing(null)}
      />

      {lightbox && <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />}
      {showInfo && isGroup && chat && (
        <GroupInfo chat={chat} meId={meId} onClose={() => setShowInfo(false)} />
      )}
    </div>
  );
}
