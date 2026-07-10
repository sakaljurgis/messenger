import { describe, expect, it } from 'vitest';
import { toChatMemberDTO, toMessageDTO, toUserDTO } from './dto.js';
import type { MessageRow, UserRow } from './db/schema.js';

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 1,
    email: 'alice@example.com',
    passwordHash: 'hash',
    displayName: 'Alice',
    isBot: false,
    webhookUrl: null,
    apiToken: null,
    deletedAt: null,
    createdAt: new Date(),
    color: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 1,
    chatId: 1,
    senderId: 1,
    content: 'hi',
    replyToId: null,
    createdAt: new Date(),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('toUserDTO', () => {
  it('carries a set color through', () => {
    const dto = toUserDTO(makeUser({ color: '#abc123' }));
    expect(dto.color).toBe('#abc123');
  });

  it('is null when no color is set (client derives one)', () => {
    const dto = toUserDTO(makeUser({ color: null }));
    expect(dto.color).toBeNull();
  });

  it('never leaks passwordHash or apiToken', () => {
    const dto = toUserDTO(makeUser({ apiToken: 'secret-token' }));
    expect(dto).not.toHaveProperty('passwordHash');
    expect(dto).not.toHaveProperty('apiToken');
  });
});

describe('toChatMemberDTO', () => {
  it("includes the member's color", () => {
    const dto = toChatMemberDTO({ user: makeUser({ color: '#ff8800' }), lastReadMessageId: 5 });
    expect(dto.color).toBe('#ff8800');
    expect(dto.lastReadMessageId).toBe(5);
  });
});

describe('toMessageDTO', () => {
  it("includes the sender's color on a live message", () => {
    const dto = toMessageDTO(makeMessage(), makeUser({ color: '#00ff00' }), []);
    expect(dto.sender.color).toBe('#00ff00');
  });
});
