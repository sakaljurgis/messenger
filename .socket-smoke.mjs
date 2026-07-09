// Live smoke: bob connects a real socket, alice POSTs a message, bob must receive it.
import { io } from 'socket.io-client';

const B = 'http://localhost:3996';

async function register(email, displayName) {
  const res = await fetch(`${B}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password1', displayName }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  return { cookie, user };
}

const alice = await register('alice@s.co', 'Alice');
const bob = await register('bob@s.co', 'Bob');

const socket = io(B, { extraHeaders: { cookie: bob.cookie } });
await new Promise((res, rej) => {
  socket.on('connect', res);
  socket.on('connect_error', rej);
});

const received = new Promise((res) => socket.on('message:new', res));

const chatRes = await fetch(`${B}/api/chats`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie: alice.cookie },
  body: JSON.stringify({ userId: bob.user.id }),
});
const { chat } = await chatRes.json();
await fetch(`${B}/api/chats/${chat.id}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie: alice.cookie },
  body: JSON.stringify({ content: 'realtime hello' }),
});

const msg = await Promise.race([
  received,
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for message:new')), 5000)),
]);
console.log('BOB RECEIVED:', msg.content, 'from', msg.sender.displayName);
socket.close();
process.exit(0);
