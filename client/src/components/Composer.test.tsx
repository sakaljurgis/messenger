import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AttachmentDTO, MessageDTO, UserDTO } from '@messenger/shared';
import Composer from './Composer';
import { compressImage, shouldCompress, uploadAttachment } from '../lib/attachments';

// Mock the network/compression side of attachments; keep the pure helpers
// (shouldCompress, attachmentUrl, …) real so the HD/compress decision is genuine.
vi.mock('../lib/attachments', async (importActual) => {
  const actual = await importActual<typeof import('../lib/attachments')>();
  return {
    ...actual,
    compressImage: vi.fn(async (f: File) => f),
    uploadAttachment: vi.fn(),
  };
});

// Socket stand-in so the throttled "typing" emit can be observed without a real
// connection. Only `emit` is exercised by the composer.
const socketMock = vi.hoisted(() => ({
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  connected: false,
}));

vi.mock('../lib/socket', () => ({
  getSocket: () => socketMock,
  connectSocket: () => {},
  disconnectSocket: () => {},
}));

const me: UserDTO = { id: 1, email: 'me@example.com', displayName: 'Me', isBot: false };
const alice: UserDTO = { id: 2, email: 'alice@example.com', displayName: 'Alice', isBot: false };

const dto: AttachmentDTO = {
  id: 7,
  kind: 'image',
  originalName: 'p.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 1234,
  width: 100,
  height: 80,
  hasThumb: true,
};

/** A File with a controllable reported size (drives the real shouldCompress). */
function fakeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size, configurable: true });
  return file;
}

// The composer persists unsent text to localStorage (per-chat drafts). Start
// every test from an empty store so a draft written by one case can't prefill
// the input in the next and skew unrelated assertions.
beforeEach(() => {
  localStorage.clear();
});

describe('Composer @mentions', () => {
  it('autocompletes a mention on Enter without submitting, then sends the picked id', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me, alice]} meId={me.id} chatId={10} />);

    const input = screen.getByPlaceholderText('Aa');

    // Typing '@al' opens the dropdown with the (non-me) member Alice.
    await userEvent.type(input, '@al');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /alice/i })).toBeInTheDocument();

    // Enter selects the highlighted candidate and must NOT submit the form.
    await userEvent.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('@Alice ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // A subsequent real send carries the content plus the mentioned id.
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('@Alice', [alice.id], [], undefined);
  });

  it('excludes me from the candidate list', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me, alice]} meId={me.id} chatId={10} />);

    await userEvent.type(screen.getByPlaceholderText('Aa'), '@');
    expect(screen.getByRole('option', { name: /alice/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^me$/i })).not.toBeInTheDocument();
  });
});

describe('Composer send failure', () => {
  it('restores the text and shows the server error when a send is rejected', async () => {
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new Error('String must contain at most 4000 character(s)'))
      .mockResolvedValueOnce(undefined);
    render(<Composer onSend={onSend} members={[me, alice]} meId={me.id} chatId={10} />);

    const input = screen.getByPlaceholderText('Aa');
    await userEvent.type(input, 'hello');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    // The rejection surfaces as a dismissible alert and the text is restored.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('String must contain at most 4000 character(s)');
    expect(input).toHaveValue('hello');

    // Retrying the send clears the error banner.
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(onSend).toHaveBeenCalledTimes(2);

    // Dismiss works too (provoke a fresh error, then close it).
    onSend.mockRejectedValueOnce(new Error('boom'));
    await userEvent.type(input, 'again');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not clobber text typed while the failed send was in flight', async () => {
    let reject!: (err: Error) => void;
    const onSend = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((_res, rej) => {
          reject = rej;
        }),
    );
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    const input = screen.getByPlaceholderText('Aa');
    await userEvent.type(input, 'first');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(input).toHaveValue(''); // optimistically cleared

    // User starts the next message while the send is pending, then it fails.
    await userEvent.type(input, 'second');
    reject(new Error('boom'));

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(input).toHaveValue('second'); // in-flight typing wins over the restore
  });
});

