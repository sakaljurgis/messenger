import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AttachmentDTO } from '@messenger/shared';
import VoiceNotePlayer, { __resetVoiceNotePlaybackForTests } from './VoiceNotePlayer';

// jsdom has neither AudioContext nor decodeAudioData; these are the small fakes
// the component's Web Audio path drives. `createBufferSource()` returns a node
// of spies (one-shot, like the real thing) so tests can assert start/stop, and
// `decodeAudioData` resolves a stand-in AudioBuffer carrying just a duration.

interface FakeSource {
  buffer: unknown;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

function installAudioContext(opts: { decodeRejects?: boolean } = {}) {
  const sources: FakeSource[] = [];
  class FakeAudioContext {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => {
      this.state = 'running';
    });
    decodeAudioData = vi.fn(async () => {
      if (opts.decodeRejects) throw new Error('cannot decode this codec');
      return { duration: 7.5 } as unknown as AudioBuffer;
    });
    createBufferSource(): FakeSource {
      const source: FakeSource = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      sources.push(source);
      return source;
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return { sources };
}

/** Stub `fetch` to resolve raw bytes for the attachment endpoint. */
function installFetch(opts: { ok?: boolean } = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: opts.ok ?? true,
    status: opts.ok === false ? 404 : 200,
    arrayBuffer: async () => new ArrayBuffer(16),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Give the (feature-detected) iOS Audio Session API something to write to. */
function installAudioSession() {
  const session = { type: 'auto' };
  Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true });
  return session;
}

function audioAttachment(id: number): AttachmentDTO {
  return {
    id,
    kind: 'audio',
    originalName: 'voice.webm',
    mimeType: 'audio/webm',
    sizeBytes: 40_000,
    width: null,
    height: null,
    hasThumb: false,
  };
}

describe('VoiceNotePlayer', () => {
  beforeEach(() => {
    // rAF drives only the progress bar; make it a no-op so the tests stay
    // synchronous and don't leak an act() update after they finish.
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetVoiceNotePlaybackForTests();
    delete (navigator as unknown as { audioSession?: unknown }).audioSession;
  });

  it('renders a compact idle row without fetching or decoding on mount', () => {
    const { sources } = installAudioContext();
    const fetchMock = installFetch();

    render(<VoiceNotePlayer audio={audioAttachment(88)} />);

    // Compact player row: a play button, a placeholder duration, no <audio>.
    expect(screen.getByRole('button', { name: 'Play voice note' })).toBeInTheDocument();
    expect(screen.getByText('–:–')).toBeInTheDocument();
    // Lazy — a thread of many voice notes must not download them all.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sources).toHaveLength(0);
  });

  it('tap play fetches the attachment, decodes it, shows duration + a pause control, and claims the audio session', async () => {
    const { sources } = installAudioContext();
    const fetchMock = installFetch();
    const session = installAudioSession();

    render(<VoiceNotePlayer audio={audioAttachment(88)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Play voice note' }));

    // The tap is what triggers the download of the bytes.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/attachments/88'));

    // Decoded: the real duration (7.5s → 0:07) and a pause control appear.
    expect(await screen.findByRole('button', { name: 'Pause voice note' })).toBeInTheDocument();
    expect(screen.getByText('0:07')).toBeInTheDocument();

    // A source was started, and the audio session was steered to 'playback' so
    // the iOS silent switch can't mute it.
    expect(sources).toHaveLength(1);
    expect(sources[0]!.start).toHaveBeenCalled();
    expect(session.type).toBe('playback');
  });

  it('pausing stops the source and restores the audio session to auto', async () => {
    const { sources } = installAudioContext();
    installFetch();
    const session = installAudioSession();

    render(<VoiceNotePlayer audio={audioAttachment(88)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Play voice note' }));

    const pauseBtn = await screen.findByRole('button', { name: 'Pause voice note' });
    expect(session.type).toBe('playback');

    await userEvent.click(pauseBtn);

    expect(sources[0]!.stop).toHaveBeenCalled();
    expect(session.type).toBe('auto');
    expect(await screen.findByRole('button', { name: 'Play voice note' })).toBeInTheDocument();
  });

  it('starting a second voice note stops the first (single-playback registry)', async () => {
    const { sources } = installAudioContext();
    installFetch();
    installAudioSession();

    render(
      <>
        <VoiceNotePlayer audio={audioAttachment(1)} />
        <VoiceNotePlayer audio={audioAttachment(2)} />
      </>,
    );

    // Play the first one.
    const [firstPlay] = screen.getAllByRole('button', { name: 'Play voice note' });
    await userEvent.click(firstPlay!);
    await screen.findByRole('button', { name: 'Pause voice note' });

    // Play the second one (the only remaining Play button).
    const [secondPlay] = screen.getAllByRole('button', { name: 'Play voice note' });
    await userEvent.click(secondPlay!);

    // The first player's source was stopped when the second started.
    await waitFor(() => expect(sources[0]!.stop).toHaveBeenCalled());
    // Exactly one is now playing (the second); the first fell back to Play.
    expect(screen.getAllByRole('button', { name: 'Play voice note' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Pause voice note' })).toBeInTheDocument();
  });

  it('falls back to a native <audio> element when decoding rejects', async () => {
    installAudioContext({ decodeRejects: true });
    installFetch();

    render(<VoiceNotePlayer audio={audioAttachment(88)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Play voice note' }));

    // Never leave a dead button: hand off to the browser's own player.
    const native = await screen.findByTestId('audio-attachment');
    expect(native.tagName).toBe('AUDIO');
    expect(native.getAttribute('src')).toBe('/api/attachments/88');
    expect(native.hasAttribute('controls')).toBe(true);
    expect(native.getAttribute('preload')).toBe('metadata');
    expect(screen.queryByRole('button', { name: /voice note/i })).not.toBeInTheDocument();
  });

  it('unmounting stops the source and cancels the animation frame', async () => {
    const { sources } = installAudioContext();
    installFetch();
    installAudioSession();

    const { unmount } = render(<VoiceNotePlayer audio={audioAttachment(88)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Play voice note' }));
    await screen.findByRole('button', { name: 'Pause voice note' });

    unmount();

    expect(sources[0]!.stop).toHaveBeenCalled();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });
});
