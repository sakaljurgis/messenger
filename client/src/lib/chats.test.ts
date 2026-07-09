import { describe, expect, it } from 'vitest';
import type { ChatSummaryDTO, MessageDTO, UserDTO } from '@messenger/shared';
import { chatInitials, chatTitle, mergeMessages, upsertChat } from './chats';

const ann: UserDTO = { id: 1, email: 'ann@example.com', displayName: 'Ann Smith', isBot: false };
const bob: UserDTO = { id: 2, email: 'bob@example.com', displayName: 'Bob', isBot: false };
const carol: UserDTO = { id: 3, email: 'carol@example.com', displayName: 'Carol', isBot: false };

function msg(id: number, sender: UserDTO, content: string): MessageDTO {
  return {
    id,
    chatId: 1,
    sender,
    content,
    mentions: [],
    createdAt: new Date(1_700_000_000_000 + id * 1000).toISOString(),
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
