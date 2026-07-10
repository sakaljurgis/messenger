import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAppBadge, setAppBadge } from './badge';

function stubBadgingApi() {
  const setAppBadgeMock = vi.fn().mockResolvedValue(undefined);
  const clearAppBadgeMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadgeMock });
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadgeMock });
  return { setAppBadgeMock, clearAppBadgeMock };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'setAppBadge');
  Reflect.deleteProperty(navigator, 'clearAppBadge');
  vi.restoreAllMocks();
});

describe('setAppBadge', () => {
  it('calls navigator.setAppBadge with the count when the API is present', () => {
    const { setAppBadgeMock, clearAppBadgeMock } = stubBadgingApi();
    setAppBadge(3);
    expect(setAppBadgeMock).toHaveBeenCalledWith(3);
    expect(clearAppBadgeMock).not.toHaveBeenCalled();
  });

  it('clears the badge instead of setting it to 0', () => {
    const { setAppBadgeMock, clearAppBadgeMock } = stubBadgingApi();
    setAppBadge(0);
    expect(clearAppBadgeMock).toHaveBeenCalled();
    expect(setAppBadgeMock).not.toHaveBeenCalled();
  });

  it('clears the badge for a negative count too', () => {
    const { setAppBadgeMock, clearAppBadgeMock } = stubBadgingApi();
    setAppBadge(-1);
    expect(clearAppBadgeMock).toHaveBeenCalled();
    expect(setAppBadgeMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the Badging API is unsupported', () => {
    expect('setAppBadge' in navigator).toBe(false);
    expect(() => setAppBadge(5)).not.toThrow();
  });

  it('swallows a rejection from navigator.setAppBadge', async () => {
    const setAppBadgeMock = vi.fn().mockRejectedValue(new Error('nope'));
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadgeMock });
    expect(() => setAppBadge(2)).not.toThrow();
    // Let the rejected promise's .catch() run; an unhandled rejection would
    // otherwise fail the test.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('clearAppBadge', () => {
  it('calls navigator.clearAppBadge when the API is present', () => {
    const { clearAppBadgeMock } = stubBadgingApi();
    clearAppBadge();
    expect(clearAppBadgeMock).toHaveBeenCalled();
  });

  it('is a no-op when the Badging API is unsupported', () => {
    expect('setAppBadge' in navigator).toBe(false);
    expect(() => clearAppBadge()).not.toThrow();
  });

  it('swallows a rejection from navigator.clearAppBadge', async () => {
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: vi.fn() });
    const clearAppBadgeMock = vi.fn().mockRejectedValue(new Error('nope'));
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadgeMock });
    expect(() => clearAppBadge()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
