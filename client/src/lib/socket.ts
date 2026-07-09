// Socket.IO client for real-time chat/message updates.
//
// Same-origin: `io()` with no URL connects back to the page's origin, and Vite
// proxies `/socket.io` to the API server in dev. The httpOnly `sid` cookie is
// sent automatically on the handshake, so there is nothing to configure here.
//
// The socket is created lazily and never auto-connects — the auth layer owns
// its lifecycle (connect once a user is present, disconnect on logout).

import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@messenger/shared';

/** Client listens for ServerToClientEvents and emits ClientToServerEvents. */
export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;

/** The shared singleton socket, created on first use (does not auto-connect). */
export function getSocket(): AppSocket {
  if (!socket) {
    socket = io({ autoConnect: false }) as AppSocket;
  }
  return socket;
}

/** Open the connection if it isn't already open (idempotent). */
export function connectSocket(): void {
  const s = getSocket();
  if (!s.connected) s.connect();
}

/** Close the connection (idempotent). */
export function disconnectSocket(): void {
  socket?.disconnect();
}
