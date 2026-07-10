import { describe, expect, it } from 'vitest';
import { toChatMemberDTO, toChatSummaryDTO, toMessageDTO, toUserDTO } from './dto.js';
import type { ChatRow, MessageRow, UserRow } from './db/schema.js';

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

function makeChat(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    id: 1,
    type: 'group',
    name: 'Team',
    dmKey: null,
    createdBy: 1,
    createdAt: new Date(),
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
    linkPreview: null,
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

  it('is null when the link_preview column is null', () => {
    const dto = toMessageDTO(makeMessage({ linkPreview: null }), makeUser(), []);
    expect(dto.linkPreview).toBeNull();
  });

  it('parses a JSON link_preview column into the DTO shape', () => {
    const preview = {
      url: 'https://example.com',
      title: 'Example',
      description: 'A description',
      imageUrl: 'https://example.com/img.png',
      siteName: 'Example Site',
    };
    const dto = toMessageDTO(
      makeMessage({ linkPreview: JSON.stringify(preview) }),
      makeUser(),
      [],
    );
    expect(dto.linkPreview).toEqual(preview);
  });

  it('never throws on malformed JSON in link_preview — collapses to null', () => {
    const dto = toMessageDTO(makeMessage({ linkPreview: '{not valid json' }), makeUser(), []);
    expect(dto.linkPreview).toBeNull();
  });

  it('collapses a non-object JSON value (e.g. a bare string/number) to null', () => {
    const dto = toMessageDTO(makeMessage({ linkPreview: '"just a string"' }), makeUser(), []);
    expect(dto.linkPreview).toBeNull();
  });

  it('a tombstone never carries a preview, even when the column has data', () => {
    const preview = {
      url: 'https://example.com',
      title: 'Example',
      description: null,
      imageUrl: null,
      siteName: null,
    };
    const dto = toMessageDTO(
      makeMessage({ linkPreview: JSON.stringify(preview), deletedAt: new Date() }),
      makeUser(),
      [],
    );
    expect(dto.linkPreview).toBeNull();
    expect(dto.isDeleted).toBe(true);
  });
});

describe('toChatSummaryDTO', () => {
  it('carries the caller-supplied muted flag through as-is (true)', () => {
    const dto = toChatSummaryDTO(makeChat(), [], null, 0, true);
    expect(dto.muted).toBe(true);
  });

  it('carries the caller-supplied muted flag through as-is (false)', () => {
    const dto = toChatSummaryDTO(makeChat(), [], null, 0, false);
    expect(dto.muted).toBe(false);
  });
});
