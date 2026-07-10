import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ChatSummaryDTO, UserDTO } from '@messenger/shared';
import { apiGet, apiPost } from '../lib/api';
import Avatar from '../components/Avatar';

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={3}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5L20 7" />
    </svg>
  );
}

export default function NewGroupPage() {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<UserDTO[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!users) return [];
    if (!q) return users;
    return users.filter((u) => u.displayName.toLowerCase().includes(q));
  }, [users, query]);

  function toggle(userId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  const canCreate = name.trim().length > 0 && selected.size >= 1 && !creating;

  async function handleCreate() {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const res = await apiPost<{ chat: ChatSummaryDTO }>('/api/chats', {
        name: name.trim(),
        memberIds: [...selected],
      });
      navigate(`/chats/${res.chat.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create group');
      setCreating(false);
    }
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
        <h1 className="font-semibold text-gray-900 dark:text-gray-100">New group</h1>
        <button
          type="button"
          onClick={handleCreate}
          disabled={!canCreate}
          className="ml-auto rounded-full bg-[#0084ff] px-4 py-1.5 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
        >
          {creating ? 'Creating…' : 'Create'}
        </button>
      </header>

      <div className="flex-shrink-0 space-y-2 border-b border-gray-100 p-3 dark:border-gray-800">
        <label htmlFor="group-name" className="sr-only">
          Group name
        </label>
        <input
          id="group-name"
          type="text"
          placeholder="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-full border border-gray-300 px-4 py-2 text-gray-900 focus:border-[#0084ff] focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-400"
        />
        <label htmlFor="member-search" className="sr-only">
          Search people
        </label>
        <input
          id="member-search"
          type="search"
          placeholder="Search people"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-full bg-gray-100 px-4 py-2 text-gray-900 focus:outline-none dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-400"
        />
      </div>

      {error && <p className="px-3 pt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {users === null ? (
          <div className="flex justify-center py-10" role="status" aria-label="Loading people">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-[#0084ff] dark:border-gray-700 dark:border-t-[#0084ff]" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-gray-500 dark:text-gray-400">No people found</p>
        ) : (
          <ul className="flex flex-col">
            {filtered.map((user) => {
              const checked = selected.has(user.id);
              return (
                <li key={user.id}>
                  <button
                    type="button"
                    onClick={() => toggle(user.id)}
                    aria-pressed={checked}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    <Avatar name={user.displayName} id={user.id} />
                    <span className="flex-1 font-medium text-gray-900 dark:text-gray-100">{user.displayName}</span>
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-full border ${
                        checked ? 'border-[#0084ff] bg-[#0084ff] text-white' : 'border-gray-300 text-transparent dark:border-gray-600'
                      }`}
                    >
                      <CheckIcon />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
