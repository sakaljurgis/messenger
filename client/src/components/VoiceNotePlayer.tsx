// Custom Web Audio player for voice-note (audio) attachments, replacing the
// stock `<audio controls>` element. It exists to fix two real iOS bugs:
//
//  1. iOS Safari's MediaRecorder writes fragmented MP4 whose duration metadata
//     is broken (WebKit bug 216832). Safari's own progressive `<audio>` pipeline
//     refuses to play those files, so iPhone users literally can't hear the
//     voice notes they recorded (Chrome plays the identical bytes fine). Web
//     Audio's `decodeAudioData` does a full-buffer decode that copes with the
//     broken metadata — so we fetch the bytes, decode them, and play through an
//     AudioBufferSourceNode with our own UI.
//  2. In an installed iOS PWA the hardware silent switch mutes playback. iOS 17+
//     exposes the Audio Session API to opt out: set `navigator.audioSession.type`
//     to 'playback' while sound is playing and back to 'auto' when it stops.
//
// Everything is lazy: a thread of 50 voice notes must not download 50 files on
// mount. The bubble renders as a compact idle row (play button + static bar +
// '–:–'); the FIRST tap on play is the user gesture iOS needs, and it's only
// then that we fetch → decode → play. If fetch or decode rejects we fall back to
// the plain native `<audio>` element so the user is never left with a dead
// button.

import { useEffect, useRef, useState } from 'react';
import type { AttachmentDTO } from '@messenger/shared';
import { attachmentUrl } from '../lib/attachments';

/**
 * A single shared AudioContext for the whole app, created lazily on first play
 * (constructing one eagerly on load is disallowed without a user gesture on
 * iOS). iOS suspends it aggressively, so we `resume()` it before every play.
 */
let sharedContext: AudioContext | null = null;

type AudioContextCtor = typeof AudioContext;

function getAudioContext(): AudioContext {
  if (!sharedContext) {
    const Ctor: AudioContextCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API unavailable');
    sharedContext = new Ctor();
  }
  return sharedContext;
}

/**
 * Single-playback registry: the stop callback of whichever voice note is
 * currently sounding. Starting a new one stops it first (module-level so it
 * spans every mounted player).
 */
let activeStop: (() => void) | null = null;

/**
 * Steer the iOS Audio Session so the hardware silent switch doesn't mute us
 * (iOS 17+). Feature-detected and wrapped in try/catch — the property is
 * read-only/frozen in some engines, and absent everywhere but recent WebKit, so
 * this is a no-op on every other platform.
 */
function setAudioSession(type: 'playback' | 'auto'): void {
  try {
    if ('audioSession' in navigator) {
      (navigator as unknown as { audioSession: { type: string } }).audioSession.type = type;
    }
  } catch {
    /* read-only / frozen — nothing we can do, and nothing we need to. */
  }
}

/** Seconds → `m:ss` (e.g. 7.5 → "0:07"). */
function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(safe);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Reset module-level singletons between tests (the shared context/registry
 *  otherwise leak across cases). Not used by the app. */
