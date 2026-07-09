import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { UserDTO } from '@messenger/shared';
import Avatar from './Avatar';
import {
  extractMentions,
  filterCandidates,
  findActiveMentionQuery,
  insertMention,
  type MentionCandidate,
} from '../lib/mentions';

interface ComposerProps {
  /** Called with the trimmed message text and the ids the user @-mentioned. */
  onSend: (content: string, mentions: number[]) => void | Promise<void>;
  disabled?: boolean;
  /** All members of the chat; the autocomplete offers everyone except me. */
  members: UserDTO[];
  meId: number;
}

/** Open autocomplete state: where the `@` began, its end (caret), the matches, and the highlighted row. */
interface MentionState {
  start: number;
  end: number;
  candidates: UserDTO[];
  highlight: number;
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
      <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.39 1.19L4.1 11.5 12 12l-7.9.5-2.09 6.71a1 1 0 0 0 1.39 1.19z" />
    </svg>
  );
}

/** Sticky bottom composer: rounded input + circular blue send button, with an
 *  @mention autocomplete panel that floats above the input while typing. */
export default function Composer({ onSend, disabled = false, members, meId }: ComposerProps) {
  const [text, setText] = useState('');
  const [mention, setMention] = useState<MentionState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Members the user explicitly selected; reconciled against the final text on
  // send (they may have deleted a mention) via extractMentions.
  const picked = useRef<MentionCandidate[]>([]);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !disabled;

  const mentionPool = useMemo(() => members.filter((m) => m.id !== meId), [members, meId]);

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

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!mention) return; // dropdown closed → let the form handle Enter, etc.
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

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSend) return;
    const content = trimmed;
    const mentions = extractMentions(content, picked.current);
    setText('');
    setMention(null);
    picked.current = [];
    await onSend(content, mentions);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="relative flex items-center gap-2 border-t border-gray-200 bg-white p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
    >
      {mention && (
        <ul
          role="listbox"
          aria-label="Mention suggestions"
          className="absolute bottom-full left-2 right-2 mb-2 max-h-60 overflow-y-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg"
        >
          {mention.candidates.map((m, i) => (
            <li key={m.id} role="option" aria-selected={i === mention.highlight}>
              <button
                type="button"
                // Keep the input focused so the caret survives the click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectMention(m)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                  i === mention.highlight ? 'bg-gray-100' : 'hover:bg-gray-50'
                }`}
              >
                <Avatar name={m.displayName} id={m.id} size="sm" />
                <span className="min-w-0 truncate text-gray-900">{m.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <label htmlFor="composer-input" className="sr-only">
        Message
      </label>
      <input
        id="composer-input"
        ref={inputRef}
        type="text"
        autoComplete="off"
        placeholder="Aa"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={handleKeyDown}
        onSelect={(e) => {
          const el = e.currentTarget;
          refreshMention(el.value, el.selectionStart ?? el.value.length);
        }}
        disabled={disabled}
        className="min-w-0 flex-1 rounded-full bg-gray-100 px-4 py-2.5 text-gray-900 focus:outline-none disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={!canSend}
        aria-label="Send"
        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[#0084ff] text-white transition-opacity disabled:opacity-40"
      >
        <SendIcon />
      </button>
    </form>
  );
}
