import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChatSummaryDTO, MessageDTO } from '@messenger/shared';
import { useAuth } from '../lib/auth';
import {
  chatTitle,
  formatListTime,
  highlightSegments,
  otherMember,
  searchSnippet,
  searchTerms,
  useChats,
  useMessageSearch,
  useTypingChats,
} from '../lib/chats';
import { useOnlineUsers } from '../lib/presence';
import { attachmentPreviewText } from '../lib/attachments';
import { enablePush, pushSupported } from '../lib/push';
import Avatar from '../components/Avatar';

const BANNER_DISMISSED_KEY = 'push-banner-dismissed';

/**
 * Soft prompt to turn on notifications. Only shown when the browser supports push,
 * permission hasn't been decided yet, and the user hasn't dismissed it before.
 */
function NotificationBanner() {
  const [visible, setVisible] = useState(
    () =>
      pushSupported() &&
      Notification.permission === 'default' &&
      !localStorage.getItem(BANNER_DISMISSED_KEY),
  );
  const [error, setError] = useState<string | null>(null);

  if (!visible) return null;

  async function enable() {
    setError(null);
    try {
      await enablePush();
      setVisible(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not enable notifications');
    }
  }

  function later() {
    localStorage.setItem(BANNER_DISMISSED_KEY, '1');
    setVisible(false);
  }

  return (
    <div className="mx-2 mb-2 rounded-xl bg-blue-50 p-3 dark:bg-blue-500/10">
      <p className="mb-2 text-sm text-gray-700 dark:text-gray-200">
        Enable notifications to get messages when the app is closed.
      </p>
      {error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={enable}
          className="rounded-full bg-[#0084ff] px-3 py-1.5 text-sm font-semibold text-white"
        >
          Enable
        </button>
        <button
          type="button"
          onClick={later}
          className="rounded-full px-3 py-1.5 text-sm font-semibold text-gray-600 dark:text-gray-300"
        >
          Later
        </button>
      </div>
    </div>
  );
}

function NewGroupIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 8v6M22 11h-6" />
    </svg>
  );
}

