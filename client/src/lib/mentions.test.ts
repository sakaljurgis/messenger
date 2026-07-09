import { describe, expect, it } from 'vitest';
import {
  extractMentions,
  filterCandidates,
  findActiveMentionQuery,
  insertMention,
  splitByMentions,
  type MentionCandidate,
} from './mentions';

const alice: MentionCandidate = { id: 2, displayName: 'Alice' };
const al: MentionCandidate = { id: 5, displayName: 'Al' };
const bob: MentionCandidate = { id: 3, displayName: 'Bob' };

describe('findActiveMentionQuery', () => {
  it('detects an @ at the start of the text', () => {
    expect(findActiveMentionQuery('@ali', 4)).toEqual({ query: 'ali', start: 0 });
  });

  it('detects an @ mid-text after a space', () => {
    expect(findActiveMentionQuery('hi @ali', 7)).toEqual({ query: 'ali', start: 3 });
  });

  it('returns null when the @ follows a non-space character', () => {
    expect(findActiveMentionQuery('hi@ali', 6)).toBeNull();
  });

  it('returns null when the caret sits inside a plain word after a completed mention', () => {
    // '@alice world' with the caret inside 'world' — whitespace precedes it.
    expect(findActiveMentionQuery('@alice world', 9)).toBeNull();
  });

  it('returns an empty query immediately after the @', () => {
    expect(findActiveMentionQuery('hi @', 4)).toEqual({ query: '', start: 3 });
  });
});

describe('filterCandidates', () => {
  const members = [alice, al, bob];

  it('returns everyone (capped) for an empty query', () => {
    expect(filterCandidates(members, '')).toEqual([alice, al, bob]);
  });

  it('matches case-insensitively, ranking prefix matches before substrings', () => {
    // 'o' is a prefix of nobody but a substring of Bob — substring rank.
    expect(filterCandidates(members, 'AL')).toEqual([alice, al]);
    expect(filterCandidates(members, 'o')).toEqual([bob]);
  });

  it('caps the result at six', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: i, displayName: `User${i}` }));
    expect(filterCandidates(many, 'user')).toHaveLength(6);
  });
});

describe('insertMention', () => {
  it('replaces @query with @DisplayName and a trailing space, and reports the caret', () => {
    const { text, caret } = insertMention('hi @al', 6, 3, alice);
    expect(text).toBe('hi @Alice ');
    expect(caret).toBe('hi @Alice '.length); // 10, just past the trailing space
  });

  it('keeps text that follows the query intact', () => {
    const { text, caret } = insertMention('@al!', 3, 0, alice);
    expect(text).toBe('@Alice !');
    expect(caret).toBe('@Alice '.length); // 7
  });
});

describe('extractMentions', () => {
  it('keeps only picks whose @DisplayName still exists in the text', () => {
    expect(extractMentions('hey @Alice how are you', [alice, bob])).toEqual([2]);
  });

  it('drops a pick whose mention was deleted', () => {
    expect(extractMentions('hey how are you', [alice])).toEqual([]);
  });

  it('dedupes repeated picks of the same member', () => {
    expect(extractMentions('@Alice and @Alice', [alice, alice])).toEqual([2]);
  });
});

describe('splitByMentions', () => {
  it('returns a single text segment when there are no mentions', () => {
    expect(splitByMentions('plain text', [alice], [])).toEqual([{ text: 'plain text' }]);
  });

  it('matches the longest display name first to avoid prefix collisions', () => {
    // Both 'Al' and 'Alice' are mentioned; '@Alice' must win over '@Al'.
    const segments = splitByMentions('@Alice hi', [al, alice], [al.id, alice.id]);
    expect(segments).toEqual([{ text: '@Alice', mention: alice }, { text: ' hi' }]);
  });

  it('only treats the message’s actual mention ids as mentions', () => {
    // '@Al' is present but not in the id list, so it stays plain text.
    const segments = splitByMentions('@Al @Alice', [al, alice], [alice.id]);
    expect(segments).toEqual([{ text: '@Al ' }, { text: '@Alice', mention: alice }]);
  });
});
