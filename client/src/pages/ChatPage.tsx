import { useEffect, useLayoutEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { MessageDTO, UserDTO } from '@messenger/shared';
import { useAuth } from '../lib/auth';
import { splitByMentions } from '../lib/mentions';
import {
  chatTitle,
  formatDaySeparator,
  formatMessageTime,
  markRead,
  sameCalendarDay,
  useChat,
  useMessages,
} from '../lib/chats';
import Avatar from '../components/Avatar';
import Composer from '../components/Composer';

const NEAR_BOTTOM_PX = 100;

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
    </svg>
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

function MessageRow({ row, members, meId }: { row: Row; members: UserDTO[]; meId: number }) {
  const { message, isMine, showSender, showAvatar, showTime, isRunStart } = row;
  const spacing = isRunStart ? 'mt-3' : 'mt-0.5';

  if (isMine) {
    return (
      <div className={`flex justify-end px-3 ${spacing}`}>
        <div className="flex max-w-[75%] flex-col items-end">
          <div className="whitespace-pre-wrap break-words rounded-2xl bg-[#0084ff] px-3 py-2 text-white">
            <MessageContent message={message} members={members} meId={meId} isMine />
          </div>
          {showTime && (
            <span className="mt-0.5 text-[10px] text-gray-400">{formatMessageTime(message.createdAt)}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex justify-start px-3 ${spacing}`}>
      <div className="flex max-w-[75%] items-end gap-2">
        <div className="w-8 flex-shrink-0">
          {showAvatar && <Avatar name={message.sender.displayName} id={message.sender.id} size="sm" />}
        </div>
        <div className="flex min-w-0 flex-col items-start">
          {showSender && (
            <span className="mb-0.5 ml-1 text-xs text-gray-500">{message.sender.displayName}</span>
          )}
          <div className="whitespace-pre-wrap break-words rounded-2xl bg-gray-200 px-3 py-2 text-gray-900">
            <MessageContent message={message} members={members} meId={meId} isMine={false} />
          </div>
          {showTime && (
            <span className="mt-0.5 ml-1 text-[10px] text-gray-400">
              {formatMessageTime(message.createdAt)}
            </span>
          )}
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

  const { chat } = useChat(chatId);
  const { messages, loadOlder, hasMore, sendMessage, loading } = useMessages(chatId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true); // is the viewport near the bottom?
  const didInitialScroll = useRef(false);
  const lastMarkedId = useRef<number>(-1);

  const isGroup = chat?.type === 'group';
  const title = chat ? chatTitle(chat, meId) : 'Chat';
  const members = chat?.members ?? [];
  const rows = buildRows(messages, meId, isGroup);

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

  // Mark read up to the newest message whenever the list changes.
  useEffect(() => {
    const newest = messages[messages.length - 1];
    if (!newest || newest.id === lastMarkedId.current) return;
    lastMarkedId.current = newest.id;
    void markRead(chatId, newest.id);
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

  async function handleSend(content: string, mentions: number[]) {
    stickToBottom.current = true;
    await sendMessage(content, mentions);
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
        {chat && <Avatar name={title} id={isGroup ? chat.id : (chat.members.find((m) => m.id !== meId)?.id ?? chat.id)} />}
        <div className="min-w-0">
          <h1 className="truncate font-semibold text-gray-900">{title}</h1>
          {isGroup && chat && (
            <p className="truncate text-xs text-gray-500">{chat.members.length} members</p>
          )}
        </div>
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
              <MessageRow row={row} members={members} meId={meId} />
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <Composer onSend={handleSend} members={members} meId={meId} />
    </div>
  );
}
