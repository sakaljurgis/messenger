import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { AttachmentDTO, MessageDTO, UserDTO } from '@messenger/shared';
import Avatar from './Avatar';
import { getSocket } from '../lib/socket';
import { compressImage, shouldCompress, uploadAttachment } from '../lib/attachments';
import {
  extractMentions,
  filterCandidates,
  findActiveMentionQuery,
  insertMention,
  mentionsFromText,
  type MentionCandidate,
} from '../lib/mentions';

interface ComposerProps {
  /**
   * Called with the trimmed message text, the ids the user @-mentioned, any
   * uploaded attachment ids, and — when replying — the target message's id.
   */
  onSend: (
    content: string,
    mentions: number[],
    attachmentIds: number[],
    replyToId?: number,
  ) => void | Promise<void>;
  disabled?: boolean;
  /** All members of the chat; the autocomplete offers everyone except me. */
  members: UserDTO[];
  meId: number;
  /** Chat the composer uploads attachments to. */
  chatId: number;
  /** When set, the composer is in edit mode: prefilled, no attachments, a ✓ save button. */
  editing?: MessageDTO | null;
  /** Save an edit (edit mode only): the message id, trimmed text, and rescanned mention ids. */
  onEditSubmit?: (messageId: number, content: string, mentions: number[]) => void | Promise<void>;
  /** Leave edit mode without saving (✕ button / Escape). */
  onCancelEdit?: () => void;
  /**
   * When set, the composer is in reply mode: a quote banner sits above the input;
   * the next send carries this message's id as its reply target. Mutually
   * exclusive with `editing` (the parent clears one when entering the other).
   */
  replyingTo?: MessageDTO | null;
  /** Leave reply mode without sending (✕ button / Escape). */
  onCancelReply?: () => void;
}

/** One-line preview of the quoted message for the reply banner. */
function replyPreview(m: MessageDTO): string {
  if (m.content.length > 0) return m.content;
  if (m.attachments.length > 0) return '📎 Attachment';
  return '';
}

/** Open autocomplete state: where the `@` began, its end (caret), the matches, and the highlighted row. */
interface MentionState {
  start: number;
  end: number;
  candidates: UserDTO[];
  highlight: number;
}

/** Emit the "typing" signal at most once per this window while the user types. */
const TYPING_THROTTLE_MS = 2000;

/** Auto-grow the textarea up to this many pixels (~5 lines), then scroll inside. */
const MAX_TEXTAREA_HEIGHT = 128;

/** localStorage key holding the unsent draft for a chat. */
function draftKey(chatId: number): string {
  return `draft:chat:${chatId}`;
}

/** Read a chat's saved draft (or '' when none / storage is unavailable). */
function loadDraft(chatId: number): string {
  try {
    return localStorage.getItem(draftKey(chatId)) ?? '';
  } catch {
    return '';
  }
}

/** Persist a chat's draft; an empty/blank value removes the key. Storage errors
 *  (private mode, quota) are swallowed — a lost draft must never break sending. */
function saveDraft(chatId: number, value: string): void {
  try {
    if (value.trim().length === 0) localStorage.removeItem(draftKey(chatId));
    else localStorage.setItem(draftKey(chatId), value);
  } catch {
    // ignore
  }
}

/** Drop a chat's draft entirely (on successful send). */
function clearDraft(chatId: number): void {
  try {
    localStorage.removeItem(draftKey(chatId));
  } catch {
    // ignore
  }
}

type PendingStatus = 'uploading' | 'done' | 'error';

