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
import type {
  AttachmentDTO,
  MessageDTO,
  ScheduleMessageRequest,
  ScheduledMessageDTO,
  UserDTO,
} from '@messenger/shared';
import Avatar from './Avatar';
import { apiDelete, apiGet, apiPost } from '../lib/api';
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
  /**
   * Implicit reply target attached to every send (and scheduled send) when the
   * user hasn't picked one via `replyingTo`. No banner shows for it. Used by
   * the thread overlay's composer, where each message replies to the thread
   * root so it joins the thread.
   */
  fixedReplyToId?: number;
  /**
   * Extra localStorage draft-key scope so a second composer on the SAME chat
   * (the thread overlay) keeps its own draft instead of stomping the main one.
   */
  draftScope?: string;
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

/** localStorage key holding the unsent draft for a chat (scope: see draftScope prop). */
function draftKey(chatId: number, scope?: string): string {
  return scope ? `draft:chat:${chatId}:${scope}` : `draft:chat:${chatId}`;
}

/** Read a chat's saved draft (or '' when none / storage is unavailable). */
function loadDraft(chatId: number, scope?: string): string {
  try {
    return localStorage.getItem(draftKey(chatId, scope)) ?? '';
  } catch {
    return '';
  }
}

/** Persist a chat's draft; an empty/blank value removes the key. Storage errors
 *  (private mode, quota) are swallowed — a lost draft must never break sending. */
function saveDraft(chatId: number, value: string, scope?: string): void {
  try {
    if (value.trim().length === 0) localStorage.removeItem(draftKey(chatId, scope));
    else localStorage.setItem(draftKey(chatId, scope), value);
  } catch {
    // ignore
  }
}

/** Drop a chat's draft entirely (on successful send). */
function clearDraft(chatId: number, scope?: string): void {
  try {
    localStorage.removeItem(draftKey(chatId, scope));
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

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3.5 2" />
    </svg>
  );
}