describe('Composer typing signal', () => {
  beforeEach(() => {
    // Prior describes' keystrokes also emit 'typing'; start each case from zero.
    socketMock.emit.mockClear();
  });

  it('emits typing at most once per 2s for rapid keystrokes', () => {
    // Drive the throttle clock directly so the 2s window is deterministic.
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      render(<Composer onSend={vi.fn()} members={[me, alice]} meId={me.id} chatId={10} />);
      const input = screen.getByPlaceholderText('Aa');

      // Three keystrokes inside the 2s window → exactly one emit.
      fireEvent.change(input, { target: { value: 'h' } });
      fireEvent.change(input, { target: { value: 'he' } });
      fireEvent.change(input, { target: { value: 'hel' } });
      expect(socketMock.emit).toHaveBeenCalledTimes(1);
      expect(socketMock.emit).toHaveBeenCalledWith('typing', 10);

      // Past the window, the next keystroke emits again.
      now += 2001;
      fireEvent.change(input, { target: { value: 'hell' } });
      expect(socketMock.emit).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not emit typing for empty input', () => {
    render(<Composer onSend={vi.fn()} members={[me]} meId={me.id} chatId={10} />);
    const input = screen.getByPlaceholderText('Aa');

    fireEvent.change(input, { target: { value: 'x' } }); // one non-empty emit
    fireEvent.change(input, { target: { value: '' } }); // cleared → no emit
    expect(socketMock.emit).toHaveBeenCalledTimes(1);
    expect(socketMock.emit).toHaveBeenCalledWith('typing', 10);
  });
});

describe('Composer reply mode', () => {
  /** A message to reply to, sent by Alice. */
  function replyTarget(over: Partial<MessageDTO> = {}): MessageDTO {
    return {
      id: 42,
      chatId: 10,
      sender: alice,
      content: 'the original message',
      mentions: [],
      attachments: [],
      reactions: [],
      replyTo: null,
      createdAt: new Date(1_700_000_000_000).toISOString(),
      editedAt: null,
      isDeleted: false,
      ...over,
    };
  }

  it('shows the reply banner with the target sender name and a snippet', () => {
    render(
      <Composer
        onSend={vi.fn()}
        members={[me, alice]}
        meId={me.id}
        chatId={10}
        replyingTo={replyTarget()}
        onCancelReply={vi.fn()}
      />,
    );
    expect(screen.getByText('Replying to Alice')).toBeInTheDocument();
    expect(screen.getByText('the original message')).toBeInTheDocument();
  });

  it('previews an attachment-only target as "📎 Attachment"', () => {
    render(
      <Composer
        onSend={vi.fn()}
        members={[me, alice]}
        meId={me.id}
        chatId={10}
        replyingTo={replyTarget({ content: '', attachments: [dto] })}
        onCancelReply={vi.fn()}
      />,
    );
    expect(screen.getByText('📎 Attachment')).toBeInTheDocument();
  });

  it('passes the reply target id through as the 4th onSend argument', async () => {
    const onSend = vi.fn();
    render(
      <Composer
        onSend={onSend}
        members={[me, alice]}
        meId={me.id}
        chatId={10}
        replyingTo={replyTarget({ id: 42 })}
        onCancelReply={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText('Aa'), 'my reply');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith('my reply', [], [], 42);
  });

  it('cancels the reply via the ✕ button', async () => {
    const onCancelReply = vi.fn();
    render(
      <Composer
        onSend={vi.fn()}
        members={[me]}
        meId={me.id}
        chatId={10}
        replyingTo={replyTarget()}
        onCancelReply={onCancelReply}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /cancel reply/i }));
    expect(onCancelReply).toHaveBeenCalledTimes(1);
  });

  it('cancels the reply on Escape (with the mention dropdown closed)', async () => {
    const onCancelReply = vi.fn();
    render(
      <Composer
        onSend={vi.fn()}
        members={[me]}
        meId={me.id}
        chatId={10}
        replyingTo={replyTarget()}
        onCancelReply={onCancelReply}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText('Aa'), '{Escape}');
    expect(onCancelReply).toHaveBeenCalledTimes(1);
  });
});

