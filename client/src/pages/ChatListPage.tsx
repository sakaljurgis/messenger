import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChatSummaryDTO } from '@messenger/shared';
import { useAuth } from '../lib/auth';
import { chatTitle, formatListTime, otherMember, useChats } from '../lib/chats';
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
    <div className="mx-2 mb-2 rounded-xl bg-blue-50 p-3">
      <p className="mb-2 text-sm text-gray-700">
        Enable notifications to get messages when the app is closed.
      </p>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
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
          className="rounded-full px-3 py-1.5 text-sm font-semibold text-gray-600"
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

function previewText(chat: ChatSummaryDTO, meId: number): string {
  if (!chat.lastMessage) return 'No messages yet';
  const prefix = chat.lastMessage.sender.id === meId ? 'You: ' : '';
  return `${prefix}${chat.lastMessage.content}`;
}

function ChatRow({ chat, meId }: { chat: ChatSummaryDTO; meId: number }) {
  const title = chatTitle(chat, meId);
  const unread = chat.unreadCount > 0;
  const other = otherMember(chat, meId);
  const avatarId = chat.type === 'group' ? chat.id : (other?.id ?? chat.id);

  return (
    <li>
      <Link
        to={`/chats/${chat.id}`}
        className="flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-gray-50"
      >
        <Avatar name={title} id={avatarId} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={`truncate ${unread ? 'font-bold text-gray-900' : 'font-semibold text-gray-900'}`}
            >
              {title}
            </span>
            {chat.lastMessage && (
              <span className="flex-shrink-0 text-xs text-gray-400">
                {formatListTime(chat.lastMessage.createdAt)}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className={`truncate text-sm ${unread ? 'font-medium text-gray-700' : 'text-gray-500'}`}>
              {previewText(chat, meId)}
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

  return (
    <div className="p-2">
      <div className="flex items-center justify-between px-2 py-3">
        <h1 className="text-xl font-bold text-gray-900">Chats</h1>
        <Link
          to="/chats/new-group"
          aria-label="New group"
          className="flex h-9 w-9 items-center justify-center rounded-full text-[#0084ff] transition-colors hover:bg-gray-100"
        >
          <NewGroupIcon />
        </Link>
      </div>

      <NotificationBanner />

      {error && <p className="px-2 pb-2 text-sm text-red-600">{error}</p>}

      {loading && chats.length === 0 ? (
        <div className="flex justify-center py-10" role="status" aria-label="Loading chats">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-[#0084ff]" />
        </div>
      ) : chats.length === 0 ? (
        <div className="px-2 py-16 text-center">
          <p className="mb-3 text-gray-500">No chats yet</p>
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
            <ChatRow key={chat.id} chat={chat} meId={meId} />
          ))}
        </ul>
      )}
    </div>
  );
}
