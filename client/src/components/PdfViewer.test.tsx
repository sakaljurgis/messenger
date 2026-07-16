import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AttachmentDTO } from '@messenger/shared';
import PdfViewer from './PdfViewer';
import type { PdfDocumentLike, PdfPageLike } from '../lib/pdf';

const pdf: AttachmentDTO = {
  id: 9,
  kind: 'file',
  originalName: 'report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 3_355_443,
  width: null,
  height: null,
  hasThumb: false,
};

/** A fake pdf.js document: N A4-ish pages whose render() resolves immediately. */
function fakeDoc(numPages: number): PdfDocumentLike & { destroy: ReturnType<typeof vi.fn> } {
  const page: PdfPageLike = {
    getViewport: ({ scale }) => ({ width: 595 * scale, height: 842 * scale }),
    render: () => ({ promise: Promise.resolve() }),
  };
  return {
    numPages,
    getPage: async () => page,
    destroy: vi.fn(async () => {}),
  };
}

describe('PdfViewer', () => {
  it('renders every page of the loaded document with header controls', async () => {
    const doc = fakeDoc(3);
    const loadPdf = vi.fn(async () => doc);
    render(<PdfViewer attachment={pdf} onClose={() => {}} loadPdf={loadPdf} />);

    const dialog = await screen.findByRole('dialog', { name: 'report.pdf' });
    expect(loadPdf).toHaveBeenCalledWith('/api/attachments/9');

    // All three pages appear once the document resolves.
    await screen.findByTestId('pdf-page-1');
    expect(screen.getByTestId('pdf-page-2')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-page-3')).toBeInTheDocument();

    // Header: name + size, a download link, and a close button.
    expect(within(dialog).getByText('report.pdf')).toBeInTheDocument();
    expect(within(dialog).getByText('3.2 MB')).toBeInTheDocument();
    const download = within(dialog).getByRole('link', { name: 'Download' });
    expect(download.getAttribute('href')).toBe('/api/attachments/9?download=1');
    expect(download).toHaveAttribute('download', 'report.pdf');
  });

  it('closes via the ✕ button and Escape, and destroys the document on unmount', async () => {
    const doc = fakeDoc(1);
    const onClose = vi.fn();
    const { unmount } = render(
      <PdfViewer attachment={pdf} onClose={onClose} loadPdf={async () => doc} />,
    );
    await screen.findByTestId('pdf-page-1');

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);

    unmount();
    expect(doc.destroy).toHaveBeenCalled();
  });

  it('shows an error state with a download fallback when the PDF cannot be parsed', async () => {
    render(
      <PdfViewer
        attachment={pdf}
        onClose={() => {}}
        loadPdf={async () => {
          throw new Error('bad pdf');
        }}
      />,
    );

    await screen.findByText("Couldn't display this PDF.");
    const fallback = screen.getByRole('link', { name: 'Download instead' });
    expect(fallback.getAttribute('href')).toBe('/api/attachments/9?download=1');
  });

  it('shows a spinner while the document is loading', async () => {
    render(
      <PdfViewer attachment={pdf} onClose={() => {}} loadPdf={() => new Promise(() => {})} />,
    );
    expect(screen.getByRole('status', { name: 'Loading PDF' })).toBeInTheDocument();
    // Stays pending — no pages, no error.
    await waitFor(() => {
      expect(screen.queryByTestId('pdf-page-1')).not.toBeInTheDocument();
      expect(screen.queryByText("Couldn't display this PDF.")).not.toBeInTheDocument();
    });
  });
});