describe('Composer attachments', () => {
  beforeEach(() => {
    (uploadAttachment as Mock).mockResolvedValue(dto);
    (compressImage as Mock).mockImplementation(async (f: File) => f);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uploads a picked file, enables send, and passes the attachment id to onSend', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    // Send starts disabled with no text and no attachments.
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();

    const file = new File(['pdf'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });

    // Once the upload resolves, the send button enables.
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled());
    expect(uploadAttachment).toHaveBeenCalledWith(10, file, expect.any(Function));

    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith('', [], [dto.id], undefined);
  });

  it('compresses large images by default but skips compression when HD is active', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    const bigImage = fakeFile('holiday.jpg', 'image/jpeg', 3 * 1024 * 1024);
    expect(shouldCompress(bigImage)).toBe(true); // sanity: this file WOULD be compressed

    // Default (HD off): the image is compressed before upload.
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [bigImage] } });
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
    expect(compressImage).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    (uploadAttachment as Mock).mockResolvedValue(dto);

    // Toggle HD on, then pick again: compression is skipped, original is uploaded.
    await userEvent.click(screen.getByRole('button', { name: 'HD' }));
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [bigImage] } });
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
    expect(compressImage).not.toHaveBeenCalled();
    expect(uploadAttachment).toHaveBeenCalledWith(10, bigImage, expect.any(Function));
  });

  it('restores the attachment and shows the error when the send itself fails', async () => {
    const onSend = vi.fn().mockRejectedValueOnce(new Error('Invalid attachments'));
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    const file = new File(['pdf'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled());

    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    // The failure surfaces and the attachment is back in the preview strip.
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid attachments');
    expect(screen.getByRole('button', { name: /remove report\.pdf/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled();
  });

  it('shows an error tile and retries the upload on click when it fails', async () => {
    const onSend = vi.fn();
    (uploadAttachment as Mock).mockRejectedValueOnce(new Error('boom'));
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    const file = new File(['pdf'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });

    // The failed upload surfaces a retry affordance.
    const retry = await screen.findByRole('button', { name: /retry upload of report\.pdf/i });
    // Second attempt succeeds → send becomes available.
    await userEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled());
    expect(uploadAttachment).toHaveBeenCalledTimes(2);
  });

  it('drops a staged attachment (and revokes its preview URL) when chatId changes', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const props = { onSend: vi.fn(), members: [me], meId: me.id };
    const { rerender } = render(<Composer {...props} chatId={10} />);

    // An image gets an object-URL preview (unlike a plain file) — this is what
    // exercises the revoke path.
    const file = fakeFile('holiday.jpg', 'image/jpeg', 500 * 1024);
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled());
    expect(screen.getByLabelText('Attachments to send')).toBeInTheDocument();

    rerender(<Composer {...props} chatId={20} />);

    // The tile from chat 10 is gone and its blob URL was revoked; the chat-20
    // composer starts with no attachments, so send is disabled again.
    expect(screen.queryByLabelText('Attachments to send')).not.toBeInTheDocument();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();

    revokeSpy.mockRestore();
  });

  it('does not resurrect a tile when an old chat upload completes after switching', async () => {
    let resolveUpload!: (a: AttachmentDTO) => void;
    (uploadAttachment as Mock).mockImplementationOnce(
      () =>
        new Promise<AttachmentDTO>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const props = { onSend: vi.fn(), members: [me], meId: me.id };
    const { rerender } = render(<Composer {...props} chatId={10} />);

    const file = new File(['pdf'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
    expect(screen.getByLabelText('Attachments to send')).toBeInTheDocument();

    // Switch chats while the upload for chat 10 is still in flight.
    rerender(<Composer {...props} chatId={20} />);
    expect(screen.queryByLabelText('Attachments to send')).not.toBeInTheDocument();

    // The old chat's upload finally resolves — it must not bring the tile back.
    resolveUpload(dto);
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText('Attachments to send')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('clears the send-error banner when chatId changes', async () => {
    const onSend = vi.fn().mockRejectedValueOnce(new Error('boom'));
    const props = { onSend, members: [me], meId: me.id };
    const { rerender } = render(<Composer {...props} chatId={10} />);

    await userEvent.type(screen.getByPlaceholderText('Aa'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');

    rerender(<Composer {...props} chatId={20} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Composer voice recording', () => {
  // jsdom has neither getUserMedia nor MediaRecorder — stub both. Each stubbed
  // recorder captures the handlers the composer attaches; calling stop() flushes
  // one data chunk then fires onstop, mirroring a real recorder.
  class MockMediaRecorder {
    static instances: MockMediaRecorder[] = [];
    static isTypeSupported = (t: string) => t === 'audio/webm;codecs=opus';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    state: 'inactive' | 'recording' = 'inactive';
    mimeType: string;
    constructor(_stream: MediaStream, options?: { mimeType?: string }) {
      this.mimeType = options?.mimeType ?? 'audio/webm';
      MockMediaRecorder.instances.push(this);
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['voice-bytes'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }

  function installMediaStubs({ deny = false } = {}) {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const getUserMedia = deny
      ? vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
      : vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    MockMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', MockMediaRecorder as unknown as typeof MediaRecorder);
    return { track, getUserMedia };
  }

  beforeEach(() => {
    (uploadAttachment as Mock).mockResolvedValue(dto);
    (compressImage as Mock).mockImplementation(async (f: File) => f);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    vi.clearAllMocks();
  });

  it('hides the mic button when recording is unsupported (no MediaRecorder/getUserMedia)', () => {
    render(<Composer onSend={vi.fn()} members={[me]} meId={me.id} chatId={10} />);
    expect(screen.queryByRole('button', { name: /record voice message/i })).not.toBeInTheDocument();
  });

  it('hides the mic button in edit mode (like attachments)', () => {
    installMediaStubs();
    const editing: MessageDTO = {
      id: 5,
      chatId: 10,
      sender: me,
      content: 'edit me',
      mentions: [],
      attachments: [],
      reactions: [],
      replyTo: null,
      createdAt: new Date(1_700_000_000_000).toISOString(),
      editedAt: null,
      isDeleted: false,
    };
    render(
      <Composer
        onSend={vi.fn()}
        members={[me]}
        meId={me.id}
        chatId={10}
        editing={editing}
        onEditSubmit={vi.fn()}
        onCancelEdit={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /record voice message/i })).not.toBeInTheDocument();
  });

  it('records, then the captured blob enters the pending flow with a voice-*.webm audio file', async () => {
    installMediaStubs();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    // Start: the recording bar with its elapsed-time label replaces the input row.
    await userEvent.click(screen.getByRole('button', { name: /record voice message/i }));
    const bar = await screen.findByTestId('recording-bar');
    expect(within(bar).getByRole('timer')).toHaveTextContent('Recording 0:00');

    // Stop finalizes: the blob is wrapped and uploaded through the normal pipeline.
    await userEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));

    const [chatArg, fileArg] = (uploadAttachment as Mock).mock.calls[0]!;
    expect(chatArg).toBe(10);
    expect(fileArg).toBeInstanceOf(File);
    expect((fileArg as File).name).toMatch(/^voice-\d+\.webm$/);
    expect((fileArg as File).type).toBe('audio/webm');
    // Voice notes are never image-compressed.
    expect(compressImage).not.toHaveBeenCalled();

    // The pending strip shows the file chip and the recording bar is gone.
    expect(screen.getByLabelText('Attachments to send')).toBeInTheDocument();
    expect(screen.queryByTestId('recording-bar')).not.toBeInTheDocument();

    // Sending carries the uploaded audio attachment id.
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith('', [], [dto.id], undefined);
  });

  it('cancel discards the capture, stops the mic tracks, and enqueues nothing', async () => {
    const { track } = installMediaStubs();
    render(<Composer onSend={vi.fn()} members={[me]} meId={me.id} chatId={10} />);

    await userEvent.click(screen.getByRole('button', { name: /record voice message/i }));
    await screen.findByTestId('recording-bar');

    await userEvent.click(screen.getByRole('button', { name: /cancel recording/i }));

    // No upload, bar dismissed, and the mic track was released.
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recording-bar')).not.toBeInTheDocument();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Attachments to send')).not.toBeInTheDocument();
  });

  it('shows a dismissible error when microphone permission is denied', async () => {
    installMediaStubs({ deny: true });
    render(<Composer onSend={vi.fn()} members={[me]} meId={me.id} chatId={10} />);

    await userEvent.click(screen.getByRole('button', { name: /record voice message/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/microphone access was denied/i);
    // The recorder never started, so no recording bar.
    expect(screen.queryByTestId('recording-bar')).not.toBeInTheDocument();
  });

  it('cancels an in-progress recording and releases the mic when the chat switches', async () => {
    const { track } = installMediaStubs();
    const props = { onSend: vi.fn(), members: [me], meId: me.id };
    const { rerender } = render(<Composer {...props} chatId={10} />);

    await userEvent.click(screen.getByRole('button', { name: /record voice message/i }));
    await screen.findByTestId('recording-bar');

    rerender(<Composer {...props} chatId={20} />);

    // The capture is abandoned, the bar is gone, the mic is freed, and nothing
    // rode into the new chat.
    expect(screen.queryByTestId('recording-bar')).not.toBeInTheDocument();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Attachments to send')).not.toBeInTheDocument();
  });
});

describe('Composer multiline textarea', () => {
  it('inserts a newline on Enter without submitting', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    const input = screen.getByPlaceholderText('Aa');
    await userEvent.type(input, 'line one{Enter}line two');

    // Enter is a plain newline in the textarea — it must NOT send.
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('line one\nline two');
  });

  it('sends on Shift+Enter', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    const input = screen.getByPlaceholderText('Aa');
    await userEvent.type(input, 'hello');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('hello', [], [], undefined);
  });

  it('sends on Ctrl+Enter', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    const input = screen.getByPlaceholderText('Aa');
    await userEvent.type(input, 'hello');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('hello', [], [], undefined);
  });

  it('still sends via the on-screen send button (the primary mobile affordance)', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    await userEvent.type(screen.getByPlaceholderText('Aa'), 'tap send');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(onSend).toHaveBeenCalledWith('tap send', [], [], undefined);
  });

  it('does not send an Enter while the mention dropdown is open (selects instead)', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me, alice]} meId={me.id} chatId={10} />);

    const input = screen.getByPlaceholderText('Aa');
    await userEvent.type(input, '@al');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');

    // Dropdown was open → Shift+Enter selects the candidate rather than sending.
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('@Alice ');
  });
});