/** A file the user picked, tracked from upload through send. */
interface PendingAttachment {
  localId: string;
  file: File;
  /** Object URL for image previews; null for non-image files. */
  previewUrl: string | null;
  status: PendingStatus;
  /** Upload progress 0..1. */
  progress: number;
  /** Whether HD (original quality) was on when this file was picked. */
  hd: boolean;
  attachment?: AttachmentDTO;
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
      <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.39 1.19L4.1 11.5 12 12l-7.9.5-2.09 6.71a1 1 0 0 0 1.39 1.19z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.49-8.49"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** One tile in the preview strip: image thumbnail or file chip, with progress/error/remove. */
function PendingTile({
  item,
  onRemove,
  onRetry,
}: {
  item: PendingAttachment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const uploading = item.status === 'uploading';
  const error = item.status === 'error';
  const percent = Math.round(item.progress * 100);
  const errorRing = error ? 'border-2 border-red-500' : 'border border-gray-200 dark:border-gray-700';

  const inner = item.previewUrl ? (
    <img src={item.previewUrl} alt={item.file.name} className="h-16 w-16 rounded-lg object-cover" />
  ) : (
    <div className="flex h-16 w-28 items-center gap-2 rounded-lg bg-gray-100 px-2 dark:bg-gray-700">
      <FileIcon />
      <span className="min-w-0 truncate text-xs text-gray-700 dark:text-gray-200">{item.file.name}</span>
    </div>
  );

  return (
    <div className={`relative flex-shrink-0 overflow-hidden rounded-lg ${errorRing}`}>
      {error ? (
        <button
          type="button"
          onClick={onRetry}
          aria-label={`Retry upload of ${item.file.name}`}
          className="block"
        >
          {inner}
          <span className="absolute inset-0 flex items-center justify-center bg-red-500/20 text-[10px] font-semibold text-red-700 dark:text-red-300">
            Retry
          </span>
        </button>
      ) : (
        inner
      )}

      {uploading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs font-semibold text-white">
          {percent}%
        </div>
      )}

      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${item.file.name}`}
        className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
      >
        <RemoveIcon />
      </button>
    </div>
  );
}

/** Sticky bottom composer: attachment button + HD toggle, rounded input, and a
 *  circular blue send button, with an @mention autocomplete panel that floats
 *  above the input while typing and a preview strip for pending attachments. */
export default function Composer({
  onSend,
  disabled = false,
  members,
  meId,
  chatId,
  editing = null,
  onEditSubmit,
  onCancelEdit,
  replyingTo = null,
  onCancelReply,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [mention, setMention] = useState<MentionState | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [hd, setHd] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Members the user explicitly selected; reconciled against the final text on
  // send (they may have deleted a mention) via extractMentions.
  const picked = useRef<MentionCandidate[]>([]);
  // Mirror of `pending` for unmount cleanup (revoke object URLs).
  const pendingRef = useRef<PendingAttachment[]>([]);
  pendingRef.current = pending;
  // Mirror of `text` so the failed-send restore can read the latest value
  // (which may include typing that landed while the send was in flight).
  const textRef = useRef(text);
  textRef.current = text;
  // Throttle for the outgoing "typing" signal — at most one emit per window.
  const lastTypingEmit = useRef(0);

  const isEditing = editing !== null;
  const editingId = editing?.id ?? null;
  // Reply mode is mutually exclusive with edit mode (enforced by the parent).
  const isReplying = !isEditing && replyingTo !== null;
  const replyingToId = replyingTo?.id ?? null;

  const trimmed = text.trim();
  const uploading = pending.some((p) => p.status === 'uploading');
  const doneCount = pending.filter((p) => p.status === 'done' && p.attachment).length;
  const canSend = isEditing
    ? trimmed.length > 0 && !disabled
    : (trimmed.length > 0 || doneCount > 0) && !uploading && !disabled;

  const mentionPool = useMemo(() => members.filter((m) => m.id !== meId), [members, meId]);

  // Entering edit mode prefills the input with the message text and focuses it;
  // leaving edit mode restores whatever draft was in flight before (the edit text
  // is transient and is never saved as a draft). Keyed on the message id so
  // switching between two edits re-prefills.
  useEffect(() => {
    if (editing) {
      setText(editing.content);
      setMention(null);
      picked.current = [];
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } else {
      setText(loadDraft(chatId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // Restore the saved draft when the chat changes (the composer may not remount
  // on chat switch). Skipped while editing — the edit text owns the input then.
  useEffect(() => {
    if (editing) return;
    setText(loadDraft(chatId));
    setMention(null);
    picked.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Auto-grow the textarea to fit its content, up to MAX_TEXTAREA_HEIGHT; reset
  // to a single row when cleared. (scrollHeight is 0 under jsdom — a no-op there.)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [text]);

  // Entering reply mode focuses the input (the text is left as-is so a half-typed
  // message survives; the quote banner shows what's being replied to).
  useEffect(() => {
    if (replyingToId !== null) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [replyingToId]);

  // Revoke any outstanding object URLs when the composer unmounts.
  useEffect(() => {
    return () => {
      for (const p of pendingRef.current) {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      }
    };
  }, []);

  /** Kick off (or restart) the compress-then-upload pipeline for one pending item. */
  function startUpload(item: PendingAttachment) {
    const patch = (changes: Partial<PendingAttachment>) =>
      setPending((prev) => prev.map((p) => (p.localId === item.localId ? { ...p, ...changes } : p)));

    void (async () => {
      try {
        let file = item.file;
        // Images: compress by default, unless HD was on when this file was picked.
        if (file.type.startsWith('image/') && !item.hd && shouldCompress(file)) {
          file = await compressImage(file);
        }
        const attachment = await uploadAttachment(chatId, file, (fraction) => {
          patch({ progress: fraction });
        });
        patch({ status: 'done', progress: 1, attachment });
      } catch {
        patch({ status: 'error' });
      }
    })();
  }

  /** Enqueue files (from the picker, a paste, or a drop) into the upload pipeline. */
  function addFiles(files: File[]) {
    const currentHd = hd;
    for (const file of files) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const isImage = file.type.startsWith('image/');
      const item: PendingAttachment = {
        localId,
        file,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
        status: 'uploading',
        progress: 0,
        hd: currentHd,
      };
      setPending((prev) => [...prev, item]);
      startUpload(item);
    }
  }

  function handleFilePick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-picking the same file later
    addFiles(files);
  }

  /** Route pasted clipboard files (e.g. a screenshot) into the attachment pipeline. */
  function handlePaste(e: ClipboardEvent<HTMLFormElement>) {
    if (isEditing) return; // attachments aren't editable
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return; // plain-text paste → let the textarea handle it
    e.preventDefault();
    addFiles(files);
  }

  /** Accept files dropped onto the composer, same path as the file picker. */
  function handleDrop(e: DragEvent<HTMLFormElement>) {
    if (isEditing) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  }

  /** Allow a drop by preventing the browser's default (open-file) handling. */
  function handleDragOver(e: DragEvent<HTMLFormElement>) {
    if (isEditing) return;
    e.preventDefault();
  }

  function removePending(localId: string) {
    setPending((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  }

  function retryPending(localId: string) {
    const target = pendingRef.current.find((p) => p.localId === localId);
    if (!target) return;
    const reset: PendingAttachment = { ...target, status: 'uploading', progress: 0 };
    setPending((prev) => prev.map((p) => (p.localId === localId ? reset : p)));
    startUpload(reset);
  }

  /** Persist the current composer text as this chat's draft. No-op in edit mode:
   *  the edited message text is transient and must not clobber the saved draft. */
  function persistDraft(value: string) {
    if (isEditing) return;
    saveDraft(chatId, value);
  }

  /** Signal that I'm typing in this chat — throttled, and only for non-empty text. */
  function emitTyping(value: string) {
    if (value.trim().length === 0) return;
    const now = Date.now();
    if (now - lastTypingEmit.current < TYPING_THROTTLE_MS) return;
    lastTypingEmit.current = now;
    getSocket().emit('typing', chatId);
  }

  /** Recompute the autocomplete from the input's current value + caret. */
  function refreshMention(value: string, caret: number) {
    const active = findActiveMentionQuery(value, caret);
    if (!active) {
      setMention(null);
      return;
    }
    const matches = filterCandidates(mentionPool, active.query);
    if (matches.length === 0) {
      setMention(null);
      return;
    }
    setMention({ start: active.start, end: caret, candidates: matches, highlight: 0 });
  }

  /** Insert the chosen member, record the pick, and restore focus/caret. */
  function selectMention(member: UserDTO) {
    if (!mention) return;
    const { text: newText, caret } = insertMention(text, mention.end, mention.start, member);
    setText(newText);
    persistDraft(newText);
    setMention(null);
    if (!picked.current.some((p) => p.id === member.id)) {
      picked.current = [...picked.current, { id: member.id, displayName: member.displayName }];
    }
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Escape priority when the mention dropdown is closed: cancel reply first,
    // then edit. (The dropdown, when open, is closed by the switch below.)
    if (e.key === 'Escape' && !mention) {
      if (isReplying) {
        e.preventDefault();
        onCancelReply?.();
        return;
      }
      if (isEditing) {
        e.preventDefault();
        onCancelEdit?.();
        return;
      }
    }
    // Send shortcuts: plain Enter inserts a newline (textarea default); Shift+Enter,
    // Ctrl+Enter, or Cmd+Enter send. Only while the dropdown is closed — otherwise
    // Enter selects the highlighted mention candidate (handled in the switch below).
    if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey) && !mention) {
      e.preventDefault();
      void submit();
      return;
    }
    if (!mention) return; // dropdown closed → let the textarea handle Enter, etc.
    const { candidates, highlight } = mention;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setMention({ ...mention, highlight: (highlight + 1) % candidates.length });
        break;
      case 'ArrowUp':
        e.preventDefault();
        setMention({ ...mention, highlight: (highlight - 1 + candidates.length) % candidates.length });
        break;
      case 'Enter':
      case 'Tab': {
        // Enter must NOT submit while the dropdown is open — it selects instead.
        e.preventDefault();
        const chosen = candidates[highlight];
        if (chosen) selectMention(chosen);
        break;
      }
      case 'Escape':
        e.preventDefault();
        setMention(null);
        break;
      default:
        break;
    }
  }

  /** Put failed-send state back, but never clobber anything typed/picked since.
   *  The restored text becomes the draft again (a failed send was never sent). */
  function restoreAfterFailure(prevText: string, prevPicked: MentionCandidate[], prevPending: PendingAttachment[]) {
    const restored = textRef.current.length > 0 ? textRef.current : prevText;
    setText(restored);
    persistDraft(restored);
    if (picked.current.length === 0) picked.current = prevPicked;
    setPending((cur) => (cur.length > 0 ? cur : prevPending));
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void submit();
  }

  /** Send the message (or save the edit). Shared by the form's submit button and
   *  the Shift/Ctrl+Enter keyboard shortcuts. */
  async function submit() {
    if (!canSend) return;
    const content = trimmed;
    setSendError(null);

    // Edit mode: save the text (attachments aren't editable). Mentions are
    // rescanned from the edited text; the server re-filters to chat members.
    if (isEditing && editing) {
      const mentions = mentionsFromText(content, mentionPool);
      const prevText = text;
      setText('');
      setMention(null);
      picked.current = [];
      try {
        await onEditSubmit?.(editing.id, content, mentions);
      } catch (err) {
        restoreAfterFailure(prevText, [], []);
        setSendError(err instanceof Error ? err.message : 'Failed to save edit');
      }
      return;
    }

    const mentions = extractMentions(content, picked.current);
    const attachmentIds = pending
      .filter((p) => p.status === 'done' && p.attachment)
      .map((p) => p.attachment!.id);

    // Clear composer state optimistically so the next message can be typed while
    // the send is in flight. Preview URLs are NOT revoked yet — a failed send
    // restores `pending`, so the previews must stay alive until success.
    const prevText = text;
    const prevPicked = picked.current;
    const prevPending = pending;
    setText('');
    setMention(null);
    picked.current = [];
    setPending([]);
    clearDraft(chatId); // the draft is now on its way; a failure re-persists it

    try {
      await onSend(content, mentions, attachmentIds, replyingTo?.id);
    } catch (err) {
      restoreAfterFailure(prevText, prevPicked, prevPending);
      setSendError(err instanceof Error ? err.message : 'Failed to send');
      return;
    }
    for (const p of prevPending) {
      if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      className="relative flex flex-col gap-2 border-t border-gray-200 bg-white p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] dark:border-gray-700 dark:bg-gray-800"
    >
      {isEditing && (
        <div className="flex items-center justify-between rounded-lg bg-gray-100 px-3 py-1.5 text-sm text-gray-600 dark:bg-gray-700 dark:text-gray-300">
          <span className="font-medium">Editing message</span>
          <button
            type="button"
            aria-label="Cancel edit"
            onClick={() => onCancelEdit?.()}
            className="flex h-6 w-6 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-600"
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {isReplying && replyingTo && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-gray-100 px-3 py-1.5 text-sm dark:bg-gray-700">
          <span className="flex min-w-0 flex-col">
            <span className="font-medium text-gray-700 dark:text-gray-200">
              Replying to {replyingTo.sender.displayName}
            </span>
            <span className="truncate text-gray-500 dark:text-gray-400">{replyPreview(replyingTo)}</span>
          </span>
          <button
            type="button"
            aria-label="Cancel reply"
            onClick={() => onCancelReply?.()}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-600"
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {sendError && (
        <div
          role="alert"
          className="flex items-center justify-between rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"
        >
          <span className="min-w-0 truncate">{sendError}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setSendError(null)}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-red-500 transition-colors hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-500/20"
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {mention && (
        <ul
          role="listbox"
          aria-label="Mention suggestions"
          className="absolute bottom-full left-2 right-2 mb-2 max-h-60 overflow-y-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {mention.candidates.map((m, i) => (
            <li key={m.id} role="option" aria-selected={i === mention.highlight}>
              <button
                type="button"
                // Keep the input focused so the caret survives the click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectMention(m)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                  i === mention.highlight ? 'bg-gray-100 dark:bg-gray-700' : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                <Avatar name={m.displayName} id={m.id} size="sm" />
                <span className="min-w-0 truncate text-gray-900 dark:text-gray-100">{m.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Attachments to send">
          {pending.map((item) => (
            <PendingTile
              key={item.localId}
              item={item}
              onRemove={() => removePending(item.localId)}
              onRetry={() => retryPending(item.localId)}
            />
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* Attachments aren't editable, so the upload controls are hidden in edit mode. */}
        {!isEditing && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFilePick}
              data-testid="file-input"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              aria-label="Attach files"
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              <PaperclipIcon />
            </button>
            <button
              type="button"
              onClick={() => setHd((v) => !v)}
              aria-pressed={hd}
              title="Upload original quality"
              className={`flex h-8 flex-shrink-0 items-center justify-center rounded-full px-2 text-xs font-bold transition-colors ${
                hd ? 'bg-[#0084ff] text-white' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
              }`}
            >
              HD
            </button>
          </>
        )}

        <label htmlFor="composer-input" className="sr-only">
          Message
        </label>
        <textarea
          id="composer-input"
          ref={inputRef}
          rows={1}
          autoComplete="off"
          placeholder="Aa"
          value={text}
          onChange={(e) => {
            const value = e.target.value;
            setText(value);
            persistDraft(value);
            refreshMention(value, e.target.selectionStart ?? value.length);
            emitTyping(value);
          }}
          onKeyDown={handleKeyDown}
          onSelect={(e) => {
            const el = e.currentTarget;
            refreshMention(el.value, el.selectionStart ?? el.value.length);
          }}
          disabled={disabled}
          style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
          className="min-w-0 flex-1 resize-none overflow-y-auto rounded-2xl bg-gray-100 px-4 py-2.5 text-gray-900 focus:outline-none disabled:opacity-60 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-400"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label={isEditing ? 'Save edit' : 'Send'}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[#0084ff] text-white transition-opacity disabled:opacity-40"
        >
          {isEditing ? <CheckIcon /> : <SendIcon />}
        </button>
      </div>
    </form>
  );
}