/** Small "people" glyph marking group rows in the list. */
function GroupIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="11" cy="11" r="7" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** A message-content snippet with the query terms highlighted client-side. */
function HighlightedSnippet({ content, terms }: { content: string; terms: string[] }) {
  const segments = highlightSegments(searchSnippet(content, terms), terms);
  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <mark
            key={i}
            className="rounded bg-[#0084ff]/20 px-0.5 font-medium text-inherit dark:bg-[#0084ff]/30"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** One search hit: the chat it belongs to, sender + time, and a highlighted
 *  snippet. Tapping it opens the chat focused on the message (`?message=`). */
function SearchResultRow({
  message,
  title,
  terms,
}: {
  message: MessageDTO;
  title: string;
  terms: string[];
}) {
  const body =
    message.content !== ''
      ? <HighlightedSnippet content={message.content} terms={terms} />
      : message.attachments.length > 0
        ? attachmentPreviewText(message.attachments)
        : '';
  return (
    <li>
      <Link
        to={`/chats/${message.chatId}?message=${message.id}`}
        className="flex flex-col gap-0.5 rounded-xl px-2 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-semibold text-gray-900 dark:text-gray-100">{title}</span>
          <span className="flex-shrink-0 text-xs text-gray-400 dark:text-gray-500">
            {formatListTime(message.createdAt)}
          </span>
        </div>
        <span className="truncate text-xs text-gray-500 dark:text-gray-400">
          {message.sender.displayName}
        </span>
        <p className="truncate text-sm text-gray-600 dark:text-gray-300">{body}</p>
      </Link>
    </li>
  );
}

function previewText(chat: ChatSummaryDTO, meId: number): string {
  if (!chat.lastMessage) {
    // A fresh group has no messages to preview — list who's in it instead.
    if (chat.type === 'group') {
      const names = chat.members.filter((m) => m.id !== meId).map((m) => m.displayName);
      if (names.length > 0) return names.join(', ');
    }
    return 'No messages yet';
  }
  const { content, attachments, sender, isDeleted } = chat.lastMessage;
  const prefix = sender.id === meId ? 'You: ' : '';
  if (isDeleted) return `${prefix}Message deleted`;
  const body = content === '' && attachments.length > 0 ? attachmentPreviewText(attachments) : content;
  return `${prefix}${body}`;
}

function ChatRow({
  chat,
  meId,
  online,
  typing,
}: {
  chat: ChatSummaryDTO;
  meId: number;
  online: boolean;
  typing: boolean;
}) {
  const title = chatTitle(chat, meId);
  const unread = chat.unreadCount > 0;
  const other = otherMember(chat, meId);
  const avatarId = chat.type === 'group' ? chat.id : (other?.id ?? chat.id);

  // Preview line: an italic blue "typing…" while someone types, else the last
  // message (italic for tombstones, bolder while unread).
  const previewClass = typing
    ? 'italic text-[#0084ff]'
    : `${chat.lastMessage?.isDeleted ? 'italic ' : ''}${unread ? 'font-medium text-gray-700 dark:text-gray-200' : 'text-gray-500 dark:text-gray-400'}`;

  return (
    <li>
      <Link
        to={`/chats/${chat.id}`}
        className="flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        <Avatar
          name={title}
          id={avatarId}
          size="lg"
          online={online}
          color={chat.type === 'group' ? undefined : other?.color}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={`truncate ${unread ? 'font-bold text-gray-900 dark:text-gray-100' : 'font-semibold text-gray-900 dark:text-gray-100'}`}
              >
                {title}
              </span>
              {chat.type === 'group' && (
                <span
                  className="flex flex-shrink-0 items-center gap-0.5 text-gray-400 dark:text-gray-500"
                  title={chat.members.map((m) => m.displayName).join(', ')}
                  data-testid="group-badge"
                >
                  <GroupIcon />
                  <span className="text-xs">{chat.members.length}</span>
                </span>
              )}
            </span>
            {chat.lastMessage && (
              <span className="flex-shrink-0 text-xs text-gray-400 dark:text-gray-500">
                {formatListTime(chat.lastMessage.createdAt)}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className={`truncate text-sm ${previewClass}`}>
              {typing ? 'typing…' : previewText(chat, meId)}
            </span>
            {unread && (
              <span className="flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#0084ff] px-1.5 text-xs font-semibold text-white">
                {chat.unreadCount}
              </span>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}

export default function ChatListPage() {
  const { user } = useAuth();
  const { chats, loading, error } = useChats();
  const meId = user?.id ?? -1;
  const onlineIds = useOnlineUsers();
  const typingChats = useTypingChats(meId);

  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  const {
    messages: results,
    loading: searchLoading,
    error: searchError,
    hasMore: hasMoreResults,
    loadMore,
  } = useMessageSearch(query);
  const terms = useMemo(() => searchTerms(query), [query]);

  // Resolve a hit's chat title from the already-loaded chat list.
  const titleForChat = (chatId: number): string => {
    const chat = chats.find((c) => c.id === chatId);
    return chat ? chatTitle(chat, meId) : 'Conversation';
  };

  // A DM row shows the online dot only when the *other* member is online.
  const isDmOtherOnline = (chat: ChatSummaryDTO): boolean => {
    if (chat.type !== 'dm') return false;
    const other = otherMember(chat, meId);
    return other ? onlineIds.has(other.id) : false;
  };

  return (
    <div className="p-2">
      <div className="flex items-center justify-between px-2 py-3">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Chats</h1>
        <Link
          to="/chats/new-group"
          aria-label="New group"
          className="flex h-9 w-9 items-center justify-center rounded-full text-[#0084ff] transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <NewGroupIcon />
        </Link>
      </div>

      <div className="px-2 pb-2">
        <div className="relative flex items-center">
          <span className="pointer-events-none absolute left-3 text-gray-400 dark:text-gray-500">
            <SearchIcon />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages"
            aria-label="Search messages"
            className="w-full rounded-full bg-gray-100 py-2 pl-9 pr-9 text-sm text-gray-900 placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#0084ff] dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
          />
          {searching && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2 flex h-6 w-6 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-200 dark:text-gray-500 dark:hover:bg-gray-700"
            >
              <ClearIcon />
            </button>
          )}
        </div>
      </div>

      {searching ? (
        searchError ? (
          <p className="px-2 py-10 text-center text-sm text-red-600 dark:text-red-400">{searchError}</p>
        ) : searchLoading && results.length === 0 ? (
          <div className="flex justify-center py-10" role="status" aria-label="Searching">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-[#0084ff] dark:border-gray-700 dark:border-t-[#0084ff]" />
          </div>
        ) : results.length === 0 ? (
          <p className="px-2 py-16 text-center text-sm text-gray-500 dark:text-gray-400">
            No messages found
          </p>
        ) : (
          <ul className="flex flex-col">
            {results.map((message) => (
              <SearchResultRow
                key={message.id}
                message={message}
                title={titleForChat(message.chatId)}
                terms={terms}
              />
            ))}
            {hasMoreResults && (
              <li className="flex justify-center py-3">
                <button
                  type="button"
                  onClick={loadMore}
                  className="rounded-full bg-gray-100 px-4 py-1 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  Load more
                </button>
              </li>
            )}
          </ul>
        )
      ) : (
        <>
          <NotificationBanner />

          {error && <p className="px-2 pb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

          {loading && chats.length === 0 ? (
            <div className="flex justify-center py-10" role="status" aria-label="Loading chats">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-[#0084ff] dark:border-gray-700 dark:border-t-[#0084ff]" />
            </div>
          ) : chats.length === 0 ? (
            <div className="px-2 py-16 text-center">
              <p className="mb-3 text-gray-500 dark:text-gray-400">No chats yet</p>
              <Link
                to="/users"
                className="inline-block rounded-full bg-[#0084ff] px-4 py-2 text-sm font-semibold text-white"
              >
                Find people to message
              </Link>
            </div>
          ) : (
            <ul className="flex flex-col">
              {chats.map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  meId={meId}
                  online={isDmOtherOnline(chat)}
                  typing={typingChats.has(chat.id)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