describe('Composer drafts', () => {
  /** Build a message for edit-mode prefill scenarios. */
  function message(over: Partial<MessageDTO> = {}): MessageDTO {
    return {
      id: 99,
      chatId: 10,
      sender: me,
      content: 'original text',
      mentions: [],
      attachments: [],
      reactions: [],
      replyTo: null,
      createdAt: new Date(1_700_000_000_000).toISOString(),
      editedAt: null,
      isDeleted: false,
      ...over,
    };
  }

  it('persists typed text to localStorage keyed by chat id', async () => {
    render(<Composer onSend={vi.fn()} members={[me]} meId={me.id} chatId={10} />);
    await userEvent.type(screen.getByPlaceholderText('Aa'), 'unsent draft');
    expect(localStorage.getItem('draft:chat:10')).toBe('unsent draft');
  });

  it('restores the saved draft when it mounts', () => {
    localStorage.setItem('draft:chat:10', 'welcome back');
    render(<Composer onSend={vi.fn()} members={[me]} meId={me.id} chatId={10} />);
    expect(screen.getByPlaceholderText('Aa')).toHaveValue('welcome back');
  });

  it('swaps to the other chat draft when chatId changes (no remount)', () => {
    localStorage.setItem('draft:chat:10', 'for chat ten');
    localStorage.setItem('draft:chat:20', 'for chat twenty');
    const props = { onSend: vi.fn(), members: [me], meId: me.id };
    const { rerender } = render(<Composer {...props} chatId={10} />);
    expect(screen.getByPlaceholderText('Aa')).toHaveValue('for chat ten');

    rerender(<Composer {...props} chatId={20} />);
    expect(screen.getByPlaceholderText('Aa')).toHaveValue('for chat twenty');
  });

  it('removes the draft key once the text is emptied', async () => {
    render(<Composer onSend={vi.fn()} members={[me]} meId={me.id} chatId={10} />);
    const input = screen.getByPlaceholderText('Aa');
    await userEvent.type(input, 'x');
    expect(localStorage.getItem('draft:chat:10')).toBe('x');

    await userEvent.clear(input);
    expect(localStorage.getItem('draft:chat:10')).toBeNull();
  });

  it('clears the draft after a successful send', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    await userEvent.type(screen.getByPlaceholderText('Aa'), 'goodbye');
    expect(localStorage.getItem('draft:chat:10')).toBe('goodbye');

    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(localStorage.getItem('draft:chat:10')).toBeNull();
    expect(screen.getByPlaceholderText('Aa')).toHaveValue('');
  });

  it('re-persists the draft when a send fails', async () => {
    const onSend = vi.fn().mockRejectedValueOnce(new Error('boom'));
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    await userEvent.type(screen.getByPlaceholderText('Aa'), 'keep me');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByPlaceholderText('Aa')).toHaveValue('keep me');
    expect(localStorage.getItem('draft:chat:10')).toBe('keep me');
  });

  it('does not overwrite the draft when entering edit mode, and restores it on cancel', () => {
    localStorage.setItem('draft:chat:10', 'my draft');
    const props = { onSend: vi.fn(), members: [me], meId: me.id, chatId: 10 };
    const { rerender } = render(<Composer {...props} />);
    expect(screen.getByPlaceholderText('Aa')).toHaveValue('my draft');

    // Entering edit mode prefills the message text but must leave the draft intact.
    rerender(
      <Composer {...props} editing={message()} onEditSubmit={vi.fn()} onCancelEdit={vi.fn()} />,
    );
    expect(screen.getByPlaceholderText('Aa')).toHaveValue('original text');
    expect(localStorage.getItem('draft:chat:10')).toBe('my draft');

    // Cancelling the edit brings the draft back into the input.
    rerender(<Composer {...props} editing={null} />);
    expect(screen.getByPlaceholderText('Aa')).toHaveValue('my draft');
    expect(localStorage.getItem('draft:chat:10')).toBe('my draft');
  });
});