export function __resetVoiceNotePlaybackForTests(): void {
  sharedContext = null;
  activeStop = null;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 animate-spin" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2} className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

export default function VoiceNotePlayer({ audio }: { audio: AttachmentDTO }) {
  const src = attachmentUrl(audio.id);

  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false); // fetch/decode rejected → native <audio>
  const [duration, setDuration] = useState<number | null>(null); // null until decoded
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // elapsed seconds, drives the bar

  const bufferRef = useRef<AudioBuffer | null>(null); // decoded once, then reused
  const sourceRef = useRef<AudioBufferSourceNode | null>(null); // the live one-shot node
  // AudioBufferSourceNodes are one-shot, so we track playback position ourselves:
  // `offset` is where the current source started within the buffer, and
  // `startCtxTime` is the context clock at that moment — current position is
  // therefore offset + (ctx.currentTime - startCtxTime).
  const offsetRef = useRef(0);
  const startCtxTimeRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const playingRef = useRef(false); // mirror of `playing`, readable inside closures

  // Stable identity for the single-playback registry: `activeStop` is compared
  // by reference to decide whether *this* player is the one sounding, so it must
  // not change across renders. It delegates to the latest `pause` via a ref.
  const pauseRef = useRef<() => void>(() => {});
  const stopTokenRef = useRef<(() => void) | null>(null);
  if (!stopTokenRef.current) stopTokenRef.current = () => pauseRef.current();

  function cancelRaf() {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  // Stop and detach the live source WITHOUT triggering its natural-end handler
  // (we null `onended` first) — used by pause, seek, restart and unmount.
  function stopCurrentSource() {
    const source = sourceRef.current;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* already stopped/ended — fine */
    }
    try {
      source.disconnect();
    } catch {
      /* not connected — fine */
    }
    sourceRef.current = null;
  }

  function tick() {
    const ctx = sharedContext;
    if (!ctx || !playingRef.current) return;
    const dur = bufferRef.current?.duration ?? 0;
    const pos = offsetRef.current + (ctx.currentTime - startCtxTimeRef.current);
    setProgress(Math.min(pos, dur));
    rafRef.current = requestAnimationFrame(tick);
  }

  // Pause: freeze the current position into `offset`, stop the source, and hand
  // the silent switch back to the OS. Resuming later starts a fresh source there.
  function pause() {
    if (!playingRef.current) return;
    const ctx = sharedContext;
    const dur = bufferRef.current?.duration ?? 0;
    const pos = ctx ? offsetRef.current + (ctx.currentTime - startCtxTimeRef.current) : offsetRef.current;
    stopCurrentSource();
    offsetRef.current = Math.min(Math.max(pos, 0), dur);
    playingRef.current = false;
    setPlaying(false);
    setProgress(offsetRef.current);
    cancelRaf();
    setAudioSession('auto');
    if (activeStop === stopTokenRef.current) activeStop = null;
  }
  pauseRef.current = pause;

  // Natural completion: the source ran to the end on its own. Reset to the start
  // (a second tap replays from 0) and release the audio session.
  function handleNaturalEnd() {
    stopCurrentSource();
    offsetRef.current = 0;
    playingRef.current = false;
    setPlaying(false);
    setProgress(0);
    cancelRaf();
    setAudioSession('auto');
    if (activeStop === stopTokenRef.current) activeStop = null;
  }

  // Start (or restart) playback at `offset` seconds into the decoded buffer.
  function startPlayback(offset: number) {
    const buffer = bufferRef.current;
    if (!buffer) return;
    const ctx = getAudioContext();

    // Single-playback rule: silence whatever else is sounding first.
    if (activeStop && activeStop !== stopTokenRef.current) activeStop();
    stopCurrentSource();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = handleNaturalEnd;

    offsetRef.current = offset;
    startCtxTimeRef.current = ctx.currentTime;
    source.start(0, offset);
    sourceRef.current = source;

    playingRef.current = true;
    setPlaying(true);
    setProgress(offset);
    setAudioSession('playback');
    activeStop = stopTokenRef.current ?? null;

    cancelRaf();
    rafRef.current = requestAnimationFrame(tick);
  }

  async function togglePlay() {
    if (failed) return;
    if (playingRef.current) {
      pause();
      return;
    }

    let ctx: AudioContext;
    try {
      ctx = getAudioContext();
    } catch {
      setFailed(true); // no Web Audio at all → native element
      return;
    }
    // Resume inside the click handler — iOS only honours the gesture here.
    try {
      if (typeof ctx.resume === 'function') await ctx.resume();
    } catch {
      /* resume can reject if the context is closing — play may still work */
    }

    if (!bufferRef.current) {
      setLoading(true);
      try {
        // Plain fetch (not lib/api): we need the raw ArrayBuffer, and the
        // same-origin request carries the `sid` session cookie by default.
        const res = await fetch(src);
        if (!res.ok) throw new Error(`Voice note fetch failed: ${res.status}`);
        const bytes = await res.arrayBuffer();
        const buffer = await ctx.decodeAudioData(bytes);
        bufferRef.current = buffer;
        setDuration(buffer.duration);
      } catch {
        // Broken beyond Web Audio too, or a network error: hand off to the
        // browser's own progressive player rather than leave a dead button.
        setLoading(false);
        setFailed(true);
        return;
      }
      setLoading(false);
    }

    // The awaits above may have let iOS re-suspend the context.
    try {
      if (typeof ctx.resume === 'function') await ctx.resume();
    } catch {
      /* see above */
    }

    const dur = bufferRef.current?.duration ?? 0;
    startPlayback(offsetRef.current >= dur ? 0 : offsetRef.current);
  }

  function onSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const value = Number(e.target.value);
    offsetRef.current = value;
    setProgress(value);
    // Live-restart the source at the new offset when we're playing.
    if (playingRef.current) startPlayback(value);
  }

  // Unmount / chat-switch cleanup: stop the source, cancel the rAF loop, and
  // restore the audio session if we were the one that claimed it.
  useEffect(() => {
    return () => {
      stopCurrentSource();
      cancelRaf();
      if (playingRef.current) setAudioSession('auto');
      playingRef.current = false;
      if (activeStop === stopTokenRef.current) activeStop = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Broken beyond Web Audio (or no Web Audio): the previous plain player.
  if (failed) {
    return (
      <audio
        controls
        preload="metadata"
        src={src}
        data-testid="audio-attachment"
        className="w-64 max-w-full"
      />
    );
  }

  const hasDuration = duration != null;
  const durationLabel = hasDuration ? formatTime(duration) : '–:–';

  return (
    <div
      data-testid="voice-note-player"
      role="group"
      aria-label="Voice message"
      className="flex w-64 max-w-full items-center gap-3 rounded-2xl bg-gray-100 px-3 py-2 dark:bg-gray-700"
    >
      <button
        type="button"
        onClick={() => void togglePlay()}
        disabled={loading}
        aria-label={loading ? 'Loading voice note' : playing ? 'Pause voice note' : 'Play voice note'}
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#0084ff] text-white transition-colors hover:bg-[#0079f2] disabled:opacity-70"
      >
        {loading ? <SpinnerIcon /> : playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <input
        type="range"
        min={0}
        max={hasDuration ? duration : 1}
        step={0.01}
        value={hasDuration ? Math.min(progress, duration) : 0}
        onChange={onSeek}
        disabled={!hasDuration}
        aria-label="Seek voice note"
        className="h-1 flex-1 cursor-pointer accent-[#0084ff] disabled:cursor-default"
      />

      <span className="flex-shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">
        {durationLabel}
      </span>
    </div>
  );
}
