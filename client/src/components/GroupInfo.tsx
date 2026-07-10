import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatSummaryDTO, UserDTO } from '@messenger/shared';
import { apiGet, apiPatch, apiPost, apiPut } from '../lib/api';
import { groupColors } from '../lib/chats';
import { useOnlineUsers } from '../lib/presence';
import Avatar from './Avatar';

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
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

/**
 * Full-screen group info sheet: member list, add-members picker, mute toggle,
 * leave button. `chat` stays live — ChatPage's useChat applies `chat:updated`
 * (e.g. after an add) and re-renders this sheet with the new member list.
 * Leaving navigates back to the chat list; the server's `chat:removed` cleans
 * up other tabs.
 *
 * Mute is the one exception: it's a personal flag (like a read marker), so the
 * server does NOT emit `chat:updated` for it — broadcasting it would leak into
 * other members' personalized summaries. This sheet therefore tracks it in its
 * own local state (seeded from `chat.muted`, updated optimistically on toggle)
 * rather than relying on the live `chat` prop to reflect it.
 */
export default function GroupInfo({
  chat,
  meId,
  onClose,
}: {
  chat: ChatSummaryDTO;
  meId: number;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const onlineIds = useOnlineUsers();
  const [directory, setDirectory] = useState<UserDTO[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(chat.name ?? '');
  const [muted, setMuted] = useState(chat.muted ?? false);
  const [muteBusy, setMuteBusy] = useState(false);

  // Keep the draft in sync with the live name (e.g. renamed in another tab)
  // while the form is closed; an open edit is never clobbered.
  useEffect(() => {
    if (!renaming) setNameDraft(chat.name ?? '');
  }, [chat.name, renaming]);

  // Re-seed only when the CHAT itself changes (defensive — in practice this
  // sheet is remounted fresh each time it opens, per ChatPage). Deliberately
  // NOT keyed on `chat.muted`: the mute endpoint emits no `chat:updated`, so
  // the live `chat` prop never reflects our own toggle — resyncing on every
  // `chat.muted` render would immediately stomp our own optimistic update back
  // to the stale prop value once the request settles.
  const lastChatId = useRef(chat.id);
  if (lastChatId.current !== chat.id) {
    lastChatId.current = chat.id;
    setMuted(chat.muted ?? false);
  }

  useEffect(() => {
    let cancelled = false;
    apiGet<{ users: UserDTO[] }>('/api/users')
      .then((res) => {
        if (!cancelled) setDirectory(res.users);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load people');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const memberIds = new Set(chat.members.map((m) => m.id));
  const addable = (directory ?? []).filter((u) => !memberIds.has(u.id));

  function toggle(userId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function addSelected() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/chats/${chat.id}/members`, { memberIds: [...selected] });
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add members');
    } finally {
      setBusy(false);
    }
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    const trimmed = nameDraft.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/chats/${chat.id}`, { name: trimmed });
      // The new name lands via the chat:updated socket event.
      setRenaming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename group');
    } finally {
      setBusy(false);
    }
  }

  async function toggleMute() {
    if (muteBusy) return;
    const next = !muted;
    setMuted(next); // optimistic — the server never echoes this back via a socket event
    setMuteBusy(true);
    setError(null);
    try {
      await apiPut(`/api/chats/${chat.id}/mute`, { muted: next });
    } catch (err) {
      setMuted(!next); // revert
      setError(err instanceof Error ? err.message : 'Could not update notifications');
    } finally {
      setMuteBusy(false);
    }
  }

  async function leave() {
    if (busy || !window.confirm('Leave this group?')) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost<void>(`/api/chats/${chat.id}/leave`, {});
      navigate('/chats');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not leave group');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-center bg-white dark:bg-gray-900">
      <div className="flex h-full w-full max-w-xl flex-col">
        <header className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 px-2 py-2 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close group info"
            className="flex h-9 w-9 items-center justify-center rounded-full text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <CloseIcon />
          </button>
          <h1 className="font-semibold text-gray-900 dark:text-gray-100">Group info</h1>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-4 flex items-center gap-3">
            <Avatar
              name={chat.name ?? 'Group'}
              id={chat.id}
              size="lg"
              colors={groupColors(chat.members)}
            />
            {renaming ? (
              <form onSubmit={rename} className="flex min-w-0 flex-1 items-center gap-2">
                <label htmlFor="group-rename" className="sr-only">
                  Group name
                </label>
                <input
                  id="group-rename"
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  autoFocus
                  className="w-full min-w-0 rounded-full border border-gray-300 px-3 py-1.5 text-gray-900 focus:border-[#0084ff] focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                />
                <button
                  type="submit"
                  disabled={nameDraft.trim().length === 0 || busy}
                  className="flex-shrink-0 rounded-full bg-[#0084ff] px-3 py-1.5 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setRenaming(false)}
                  className="flex-shrink-0 rounded-full px-2 py-1.5 text-sm font-semibold text-gray-600 dark:text-gray-300"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-lg font-bold text-gray-900 dark:text-gray-100">
                    {chat.name ?? 'Group'}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setRenaming(true)}
                    aria-label="Rename group"
                    className="flex-shrink-0 rounded-full px-2 py-0.5 text-sm font-semibold text-[#0084ff] transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    Rename
                  </button>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400">{chat.members.length} members</p>
              </div>
            )}
          </div>

          <div className="mb-4 flex items-center justify-between rounded-xl px-2 py-2">
            <span className="font-medium text-gray-900 dark:text-gray-100">Mute notifications</span>
            <button
              type="button"
              role="switch"
              aria-checked={muted}
              aria-label="Mute notifications"
              onClick={toggleMute}
              disabled={muteBusy}
              className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:opacity-60 ${
                muted ? 'bg-[#0084ff]' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  muted ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {error && <p className="pb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

          <h3 className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Members
          </h3>
          <ul className="mb-4 flex flex-col">
            {chat.members.map((member) => (
              <li key={member.id} className="flex items-center gap-3 rounded-xl px-2 py-2">
                <Avatar
                  name={member.displayName}
                  id={member.id}
                  color={member.color}
                  online={member.id !== meId && onlineIds.has(member.id)}
                />
                <span className="flex-1 truncate font-medium text-gray-900 dark:text-gray-100">
                  {member.displayName}
                  {member.id === meId && <span className="ml-1 text-sm text-gray-400 dark:text-gray-500">(you)</span>}
                </span>
                {member.isBot && (
                  <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                    Bot
                  </span>
                )}
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between px-1 pb-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Add members
            </h3>
            {addable.length > 0 && (
              <button
                type="button"
                onClick={addSelected}
                disabled={selected.size === 0 || busy}
                className="rounded-full bg-[#0084ff] px-3 py-1 text-xs font-semibold text-white transition-opacity disabled:opacity-40"
              >
                {busy ? 'Adding…' : `Add${selected.size > 0 ? ` (${selected.size})` : ''}`}
              </button>
            )}
          </div>
          {directory === null ? (
            <p className="mb-4 px-1 text-sm text-gray-400 dark:text-gray-500">Loading people…</p>
          ) : addable.length === 0 ? (
            <p className="mb-4 px-1 text-sm text-gray-400 dark:text-gray-500">
              Everyone is already in this group.
            </p>
          ) : (
              <ul className="mb-4 flex flex-col">
                {addable.map((user) => {
                  const checked = selected.has(user.id);
                  return (
                    <li key={user.id}>
                      <button
                        type="button"
                        onClick={() => toggle(user.id)}
                        aria-pressed={checked}
                        className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        <Avatar name={user.displayName} id={user.id} color={user.color} />
                        <span className="flex-1 truncate font-medium text-gray-900 dark:text-gray-100">
                          {user.displayName}
                        </span>
                        <span
                          className={`flex h-6 w-6 items-center justify-center rounded-full border ${
                            checked
                              ? 'border-[#0084ff] bg-[#0084ff] text-white'
                              : 'border-gray-300 text-transparent dark:border-gray-600'
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

          <button
            type="button"
            onClick={leave}
            disabled={busy}
            className="w-full rounded-xl px-4 py-3 text-left font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-60 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            Leave group
          </button>
        </div>
      </div>
    </div>
  );
}
