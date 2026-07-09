import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Controllable stand-in for the Socket.IO client so tests can drive presence
// events synchronously. `clear()` wipes listeners between tests.
const socket = vi.hoisted(() => {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const s = {
    connected: false,
    on(event: string, fn: (...a: unknown[]) => void) {
      (listeners[event] ??= []).push(fn);
      return s;
    },
    off(event: string, fn: (...a: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
      return s;
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of [...(listeners[event] ?? [])]) fn(...args);
      return true;
    },
    connect() {
      s.connected = true;
      s.emit('connect');
      return s;
    },
    disconnect() {
      s.connected = false;
      s.emit('disconnect');
      return s;
    },
    clear() {
      for (const key of Object.keys(listeners)) delete listeners[key];
    },
  };
  return s;
});

vi.mock('./socket', () => ({
  getSocket: () => socket,
  connectSocket: () => socket.connect(),
  disconnectSocket: () => socket.disconnect(),
}));

import { __resetPresenceForTests, initPresence, useOnlineUsers } from './presence';

describe('presence store', () => {
  beforeEach(() => {
    socket.clear();
    __resetPresenceForTests();
    initPresence();
  });

  afterEach(() => {
    __resetPresenceForTests();
  });

  it('replaces the whole set on a presence:state snapshot', () => {
    const { result } = renderHook(() => useOnlineUsers());
    expect(result.current.size).toBe(0);

    act(() => {
      socket.emit('presence:state', [1, 2, 3]);
    });
    expect([...result.current].sort()).toEqual([1, 2, 3]);

    // A later snapshot replaces (does not merge) the previous one.
    act(() => {
      socket.emit('presence:state', [4]);
    });
    expect([...result.current]).toEqual([4]);
  });

  it('adds and removes ids on incremental presence deltas', () => {
    const { result } = renderHook(() => useOnlineUsers());

    act(() => {
      socket.emit('presence:state', [1]);
    });
    act(() => {
      socket.emit('presence', { userId: 2, online: true });
    });
    expect([...result.current].sort()).toEqual([1, 2]);

    act(() => {
      socket.emit('presence', { userId: 1, online: false });
    });
    expect([...result.current]).toEqual([2]);
  });

  it('drives the hook to re-render via useSyncExternalStore', () => {
    const { result } = renderHook(() => useOnlineUsers());
    expect(result.current.has(5)).toBe(false);

    act(() => {
      socket.emit('presence', { userId: 5, online: true });
    });
    expect(result.current.has(5)).toBe(true);
  });

  it('clears the set when the socket disconnects', () => {
    const { result } = renderHook(() => useOnlineUsers());
    act(() => {
      socket.emit('presence:state', [1, 2]);
    });
    expect(result.current.size).toBe(2);

    act(() => {
      socket.emit('disconnect');
    });
    expect(result.current.size).toBe(0);
  });

  it('wires listeners only once even if initPresence is called repeatedly', () => {
    initPresence();
    initPresence();
    const { result } = renderHook(() => useOnlineUsers());

    // A single delta must move the count by exactly one (no duplicate handlers).
    act(() => {
      socket.emit('presence', { userId: 9, online: true });
    });
    expect(result.current.size).toBe(1);
  });
});
