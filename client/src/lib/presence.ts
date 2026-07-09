// Online-presence store for the client.
//
// The server pushes a one-shot `presence:state` snapshot to each socket on
// connect, then incremental `presence` deltas as users come and go. This module
// mirrors that into a single module-level Set<number> of online user ids and
// exposes it to React via useSyncExternalStore (React 19).
//
// The socket listeners are wired exactly once (idempotent init) onto the shared
// singleton socket; because that socket instance outlives connect/disconnect
// cycles, we never need to re-subscribe. On socket disconnect we clear the set —
// we no longer know who is online, and the fresh snapshot on the next connect
// replaces it wholesale.

import { useSyncExternalStore } from 'react';
import { getSocket } from './socket';

// The current set of online user ids. Replaced (never mutated) on every change
// so useSyncExternalStore sees a new reference exactly when something changed,
// and a stable one otherwise.
let onlineIds: Set<number> = new Set();
const subscribers = new Set<() => void>();
let initialized = false;

function setOnline(next: Set<number>): void {
  onlineIds = next;
  for (const cb of subscribers) cb();
}

/**
 * Wire the presence socket listeners onto the shared socket. Idempotent — safe to
 * call on every login; only the first call attaches listeners.
 */
export function initPresence(): void {
  if (initialized) return;
  initialized = true;
  const socket = getSocket();

  // Full snapshot on (re)connect: replace the set wholesale.
  socket.on('presence:state', (ids: number[]) => {
    setOnline(new Set(ids));
  });

  // Incremental delta: add on online, remove on offline.
  socket.on('presence', ({ userId, online }) => {
    const next = new Set(onlineIds);
    if (online) next.add(userId);
    else next.delete(userId);
    setOnline(next);
  });

  // Lost the connection: we can't vouch for anyone's presence anymore. The next
  // connect delivers a fresh snapshot.
  socket.on('disconnect', () => {
    if (onlineIds.size > 0) setOnline(new Set());
  });
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): Set<number> {
  return onlineIds;
}

/** The set of currently-online user ids, live via useSyncExternalStore. */
export function useOnlineUsers(): Set<number> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Test-only internals.
// ---------------------------------------------------------------------------

/** Reset the module store + init guard so each test starts clean. */
export function __resetPresenceForTests(): void {
  onlineIds = new Set();
  subscribers.clear();
  initialized = false;
}
