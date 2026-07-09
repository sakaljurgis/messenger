import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatSummaryDTO, UserDTO } from '@messenger/shared';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOnlineUsers } from '../lib/presence';
import Avatar from '../components/Avatar';

export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const navigate = useNavigate();
  const onlineIds = useOnlineUsers();

  useEffect(() => {
    let cancelled = false;
    apiGet<{ users: UserDTO[] }>('/api/users')
      .then((res) => {
        if (!cancelled) setUsers(res.users);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load people');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function openDm(user: UserDTO) {
    if (openingId !== null) return;
    setOpeningId(user.id);
    setError(null);
    try {
      const res = await apiPost<{ chat: ChatSummaryDTO }>('/api/chats', { userId: user.id });
      navigate(`/chats/${res.chat.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open chat');
      setOpeningId(null);
    }
  }

  return (
    <div className="p-2">
      <h1 className="px-2 py-3 text-xl font-bold text-gray-900">People</h1>

      {error && <p className="px-2 pb-2 text-sm text-red-600">{error}</p>}

      {users === null ? (
        <div className="flex justify-center py-10" role="status" aria-label="Loading people">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-[#0084ff]" />
        </div>
      ) : (
        <>
          {me && (
            <ul className="flex flex-col">
              <li>
                <button
                  type="button"
                  onClick={() => openDm(me)}
                  disabled={openingId !== null}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-gray-50 disabled:opacity-60"
                >
                  <Avatar name={me.displayName} id={me.id} />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium text-gray-900">Notes to self</span>
                    <span className="text-sm text-gray-500">Message yourself</span>
                  </span>
                </button>
              </li>
            </ul>
          )}
          {users.length === 0 ? (
            <p className="px-2 py-10 text-center text-gray-500">No other users yet</p>
          ) : (
            <ul className="flex flex-col">
              {users.map((user) => (
                <li key={user.id}>
                  <button
                    type="button"
                    onClick={() => openDm(user)}
                    disabled={openingId !== null}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-gray-50 disabled:opacity-60"
                  >
                    <Avatar name={user.displayName} id={user.id} online={onlineIds.has(user.id)} />
                    <span className="font-medium text-gray-900">{user.displayName}</span>
                    {user.isBot && (
                      <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">
                        Bot
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
