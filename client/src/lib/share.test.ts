import { describe, expect, it } from 'vitest';
import { buildPrefill, sharedFileToFile, type SharedPayload } from './share';

function payload(over: Partial<SharedPayload> = {}): SharedPayload {
  return { title: '', text: '', url: '', files: [], ...over };
}

describe('buildPrefill', () => {
  it('joins text and url on separate lines', () => {
    expect(buildPrefill(payload({ text: 'Look at this', url: 'https://x.dev' }))).toBe(
      'Look at this\nhttps://x.dev',
    );
  });

  it('falls back to the title when there is no text (link share)', () => {
    expect(buildPrefill(payload({ title: 'Cool Page', url: 'https://x.dev' }))).toBe(
      'Cool Page\nhttps://x.dev',
    );
  });

  it('does not duplicate a url already contained in the text', () => {
    expect(buildPrefill(payload({ text: 'see https://x.dev now', url: 'https://x.dev' }))).toBe(
      'see https://x.dev now',
    );
  });

  it('prefers text over title when both are present', () => {
    expect(buildPrefill(payload({ title: 'Title', text: 'Selected text' }))).toBe('Selected text');
  });

  it('returns an empty string when nothing textual was shared (files only)', () => {
    expect(buildPrefill(payload())).toBe('');
  });
});

describe('sharedFileToFile', () => {
  it('rehydrates a File with name and type', () => {
    const file = sharedFileToFile({ name: 'a.png', type: 'image/png', blob: new Blob(['x']) });
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('a.png');
    expect(file.type).toBe('image/png');
  });

  it('defaults a missing name/type', () => {
    const file = sharedFileToFile({ name: '', type: '', blob: new Blob(['x']) });
    expect(file.name).toBe('shared-file');
    expect(file.type).toBe('application/octet-stream');
  });
});
