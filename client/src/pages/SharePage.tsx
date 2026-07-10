import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ChatSummaryDTO, MessageDTO, SendMessageRequest } from '@messenger/shared';
import { useAuth } from '../lib/auth';
import { chatTitle, groupColors, otherMember, useChats } from '../lib/chats';
import { compressImage, shouldCompress, uploadAttachment, formatBytes } from '../lib/attachments';
import { apiPost } from '../lib/api';
import {
  buildPrefill,
  defaultSharePayloadStore,
  sharedFileToFile,
  type SharePayloadStore,
  type SharedPayload,
} from '../lib/share';
import Avatar from '../components/Avatar';

interface SharePageProps {
  /** Injectable so tests can supply a fake payload without a real Cache API. */
  store?: SharePayloadStore;
}

/** A selectable chat row in the destination picker. */
function ChatPickRow({
  chat,
  meId,
  selected,
  onSelect,
}: {
  chat: ChatSummaryDTO;
  meId: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const title = chatTitle(chat, meId);
  // A DM's avatar is the other member (or me, for notes-to-self); groups use a
  // pie of the members' accent colors — mirrors the chat list.
  const dmPeer = otherMember(chat, meId) ?? chat.members.find((m) => m.id === meId);
  const avatarId = chat.type === 'group' ? chat.id : (dmPeer?.id ?? chat.id);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors ${
          selected ? 'bg-[#0084ff]/10 dark:bg-[#0084ff]/20' : 'hover:bg-gray-50 dark:hover:bg-gray-800'
        }`}
      >
        <Avatar
          name={title}
          id={avatarId}
          size="lg"
          color={chat.type === 'group' ? undefined : dmPeer?.color}
          colors={chat.type === 'group' ? groupColors(chat.members) : undefined}
        />
        <span className="min-w-0 flex-1 truncate font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </span>
        {selected && (
          <span
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[#0084ff] text-white"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * Landing screen for an OS "share to Messenger" (Android/Chromium only — see
 * lib/share for the iOS caveat). Reads the payload the service worker stashed,
 * previews it, lets the user pick a destination chat, then uploads any files
 * through the normal attachment pipeline and posts one message — exactly how the
 * Composer sends. Deep-linking /share with nothing stashed shows an empty state.
 */
export default function SharePage({ store = defaultSharePayloadStore }: SharePageProps) {
  const { user } = useAuth();
  const meId = user?.id ?? -1;
  const navigate = useNavigate();
  const { chats } = useChats();

  // undefined = still reading the stash; null = nothing was shared.
  const [payload, setPayload] = useState<SharedPayload | null | undefined>(undefined);
  const [text, setText] = useState('');
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read the stashed payload once on mount and seed the editable message text.
  useEffect(() => {
    let cancelled = false;
    store
      .read()
      .then((p) => {
        if (cancelled) return;
        setPayload(p);
        if (p) setText(buildPrefill(p));
      })
      .catch(() => {
        if (!cancelled) setPayload(null);
      });
    return () => {
      cancelled = true;
    };
  }, [store]);

  const files = payload?.files ?? [];

  // Object URLs for image previews, built once per payload and revoked on unmount
  // (jsdom's createObjectURL is stubbed in the test setup).
  const previewUrls = useMemo(
    () => files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f.blob) : null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payload],
  );
  useEffect(() => {
    return () => {
      for (const u of previewUrls) if (u) URL.revokeObjectURL(u);
    };
  }, [previewUrls]);

  const hasContent = text.trim().length > 0 || files.length > 0;
  const canSend = selectedChatId != null && !sending && hasContent;

  async function handleSend() {
    if (selectedChatId == null || sending || !payload) return;
    setSending(true);
    setError(null);
    try {
      // Upload each file through the SAME pipeline the Composer uses: images are
      // compressed client-side (no HD escape hatch here — sharing favors small),
      // everything else uploads as-is. NB: on a retry after a mid-send failure
      // these re-upload (leaving orphan attachments server-side); acceptable for a
      // personal app, and only the ids we attach below ever reach a message.
      const attachmentIds: number[] = [];
      for (const shared of files) {
        let file = sharedFileToFile(shared);
        if (file.type.startsWith('image/') && shouldCompress(file)) {
          file = await compressImage(file);
        }
        const attachment = await uploadAttachment(selectedChatId, file);
        attachmentIds.push(attachment.id);
      }

      // One message with the text/url as content and the uploaded ids — empty
      // content is valid when there are attachments (mirrors the Composer).
      const body: SendMessageRequest = { content: text.trim() };
      if (attachmentIds.length > 0) body.attachmentIds = attachmentIds;
      await apiPost<{ message: MessageDTO }>(`/api/chats/${selectedChatId}/messages`, body);

      // Consumed exactly once: clear the stash only after a successful send so a
      // failure keeps the payload for a retry.
      await store.clear();
      navigate(`/chats/${selectedChatId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to share');
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-white dark:bg-gray-900">
      <header className="flex items-center gap-2 border-b border-gray-200 px-2 py-3 dark:border-gray-700">
        <Link
          to="/chats"
          aria-label="Cancel"
          className="flex h-9 w-9 items-center justify-center rounded-full text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </Link>
        <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Share to…</h1>
      </header>

      {payload === undefined ? (
        <div className="flex flex-1 items-center justify-center" role="status" aria-label="Loading">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-[#0084ff] dark:border-gray-700 dark:border-t-[#0084ff]" />
        </div>
      ) : payload === null ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="mb-3 text-gray-500 dark:text-gray-400">Nothing was shared.</p>
          <Link
            to="/chats"
            className="inline-block rounded-full bg-[#0084ff] px-4 py-2 text-sm font-semibold text-white"
          >
            Go to chats
          </Link>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto">
            {/* Preview of what's being shared. */}
            <div className="border-b border-gray-100 p-3 dark:border-gray-800">
              {files.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2" aria-label="Shared files">
                  {files.map((f, i) => {
                    const preview = previewUrls[i];
                    return preview ? (
                      <img
                        key={i}
                        src={preview}
                        alt={f.name}
                        className="h-20 w-20 rounded-lg border border-gray-200 object-cover dark:border-gray-700"
                      />
                    ) : (
                      <div
                        key={i}
                        className="flex h-20 w-32 flex-col justify-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 dark:border-gray-700 dark:bg-gray-800"
                      >
                        <span className="truncate text-xs font-medium text-gray-700 dark:text-gray-200">
                          {f.name}
                        </span>
                        <span className="text-[10px] text-gray-400 dark:text-gray-500">
                          {f.blob.size > 0 ? formatBytes(f.blob.size) : f.type || 'file'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              <label htmlFor="share-text" className="sr-only">
                Message
              </label>
              <textarea
                id="share-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                placeholder="Add a message"
                className="w-full resize-none rounded-xl bg-gray-100 px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#0084ff] dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500"
              />
            </div>

            {/* Destination picker. */}
            <div className="p-2">
              <h2 className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                Send to
              </h2>
              {chats.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                  No chats yet
                </p>
              ) : (
                <ul className="flex flex-col">
                  {chats.map((chat) => (
                    <ChatPickRow
                      key={chat.id}
                      chat={chat}
                      meId={meId}
                      selected={selectedChatId === chat.id}
                      onSelect={() => setSelectedChatId(chat.id)}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Sticky action bar. */}
          <div className="border-t border-gray-200 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-gray-700">
            {error && (
              <p role="alert" className="mb-2 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSend}
              className="w-full rounded-full bg-[#0084ff] py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
            >
              {sending ? 'Sending…' : error ? 'Retry' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
