import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
