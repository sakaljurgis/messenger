import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentDTO, MessageDTO, UserDTO } from '@messenger/shared';
import { tombstone, useThread, type UseMessagesResult } from '../lib/chats';
import Composer from './Composer';
import Lightbox from './Lightbox';
import MessageRow, { buildRows } from './MessageRow';
import PdfViewer from './PdfViewer';

/** Same near-bottom threshold as the main chat list (ChatPage). */
const NEAR_BOTTOM_PX = 100;

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * Full-screen thread overlay (GroupInfo-style sheet over ChatPage): every
 * message connected to the anchor via reply links, rendered with the exact same
 * MessageRow rows as the main conversation — minus what would break the thread
 * model: no quoted-reply chips (the chain IS the context), no Reply action (a
 * reply to an arbitrary thread message would start a sub-thread), and a
 * "Show in chat" action instead (close + reveal in the main conversation).
 *
 * The composer at the bottom sends real messages into the chat that implicitly
 * reply to the thread ROOT (Slack-style), so they join the thread without
 * nesting; it keeps its own draft (`draftScope`), and edit mode works on own
 * thread messages. Mutations run through the SAME useMessages instance as the
 * main list (passed in as props) so both views stay consistent; their results
 * are merged into the thread state directly, with the socket echo deduping.
 * Live messages from others join via useThread's message:new rule.
 *
 * Escape closes the overlay — unless the thread's own lightbox/PDF viewer is
 * open (they own that Escape) or an edit is in progress (the composer's ✕
 * cancels it). Offline note: a send queued to the outbox renders its pending
 * bubble in the MAIN chat only; the thread shows it once it actually sends.
 */
