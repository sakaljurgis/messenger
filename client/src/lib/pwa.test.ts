import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenForSwNavigation } from './pwa';

// jsdom has no navigator.serviceWorker — install a minimal EventTarget stand-in
// so the container's 'message' events can be dispatched from the test.
function installContainer(): EventTarget {
  const target = new EventTarget();
  Object.defineProperty(navigator, 'serviceWorker', { value: target, configurable: true });
  return target;
}

function emitMessage(target: EventTarget, data: unknown) {
  target.dispatchEvent(new MessageEvent('message', { data }));
}

describe('listenForSwNavigation', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('invokes the callback for navigate messages and ignores everything else', () => {
    const container = installContainer();
    const onNavigate = vi.fn();
    listenForSwNavigation(onNavigate);

    emitMessage(container, { type: 'navigate', url: '/chats/5' });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('/chats/5');

    // Malformed or unrelated messages must not navigate.
    emitMessage(container, { type: 'navigate' }); // no url
    emitMessage(container, { type: 'other', url: '/x' });
    emitMessage(container, 'navigate');
    emitMessage(container, null);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after unsubscribe', () => {
    const container = installContainer();
    const onNavigate = vi.fn();
    const unsubscribe = listenForSwNavigation(onNavigate);

    unsubscribe();
    emitMessage(container, { type: 'navigate', url: '/chats/5' });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('is a no-op without service worker support', () => {
    // No container installed at all — must not throw, unsubscribe included.
    const unsubscribe = listenForSwNavigation(vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});
