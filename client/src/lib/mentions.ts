// @mention logic for the composer and message rendering.
//
// Pure, framework-free, and unit-tested: detecting an in-progress mention,
// filtering candidates, inserting a chosen mention, reconciling which picks
// survived edits, and splitting a rendered message into text/mention segments.
// The composer wires these to a text input; ChatPage uses `splitByMentions`.

/** The minimum a candidate needs to be mentioned: an id and a display name. */
export type MentionCandidate = { id: number; displayName: string };

/** A rendered message chunk: plain text, or an `@name` bound to a member. */
export interface MentionSegment {
  text: string;
  mention?: MentionCandidate;
}

/** Autocomplete never shows more than this many rows. */
const MAX_CANDIDATES = 6;

/**
 * Detect an in-progress `@mention` at the caret. An active mention is an `@`
 * that sits at the start of the text or right after whitespace, with the caret
 * somewhere after it and no whitespace in between. Returns the partial query
 * (which may be `''` immediately after the `@`) and the index of the `@`, or
 * `null` when the caret is not inside a mention token.
 */
export function findActiveMentionQuery(
  text: string,
  caretPos: number,
): { query: string; start: number } | null {
  const pos = Math.max(0, Math.min(caretPos, text.length));
  for (let i = pos - 1; i >= 0; i--) {
    const ch = text.charAt(i);
    if (ch === '@') {
      const before = text.charAt(i - 1); // '' when i === 0
      if (i === 0 || /\s/.test(before)) {
        return { query: text.slice(i + 1, pos), start: i };
      }
      return null; // '@' glued to a non-space (e.g. an email) — not a mention
    }
    if (/\s/.test(ch)) return null; // whitespace before any '@' — not a mention
  }
  return null;
}

/**
 * Members whose display name matches `query`, case-insensitively. Prefix
 * matches rank ahead of mid-string (substring) matches; the result is capped at
 * six. An empty query returns everyone (still capped).
 */
export function filterCandidates<T extends MentionCandidate>(members: T[], query: string): T[] {
  const q = query.toLowerCase();
  if (q === '') return members.slice(0, MAX_CANDIDATES);

  const prefix: T[] = [];
  const substring: T[] = [];
  for (const m of members) {
    const name = m.displayName.toLowerCase();
    if (name.startsWith(q)) prefix.push(m);
    else if (name.includes(q)) substring.push(m);
  }
  return [...prefix, ...substring].slice(0, MAX_CANDIDATES);
}

/**
 * Replace the active `@query` (spanning `[start, caretPos)`) with
 * `@DisplayName ` (note the trailing space) and report the caret position that
 * lands just after the inserted space.
 */
export function insertMention(
  text: string,
  caretPos: number,
  start: number,
  member: MentionCandidate,
): { text: string; caret: number } {
  const insertion = `@${member.displayName} `;
  const newText = text.slice(0, start) + insertion + text.slice(caretPos);
  return { text: newText, caret: start + insertion.length };
}

/**
 * From the mentions the user actually picked, keep only those whose exact
 * `@DisplayName` substring still exists in the final text — the user may have
 * deleted a mention after inserting it — and dedupe by id, preserving order.
 */
export function extractMentions(text: string, trackedMentions: MentionCandidate[]): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const m of trackedMentions) {
    if (seen.has(m.id)) continue;
    if (text.includes(`@${m.displayName}`)) {
      ids.push(m.id);
      seen.add(m.id);
    }
  }
  return ids;
}

/**
 * Split a message into text/mention segments for rendering. Only the message's
 * ACTUAL mention ids are considered, and longer display names are matched first
 * so a prefix name (`@Al`) never shadows a longer one (`@Alice`).
 */
export function splitByMentions(
  content: string,
  members: MentionCandidate[],
  mentionIds: number[],
): MentionSegment[] {
  const idSet = new Set(mentionIds);
  const tokens = members
    .filter((m) => idSet.has(m.id))
    .sort((a, b) => b.displayName.length - a.displayName.length);

  if (tokens.length === 0) return content ? [{ text: content }] : [];

  const segments: MentionSegment[] = [];
  let buffer = '';
  let i = 0;
  while (i < content.length) {
    const ch = content.charAt(i);
    if (ch === '@') {
      const match = tokens.find((t) => content.startsWith(`@${t.displayName}`, i));
      if (match) {
        if (buffer) {
          segments.push({ text: buffer });
          buffer = '';
        }
        segments.push({ text: `@${match.displayName}`, mention: match });
        i += match.displayName.length + 1;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  if (buffer) segments.push({ text: buffer });
  return segments;
}
