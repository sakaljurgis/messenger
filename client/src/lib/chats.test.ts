import { describe, expect, it } from 'vitest';
import type { ChatMemberDTO, ChatSummaryDTO, MessageDTO, UserDTO } from '@messenger/shared';
import {
  chatInitials,
  chatTitle,
  firstUnreadMessageId,
  highlightSegments,
  mergeMessages,
  readPositions,
  replaceMessage,
  searchSnippet,
  searchTerms,
  tombstone,
  upsertChat,
} from './chats';

const ann: ChatMemberDTO = {
  id: 1,
  email: 'ann@example.com',
  displayName: 'Ann Smith',
  isBot: false,
  lastReadMessageId: 0,
};
const bob: ChatMemberDTO = {
  id: 2,
  email: 'bob@example.com',
  displayName: 'Bob',
  isBot: false,
  lastReadMessageId: 0,
};
const carol: ChatMemberDTO = {
  id: 3,
  email: 'carol@example.com',
  displayName: 'Carol',
  isBot: false,
  lastReadMessageId: 0,
};

function msg(id: number, sender: UserDTO, content: string): MessageDTO {
  return {
    id,
    chatId: 1,
    sender,
    content,
    mentions: [],
    attachments: [],
    reactions: [],
    replyTo: null,
    createdAt: new Date(1_700_000_000_000 + id * 1000).toISOString(),
    editedAt: null,
    isDeleted: false,
  };
}

describe('chatTitle', () => {
  it('returns the other member for a DM (never me)', () => {
    const dm: ChatSummaryDTO = {
      id: 1,
      type: 'dm',
      name: null,
      members: [ann, bob],
      lastMessage: null,
      unreadCount: 0,
    };
    expect(chatTitle(dm, ann.id)).toBe('Bob');
    expect(chatTitle(dm, bob.id)).toBe('Ann Smith');
  });

  it('returns the group name for a group', () => {
    const group: ChatSummaryDTO = {
      id: 2,
      type: 'group',
      name: 'Team Rocket',
      members: [ann, bob, carol],
      lastMessage: null,
      unreadCount: 0,
    };
    expect(chatTitle(group, ann.id)).toBe('Team Rocket');
  });

  it('titles a self-DM (only me as member) "Notes to self"', () => {
    const selfDm: ChatSummaryDTO = {
      id: 3,
      type: 'dm',
      name: null,
      members: [ann],
      lastMessage: null,
      unreadCount: 0,
    };
    expect(chatTitle(selfDm, ann.id)).toBe('Notes to self');
  });
});

describe('chatInitials', () => {
  it('takes the first letter of up to two words, uppercased', () => {
    expect(chatInitials('Ann Smith')).toBe('AS');
    expect(chatInitials('bob')).toBe('B');
    expect(chatInitials('The Cool Group Chat')).toBe('TC');
    expect(chatInitials('   ')).toBe('?');
  });
});