/** Compact human label for a scheduled time (e.g. "Mon 08:00 PM"). */
function formatScheduleTime(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Today at 20:00, or tomorrow at 20:00 if 20:00 has already passed. */
function eveningTarget(): Date {
  const d = new Date(Date.now());
  d.setHours(20, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

/** Tomorrow at 09:00. */
function tomorrowMorningTarget(): Date {
  const d = new Date(Date.now());
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/**
 * MediaRecorder mimeTypes to try, in order. webm/opus is what Chrome/Firefox
 * record; iOS Safari's MediaRecorder supports NONE of the webm variants and
 * falls through to audio/mp4 (AAC). The first `isTypeSupported` hit wins; a
 * browser with MediaRecorder but no match records in its default format.
 */
const AUDIO_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

/** The first MediaRecorder-supported audio mime, or undefined (use the default). */
function pickAudioMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  return AUDIO_MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
}

/** File extension for a recorded-audio mime (parameters ignored). */
function audioExtForMime(mime: string): string {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  if (base === 'audio/mp4') return 'm4a';
  if (base === 'audio/mpeg') return 'mp3';
  if (base === 'audio/ogg') return 'oga';
  return 'webm'; // audio/webm and any unknown default
}

/** `m:ss` elapsed-time label for the recording indicator. */
function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
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

/** Sticky bottom composer, two rows: a full-width rounded input on top, and a
 *  controls row below it (attach/mic/HD/schedule left, circular blue send
 *  right), with an @mention autocomplete panel that floats above the input
 *  while typing and a preview strip for pending attachments. */
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
  fixedReplyToId,
  draftScope,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [mention, setMention] = useState<MentionState | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [hd, setHd] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Send-later ("schedule") UI. `scheduleOpen` toggles the quick-pick popover;
  // `scheduleCustom` holds the datetime-local value; `scheduledNotice` is the
  // brief "Scheduled for …" confirmation (auto-hidden). `scheduled` is MY pending
  // queue for this chat (fetched on mount/chat change), expandable to cancel rows.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleCustom, setScheduleCustom] = useState('');
  const [scheduledNotice, setScheduledNotice] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<ScheduledMessageDTO[]>([]);
  const [scheduledExpanded, setScheduledExpanded] = useState(false);
  const noticeTimerRef = useRef<number | null>(null);
  // Voice recording. `recording` drives the recording-bar UI; `recordSeconds`
  // ticks the elapsed-time label. The MediaRecorder/stream/chunks live in refs
  // (never in render state) so unmount/chat-switch cleanup can reach them.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordMimeRef = useRef<string>('audio/webm');
  const recordTimerRef = useRef<number | null>(null);
  // Set by cancel so the recorder's async `onstop` discards instead of enqueuing.
  const recordCanceledRef = useRef(false);
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

  // Send-later is offered only for a non-empty, non-editing text message. The
  // scheduled queue is text-only server-side (attachments can't be scheduled),
  // so with files staged the clock is shown DISABLED with an explanatory title
  // rather than silently dropping the attachments.
  const showSchedule = !isEditing && trimmed.length > 0;
  const scheduleDisabled = disabled || pending.length > 0;

  // Voice recording needs both getUserMedia and MediaRecorder; when either is
  // missing (older/locked-down browsers, jsdom) the mic button is hidden
  // outright. Computed each render so a test stubbing the globals is picked up.
  const recordingSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined';

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
      setText(loadDraft(chatId, draftScope));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // Restore the saved draft when the chat changes (the composer may not remount
  // on chat switch). Skipped while editing — the edit text owns the input then.
  useEffect(() => {
    if (editing) return;
    setText(loadDraft(chatId, draftScope));
    setMention(null);
    picked.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Drop anything staged for the PREVIOUS chat whenever the chat changes: files
  // picked but not sent belong to that chat, not the new one, and must never
  // ride along into it. Unlike the draft-restore effect above this is NOT
  // gated on `editing` — attachments/errors are orthogonal to which chat owns
  // the text field, so they're cleared regardless of edit mode. Harmless on
  // mount, since `pending`/`sendError` both start out empty then.
  //
  // Object URLs are revoked via the same map-then-revoke path removePending
  // uses, so nothing leaks. Because startUpload's `patch` locates its target
  // by `localId` via `prev.map(...)`, an upload that finishes AFTER this
  // clears `pending` to `[]` finds no match (map over `[]` — or over a fresh
  // array of the new chat's own items — never contains the old localId) and
  // is silently dropped instead of resurrecting a tile.
  useEffect(() => {
    setPending((prev) => {
      for (const p of prev) {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      }
      return [];
    });
    setSendError(null);
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

  // Abort any in-progress recording — and release the mic — on chat switch or
  // unmount. A capture belongs to the chat it was started in; letting it ride
  // into the next chat (or linger after the composer is gone) would be wrong,
  // and a dangling mic track keeps the OS "recording" indicator lit. teardown
  // reads refs so the (possibly stale) closure still sees the live recorder.
  useEffect(() => {
    return () => {
      teardownRecording();
      setRecording(false);
      setRecordSeconds(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Load MY pending scheduled messages for this chat on mount / chat switch. The
  // popover, expanded list, and confirmation notice all reset for the new chat.
  // Failures are non-critical (the queue is a convenience) and swallowed.
  useEffect(() => {
    let ignore = false;
    setScheduled([]);
    setScheduleOpen(false);
    setScheduleCustom('');
    setScheduledExpanded(false);
    setScheduledNotice(null);
    apiGet<{ scheduled: ScheduledMessageDTO[] }>(`/api/chats/${chatId}/scheduled`)
      .then((res) => {
        if (!ignore) setScheduled(res.scheduled);
      })
      .catch(() => {
        // ignore — a missing queue must never break composing
      });
    return () => {
      ignore = true;
    };
  }, [chatId]);

  // Clear the auto-hide timer for the "Scheduled for …" notice on unmount.
  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  /** Show the transient "Scheduled for …" confirmation, auto-hiding after ~3s. */
  function showScheduledNotice(message: string) {
    setScheduledNotice(message);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setScheduledNotice(null), 3000);
  }

  /** Re-pull the pending queue after a schedule/cancel (keeps the count honest). */
  async function refreshScheduled() {
    try {
      const res = await apiGet<{ scheduled: ScheduledMessageDTO[] }>(
        `/api/chats/${chatId}/scheduled`,
      );
      setScheduled(res.scheduled);
    } catch {
      // ignore
    }
  }

  /**
   * Queue the current composer content to send at `when`. On success the composer
   * clears exactly like a live send (text/mention/draft) and a confirmation shows;
   * on rejection the content is retained and the error surfaces in the banner.
   */
  async function scheduleFor(when: Date) {
    if (isEditing) return;
    const content = trimmed;
    if (content.length === 0 || pending.length > 0) return;

    setScheduleOpen(false);
    setScheduleCustom('');
    setSendError(null);

    const body: ScheduleMessageRequest = {
      content,
      mentions: extractMentions(content, picked.current),
      scheduledAt: when.toISOString(),
    };
    const scheduleReplyTo = replyingTo?.id ?? fixedReplyToId;
    if (scheduleReplyTo) body.replyToId = scheduleReplyTo;

    try {
      await apiPost(`/api/chats/${chatId}/scheduled`, body);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to schedule message');
      return;
    }

    // Clear the composer the same way a successful send does (no attachments here).
    setText('');
    setMention(null);
    picked.current = [];
    clearDraft(chatId, draftScope);
    onCancelReply?.();
    showScheduledNotice(`Scheduled for ${formatScheduleTime(when)}`);
    void refreshScheduled();
  }

  /** Confirm the custom datetime-local pick (ignored if empty/unparseable). */
  function confirmCustomSchedule() {
    if (!scheduleCustom) return;
    const when = new Date(scheduleCustom);
    if (Number.isNaN(when.getTime())) return;
    void scheduleFor(when);
  }

  /** Cancel one pending scheduled message (optimistically removed on success). */
  async function cancelScheduled(id: number) {
    try {
      await apiDelete(`/api/chats/${chatId}/scheduled/${id}`);
      setScheduled((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to cancel scheduled message');
    }
  }

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

  /** Stop and release the mic tracks (kills the OS "recording" indicator). */
  function stopStream() {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
  }

  /** Halt the elapsed-time ticker. */
  function clearRecordTimer() {
    if (recordTimerRef.current !== null) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  }

  /**
   * Tear down any in-progress recording WITHOUT enqueuing a file — used on
   * chat switch and unmount. Detaches the recorder's handlers first so its
   * async `onstop` can't fire setState into a gone/!current component, then
   * stops the mic and drops the buffered chunks.
   */
  function teardownRecording() {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // ignore — some browsers throw if already stopping
        }
      }
      recorderRef.current = null;
    }
    stopStream();
    chunksRef.current = [];
    clearRecordTimer();
  }

  /** Begin recording a voice note (getUserMedia → MediaRecorder). */
  async function startRecording() {
    if (recording || recorderRef.current) return;
    setSendError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setSendError('Microphone access was denied');
      return;
    }
    streamRef.current = stream;
    recordCanceledRef.current = false;
    chunksRef.current = [];

    const mimeType = pickAudioMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorderRef.current = recorder;
    // Prefer the recorder's negotiated mime; fall back to what we asked for.
    recordMimeRef.current = recorder.mimeType || mimeType || 'audio/webm';

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const canceled = recordCanceledRef.current;
      const chunks = chunksRef.current;
      const baseMime = recordMimeRef.current.split(';')[0]!.trim().toLowerCase() || 'audio/webm';
      const blob = new Blob(chunks, { type: baseMime });
      recorderRef.current = null;
      chunksRef.current = [];
      stopStream();
      clearRecordTimer();
      setRecording(false);
      if (canceled || blob.size === 0) return;
      const file = new File([blob], `voice-${Date.now()}.${audioExtForMime(baseMime)}`, {
        type: baseMime,
      });
      addFiles([file]);
    };

    recorder.start();
    setRecording(true);
    setRecordSeconds(0);
    recordTimerRef.current = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
  }

  /** Finish recording; the captured blob flows into the upload pipeline. */
  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  /** Abort recording and discard the capture (nothing is enqueued). */
  function cancelRecording() {
    recordCanceledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop(); // onstop sees `canceled` and drops the blob
    } else {
      teardownRecording();
      setRecording(false);
    }
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
    saveDraft(chatId, value, draftScope);
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
    clearDraft(chatId, draftScope); // the draft is now on its way; a failure re-persists it

    try {
      await onSend(content, mentions, attachmentIds, replyingTo?.id ?? fixedReplyToId);
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

      {scheduledNotice && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-1.5 text-sm text-green-700 dark:bg-green-500/10 dark:text-green-300"
        >
          <ClockIcon />
          <span className="min-w-0 truncate">{scheduledNotice}</span>
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

      {scheduled.length > 0 && (
        <div className="flex flex-col rounded-lg bg-gray-100 text-sm dark:bg-gray-700">
          <button
            type="button"
            onClick={() => setScheduledExpanded((v) => !v)}
            aria-expanded={scheduledExpanded}
            className="flex items-center gap-2 px-3 py-1.5 text-left font-medium text-gray-600 dark:text-gray-300"
          >
            <ClockIcon />
            <span className="flex-1">
              {scheduled.length} scheduled message{scheduled.length === 1 ? '' : 's'}
            </span>
            <span className="text-xs text-gray-400">{scheduledExpanded ? 'Hide' : 'Show'}</span>
          </button>
          {scheduledExpanded && (
            <ul aria-label="Scheduled messages" className="border-t border-gray-200 dark:border-gray-600">
              {scheduled.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="w-24 flex-shrink-0 text-xs text-gray-500 dark:text-gray-400">
                    {formatScheduleTime(new Date(s.scheduledAt))}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
                    {s.content}
                  </span>
                  <button
                    type="button"
                    onClick={() => void cancelScheduled(s.id)}
                    aria-label={`Cancel scheduled message: ${s.content}`}
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-600"
                  >
                    <RemoveIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {scheduleOpen && (
        <div
          role="dialog"
          aria-label="Schedule message"
          className="absolute bottom-full right-2 mb-2 w-60 rounded-xl border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => void scheduleFor(new Date(Date.now() + 60 * 60 * 1000))}
              className="rounded-lg px-3 py-2 text-left text-sm text-gray-900 transition-colors hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              In 1 hour
            </button>
            <button
              type="button"
              onClick={() => void scheduleFor(eveningTarget())}
              className="rounded-lg px-3 py-2 text-left text-sm text-gray-900 transition-colors hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              {eveningTarget().toDateString() === new Date(Date.now()).toDateString()
                ? 'This evening, 20:00'
                : 'Tomorrow, 20:00'}
            </button>
            <button
              type="button"
              onClick={() => void scheduleFor(tomorrowMorningTarget())}
              className="rounded-lg px-3 py-2 text-left text-sm text-gray-900 transition-colors hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              Tomorrow, 09:00
            </button>
          </div>
          <div className="mt-2 flex items-center gap-1 border-t border-gray-200 pt-2 dark:border-gray-700">
            <input
              type="datetime-local"
              aria-label="Custom schedule time"
              value={scheduleCustom}
              onChange={(e) => setScheduleCustom(e.target.value)}
              className="min-w-0 flex-1 rounded-lg bg-gray-100 px-2 py-1.5 text-sm text-gray-900 focus:outline-none dark:bg-gray-700 dark:text-gray-100"
            />
            <button
              type="button"
              onClick={confirmCustomSchedule}
              disabled={!scheduleCustom}
              className="flex-shrink-0 rounded-lg bg-[#0084ff] px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-40"
            >
              Set
            </button>
          </div>
        </div>
      )}

      {recording ? (
        <div className="flex items-center gap-2" data-testid="recording-bar">
          <span
            className="flex h-2.5 w-2.5 flex-shrink-0 animate-pulse rounded-full bg-red-500"
            aria-hidden="true"
          />
          <span
            role="timer"
            aria-label="Recording"
            className="flex-1 text-sm font-medium text-gray-700 dark:text-gray-200"
          >
            Recording {formatDuration(recordSeconds)}
          </span>
          <button
            type="button"
            onClick={cancelRecording}
            aria-label="Cancel recording"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          >
            <CloseIcon />
          </button>
          <button
            type="button"
            onClick={stopRecording}
            aria-label="Stop recording"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[#0084ff] text-white transition-opacity"
          >
            <StopIcon />
          </button>
        </div>
      ) : (
      <>
        {/* Two-row layout: the textarea gets the full composer width (long
            messages stay readable), with every control on its own row below —
            utilities on the left, send on the right. */}
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
          className="w-full resize-none overflow-y-auto rounded-2xl bg-gray-100 px-4 py-2.5 text-gray-900 focus:outline-none disabled:opacity-60 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-400"
        />
        <div className="flex items-center gap-1">
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
              {recordingSupported && (
                <button
                  type="button"
                  onClick={() => void startRecording()}
                  disabled={disabled}
                  aria-label="Record voice message"
                  className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-700"
                >
                  <MicIcon />
                </button>
              )}
              <button
                type="button"
                onClick={() => setHd((v) => !v)}
                aria-pressed={hd}
                title="Upload original quality"
                // Same h-10 footprint as every other control in this row — a
                // shorter pill would sit visibly off the shared centerline.
                className={`flex h-10 min-w-10 flex-shrink-0 items-center justify-center rounded-full px-2.5 text-xs font-bold transition-colors ${
                  hd ? 'bg-[#0084ff] text-white' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                }`}
              >
                HD
              </button>
            </>
          )}
          {showSchedule && (
            <button
              type="button"
              onClick={() => setScheduleOpen((v) => !v)}
              disabled={scheduleDisabled}
              aria-label="Schedule message"
              aria-expanded={scheduleOpen}
              title={
                pending.length > 0
                  ? "Attachments can't be scheduled — send them with the message instead"
                  : 'Schedule for later'
              }
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              <ClockIcon />
            </button>
          )}
          <button
            type="submit"
            disabled={!canSend}
            aria-label={isEditing ? 'Save edit' : 'Send'}
            className="ml-auto flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[#0084ff] text-white transition-opacity disabled:opacity-40"
          >
            {isEditing ? <CheckIcon /> : <SendIcon />}
          </button>
        </div>
      </>
      )}
    </form>
  );
}