describe('Composer paste and drop', () => {
  beforeEach(() => {
    (uploadAttachment as Mock).mockResolvedValue(dto);
    (compressImage as Mock).mockImplementation(async (f: File) => f);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uploads an image pasted into the composer', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />);

    // A small PNG (under the compress threshold) uploads as-is.
    const file = fakeFile('screenshot.png', 'image/png', 500 * 1024);
    fireEvent.paste(screen.getByPlaceholderText('Aa'), {
      clipboardData: { files: [file], items: [], getData: () => '' },
    });

    await waitFor(() =>
      expect(uploadAttachment).toHaveBeenCalledWith(10, file, expect.any(Function)),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled());
  });

  it('ignores a plain-text paste (no files)', () => {
    render(<Composer onSend={vi.fn()} members={[me]} meId={me.id} chatId={10} />);
    fireEvent.paste(screen.getByPlaceholderText('Aa'), {
      clipboardData: { files: [], items: [], getData: () => 'just text' },
    });
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('uploads a non-image file dropped onto the composer, same as picking it', async () => {
    const onSend = vi.fn();
    const { container } = render(
      <Composer onSend={onSend} members={[me]} meId={me.id} chatId={10} />,
    );
    const form = container.querySelector('form')!;

    const file = new File(['pdf'], 'dropped.pdf', { type: 'application/pdf' });
    const dataTransfer = { files: [file], items: [], types: ['Files'] };
    fireEvent.dragOver(form, { dataTransfer });
    fireEvent.drop(form, { dataTransfer });

    await waitFor(() =>
      expect(uploadAttachment).toHaveBeenCalledWith(10, file, expect.any(Function)),
    );
    // Non-image → uploaded without compression, just like the file picker.
    expect(compressImage).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled());
  });
});