export default function ThreadView({
  chatId,
  anchorId,
  members,
  meId,
  isGroup,
  onClose,
  onShowInChat,
  sendMessage,
  editMessage,
  deleteMessage,
  toggleReaction,
  onTriggerAction,
}: {
  chatId: number;
  /** Message the thread was opened from (any chain member — same thread). */
  anchorId: number;
  members: UserDTO[];
  meId: number;
  isGroup: boolean;
  onClose: () => void;
  /** Close the overlay and reveal the message in the main conversation. */
  onShowInChat: (messageId: number) => void;
  sendMessage: UseMessagesResult['sendMessage'];
  editMessage: UseMessagesResult['editMessage'];
  deleteMessage: UseMessagesResult['deleteMessage'];
  toggleReaction: UseMessagesResult['toggleReaction'];
  onTriggerAction: (messageId: number, actionId: string) => Promise<void>;
}) {
  const { messages, loading, error, mergeMessage } = useThread(chatId, anchorId);
  const [lightbox, setLightbox] = useState<AttachmentDTO | null>(null);
  const [pdfPreview, setPdfPreview] = useState<AttachmentDTO | null>(null);
  const [editing, setEditing] = useState<MessageDTO | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow new messages only while the user is already near the bottom.
  const stickToBottom = useRef(true);

  // The composer's implicit reply target: the root — every send joins the
  // thread as a direct reply to it. If the root has been deleted (replying to a
  // tombstone is a 400), fall back to the newest live thread message; with no
  // live message left the composer is disabled.
  const replyTarget = useMemo(() => {
    if (messages.length === 0) return null;
    const root = messages[0]!;
    if (!root.isDeleted) return root;
    return [...messages].reverse().find((m) => !m.isDeleted) ?? null;
  }, [messages]);

  // Quote chips never render inside the thread: MessageStack gates them on the
  // onOpenThread callback, which this overlay deliberately omits — the chain
  // itself is the context.
  const rows = useMemo(() => buildRows(messages, meId, isGroup), [messages, meId, isGroup]);

  // The thread's own photos back its lightbox gallery (the page's gallery only
  // spans the loaded chat window, which may not contain older thread photos).
  const galleryImages = useMemo(
    () => messages.flatMap((m) => m.attachments.filter((a) => a.kind === 'image')),
    [messages],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // The stacked lightbox/PDF viewer owns Escape while open; an in-progress
      // edit is cancelled via the composer's ✕, not by dropping the overlay.
      if (lightbox || pdfPreview || editing) return;
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, pdfPreview, editing, onClose]);

  // Pin to the bottom (the newest reply) when the thread loads, and keep
  // following growth while the user hasn't scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [loading, rows.length]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  async function handleSend(
    content: string,
    mentions: number[],
    attachmentIds: number[],
    replyToId?: number,
  ) {
    stickToBottom.current = true;
    const sent = await sendMessage(content, mentions, attachmentIds, replyToId);
    // Merge instantly (the socket echo dedupes); null = queued to the offline
    // outbox, whose pending bubble lives in the main chat.
    if (sent) mergeMessage(sent);
  }

  async function handleEditSubmit(messageId: number, content: string, mentions: number[]) {
    const updated = await editMessage(messageId, content, mentions);
    mergeMessage(updated);
    setEditing(null);
  }

  function handleDelete(message: MessageDTO) {
    if (window.confirm('Delete this message?')) {
      if (editing?.id === message.id) setEditing(null);
      // Optimistic tombstone here too; the server's message:updated echo (and
      // the main list's own optimistic copy) reconcile it.
      mergeMessage(tombstone(message));
      void deleteMessage(message.id);
    }
  }

  function handleReact(message: MessageDTO, emoji: string) {
    void toggleReaction(message.id, emoji)
      .then(mergeMessage)
      .catch(() => {
        /* transient failure — the chips just stay as they were */
      });
  }

  function handleCopy(message: MessageDTO) {
    void navigator.clipboard.writeText(message.content).catch(() => {});
  }

  const replyCount = messages.length - 1;
  const subtitle =
    replyCount <= 0 ? 'No replies yet' : replyCount === 1 ? '1 reply' : `${replyCount} replies`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Thread"
      className="fixed inset-0 z-40 flex justify-center bg-white dark:bg-gray-900"
    >
      <div className="flex h-full w-full max-w-xl flex-col">
        <header className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 px-2 py-2 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close thread"
            className="flex h-9 w-9 items-center justify-center rounded-full text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <CloseIcon />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold text-gray-900 dark:text-gray-100">Thread</h1>
            {!loading && !error && (
              <p className="truncate text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
            )}
          </div>
        </header>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-testid="thread-scroll"
          data-message-scroll=""
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-2"
        >
          {loading ? (
            <div className="flex justify-center py-10" role="status" aria-label="Loading thread">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-[#0084ff] dark:border-gray-700 dark:border-t-[#0084ff]" />
            </div>
          ) : error ? (
            <p className="py-10 text-center text-sm text-gray-400 dark:text-gray-500">{error}</p>
          ) : (
            rows.map((row, i) => (
              <div key={row.message.id}>
                {i === 1 && (
                  <div className="my-2 flex items-center gap-2 px-3" role="separator" aria-label={subtitle}>
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                      {subtitle}
                    </span>
                    <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
                  </div>
                )}
                {row.separatorLabel && (
                  <div className="flex justify-center py-3">
                    <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
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
                  onOpenPdf={setPdfPreview}
                  onEdit={setEditing}
                  onDelete={handleDelete}
                  onReact={handleReact}
                  onCopy={handleCopy}
                  onShowInChat={(m) => onShowInChat(m.id)}
                  onTriggerAction={onTriggerAction}
                />
              </div>
            ))
          )}
        </div>

        <Composer
          onSend={handleSend}
          disabled={loading || replyTarget === null}
          members={members}
          meId={meId}
          chatId={chatId}
          editing={editing}
          onEditSubmit={handleEditSubmit}
          onCancelEdit={() => setEditing(null)}
          fixedReplyToId={replyTarget?.id}
          draftScope="thread"
        />
      </div>

      {lightbox && (
        <Lightbox
          attachment={lightbox}
          images={galleryImages}
          onNavigate={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}
      {pdfPreview && <PdfViewer attachment={pdfPreview} onClose={() => setPdfPreview(null)} />}
    </div>
  );
}