describe('mergeMessages', () => {
  it('de-duplicates by id and keeps ascending order', () => {
    const existing = [msg(1, ann, 'one'), msg(2, bob, 'two')];
    const incoming = [msg(2, bob, 'two'), msg(3, ann, 'three')];
    const merged = mergeMessages(existing, incoming);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('sorts out-of-order older pages back into ascending order', () => {
    const existing = [msg(5, ann, 'e'), msg(6, bob, 'f')];
    const older = [msg(3, ann, 'c'), msg(4, bob, 'd')];
    const merged = mergeMessages(existing, older);
    expect(merged.map((m) => m.id)).toEqual([3, 4, 5, 6]);
  });

  it('lets the incoming copy win for a duplicated id', () => {
    const existing = [msg(1, ann, 'stale')];
    const incoming = [msg(1, ann, 'fresh')];
    const merged = mergeMessages(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toBe('fresh');
  });

  it('returns the existing list unchanged when nothing is incoming', () => {
    const existing = [msg(1, ann, 'one')];
    expect(mergeMessages(existing, [])).toBe(existing);
  });
});

describe('replaceMessage', () => {
  it('replaces a message in place by id', () => {
    const existing = [msg(1, ann, 'one'), msg(2, bob, 'two')];
    const updated = { ...msg(2, bob, 'two edited'), editedAt: new Date().toISOString() };
    const result = replaceMessage(existing, updated);
    expect(result.map((m) => m.content)).toEqual(['one', 'two edited']);
    expect(result[1]?.editedAt).not.toBeNull();
  });

  it('ignores an update for a message not in the list (never inserts it)', () => {
    const existing = [msg(1, ann, 'one')];
    const result = replaceMessage(existing, msg(99, bob, 'stray'));
    // Same reference back — nothing changed.
    expect(result).toBe(existing);
  });
});

describe('tombstone', () => {
  it('neuters a message into its deleted form, dropping content/mentions/attachments', () => {
    const original = { ...msg(1, ann, 'secret'), mentions: [2], editedAt: new Date().toISOString() };
    const dead = tombstone(original);
    expect(dead.id).toBe(1);
    expect(dead.isDeleted).toBe(true);
    expect(dead.content).toBe('');
    expect(dead.mentions).toEqual([]);
    expect(dead.attachments).toEqual([]);
    expect(dead.editedAt).toBeNull();
  });
});

describe('upsertChat', () => {
  function chat(id: number, lastMessage: MessageDTO | null, unreadCount = 0): ChatSummaryDTO {
    return { id, type: 'group', name: `Chat ${id}`, members: [ann, bob], lastMessage, unreadCount };
  }

  it('appends a new chat and orders empty (just-created) chats first', () => {
    const existing = [chat(1, msg(5, bob, 'old'))];
    const incoming = chat(2, null);
    const result = upsertChat(existing, incoming);
    expect(result.map((c) => c.id)).toEqual([2, 1]);
  });

  it('replaces an existing chat by id (server-truth summary wins)', () => {
    const existing = [chat(1, msg(5, bob, 'stale'), 0), chat(2, msg(9, bob, 'newer'))];
    const incoming = chat(1, msg(10, bob, 'fresh'), 3);
    const result = upsertChat(existing, incoming);
    expect(result).toHaveLength(2);
    const updated = result.find((c) => c.id === 1)!;
    expect(updated.lastMessage?.content).toBe('fresh');
    expect(updated.unreadCount).toBe(3);
    // Chat 1 now has the newest message, so it sorts to the top.
    expect(result[0]?.id).toBe(1);
  });

  it('orders by most recent message time', () => {
    const existing = [chat(1, msg(3, bob, 'a')), chat(2, msg(7, bob, 'b'))];
    const incoming = chat(3, msg(5, bob, 'c'));
    const result = upsertChat(existing, incoming);
    expect(result.map((c) => c.id)).toEqual([2, 3, 1]);
  });
});

describe('readPositions', () => {
  // Loaded window: oldest id 5, newest id 7.
  const messages = [msg(5, ann, 'a'), msg(6, bob, 'b'), msg(7, ann, 'c')];

  it('hides a member whose read position is behind the loaded window (off-screen)', () => {
    const behind: ChatMemberDTO = { ...bob, lastReadMessageId: 3 };
    const result = readPositions(messages, [ann, behind], ann.id);
    expect(result.size).toBe(0);
  });

  it('clamps a member who has read past the newest loaded message onto the newest', () => {
    const aheadReader: ChatMemberDTO = { ...bob, lastReadMessageId: 999 };
    const result = readPositions(messages, [ann, aheadReader], ann.id);
    expect(result.get(7)?.map((m) => m.id)).toEqual([bob.id]);
    expect(result.size).toBe(1);
  });

  it('clusters multiple members who read the same amount onto the same anchor message', () => {
    const reader1: ChatMemberDTO = { ...bob, lastReadMessageId: 6 };
    const reader2: ChatMemberDTO = { ...carol, lastReadMessageId: 6 };
    const result = readPositions(messages, [ann, reader1, reader2], ann.id);
    expect(result.size).toBe(1);
    expect(new Set(result.get(6)?.map((m) => m.id))).toEqual(new Set([bob.id, carol.id]));
  });

  it('excludes me from my own receipts, even with a lastReadMessageId set', () => {
    const me: ChatMemberDTO = { ...ann, lastReadMessageId: 7 };
    const neverRead: ChatMemberDTO = { ...bob, lastReadMessageId: 0 };
    const result = readPositions(messages, [me, neverRead], ann.id);
    // "me" is excluded, and bob (0 = never read anything — also covers bots,
    // which never call the read endpoint) is hidden too.
    expect(result.size).toBe(0);
  });

  it('anchors on the newest loaded message at or below the read id when the exact id is missing', () => {
    const sparse = [msg(10, ann, 'a'), msg(14, bob, 'b'), msg(20, ann, 'c')];
    const reader: ChatMemberDTO = { ...bob, lastReadMessageId: 17 }; // between 14 and 20
    const result = readPositions(sparse, [ann, reader], ann.id);
    expect([...result.keys()]).toEqual([14]);
  });

  it('returns an empty map when no messages are loaded', () => {
    expect(readPositions([], [bob], ann.id).size).toBe(0);
  });
});

describe('firstUnreadMessageId', () => {
  it('returns the first other-sender message past my last-read id', () => {
    const messages = [msg(1, bob, 'a'), msg(2, ann, 'b'), msg(3, bob, 'c'), msg(4, bob, 'd')];
    expect(firstUnreadMessageId(messages, 2, ann.id)).toBe(3);
  });

  it('treats 0 (never read anything) as everything unread, anchored on the first other-sender message', () => {
    const messages = [msg(1, bob, 'a'), msg(2, bob, 'b')];
    expect(firstUnreadMessageId(messages, 0, ann.id)).toBe(1);
  });

  it('skips my own messages — they are implicitly read', () => {
    const messages = [msg(1, ann, 'mine'), msg(2, ann, 'also mine'), msg(3, bob, 'first from bob')];
    expect(firstUnreadMessageId(messages, 0, ann.id)).toBe(3);
  });

  it('returns null when everything is already read', () => {
    const messages = [msg(1, bob, 'a'), msg(2, bob, 'b')];
    expect(firstUnreadMessageId(messages, 2, ann.id)).toBeNull();
  });

  it('returns null for an empty message list', () => {
    expect(firstUnreadMessageId([], 0, ann.id)).toBeNull();
  });

  it('returns null when only my own messages are unread', () => {
    const messages = [msg(1, bob, 'read'), msg(2, ann, 'mine, unread by the other def but implicitly read')];
    expect(firstUnreadMessageId(messages, 1, ann.id)).toBeNull();
  });
});

describe('searchTerms', () => {
  it('splits on whitespace, dropping empties', () => {
    expect(searchTerms('  hello   world ')).toEqual(['hello', 'world']);
    expect(searchTerms('single')).toEqual(['single']);
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('highlightSegments', () => {
  it('flags each case-insensitive term match, leaving the rest unmarked', () => {
    const segs = highlightSegments('Hello World', ['world']);
    expect(segs).toEqual([
      { text: 'Hello ', match: false },
      { text: 'World', match: true },
    ]);
  });

  it('marks multiple distinct terms', () => {
    const segs = highlightSegments('the quick brown fox', ['quick', 'fox']);
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['quick', 'fox']);
  });

  it('handles adjacent matches and preserves original casing', () => {
    const segs = highlightSegments('aAa', ['a']);
    expect(segs.map((s) => s.text).join('')).toBe('aAa');
    expect(segs.every((s) => s.match)).toBe(true);
  });

  it('treats regex metacharacters in terms literally', () => {
    const segs = highlightSegments('a.b c', ['a.b']);
    expect(segs[0]).toEqual({ text: 'a.b', match: true });
    // The '.' must not match the space in 'a b' — literal only.
    expect(highlightSegments('axb', ['a.b']).some((s) => s.match)).toBe(false);
  });

  it('returns the whole string unmarked when there are no terms', () => {
    expect(highlightSegments('untouched', [])).toEqual([{ text: 'untouched', match: false }]);
  });
});

describe('searchSnippet', () => {
  it('returns short content whole', () => {
    expect(searchSnippet('short and sweet', ['sweet'])).toBe('short and sweet');
  });

  it('windows long content around the first matching term with ellipses', () => {
    const long = 'x'.repeat(100) + ' NEEDLE ' + 'y'.repeat(100);
    const snippet = searchSnippet(long, ['needle'], 20);
    expect(snippet).toContain('NEEDLE');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThan(long.length);
  });
});
