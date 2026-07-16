import { useEffect, useRef, useState } from 'react';
import type { AttachmentDTO } from '@messenger/shared';
import { attachmentUrl, formatBytes } from '../lib/attachments';
import { openPdfDocument, type PdfDocumentLike } from '../lib/pdf';

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Widest a rendered page gets on large screens; phones use the full width. */
const MAX_PAGE_WIDTH = 900;
/** Horizontal breathing room around pages (px, both sides combined). */
const PAGE_GUTTER = 16;

function pageWidth(): number {
  return Math.min(window.innerWidth - PAGE_GUTTER, MAX_PAGE_WIDTH);
}

/**
 * One rasterized PDF page. Renders at `width` CSS pixels scaled by
 * devicePixelRatio for sharpness. Rendering failures (or a null 2D context,
 * as in jsdom) leave the white placeholder canvas rather than breaking the
 * viewer — neighboring pages are unaffected.
 */
function PdfPage({
  doc,
  pageNumber,
  width,
}: {
  doc: PdfDocumentLike;
  pageNumber: number;
  width: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [height, setHeight] = useState(() => Math.round(width * 1.414)); // A4-ish placeholder

  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (canceled) return;
        const base = page.getViewport({ scale: 1 });
        const cssHeight = Math.round((width / base.width) * base.height);
        setHeight(cssHeight);
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: (width / base.width) * dpr });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvas, viewport }).promise;
      } catch {
        // leave the blank page — the rest of the document still renders
      }
    })();
    return () => {
      canceled = true;
    };
  }, [doc, pageNumber, width]);

  return (
    <canvas
      ref={canvasRef}
      data-testid={`pdf-page-${pageNumber}`}
      aria-label={`Page ${pageNumber}`}
      className="mx-auto mb-3 rounded bg-white shadow-lg"
      style={{ width, height }}
    />
  );
}

/**
 * Full-screen in-app PDF viewer (pdf.js): a dark overlay with a header (file
 * name + size, download, close) above a vertically scrolling stack of
 * rasterized pages. Exists because navigating to the PDF URL strands the
 * installed-PWA user on a view with no back affordance — this never leaves the
 * app. Closes on Escape or the ✕ (never on backdrop taps: the whole surface
 * is scrollable content). `loadPdf` is injectable for tests; the default
 * lazy-loads pdfjs-dist on first use.
 */
export default function PdfViewer({
  attachment,
  onClose,
  loadPdf = openPdfDocument,
}: {
  attachment: AttachmentDTO;
  onClose: () => void;
  loadPdf?: (url: string) => Promise<PdfDocumentLike>;
}) {
  const [doc, setDoc] = useState<PdfDocumentLike | null>(null);
  const [error, setError] = useState(false);
  // Page width tracks the viewport (rotation, window resize re-rasterizes).
  const [width, setWidth] = useState(pageWidth);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    function onResize() {
      setWidth(pageWidth());
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    let canceled = false;
    let opened: PdfDocumentLike | null = null;
    setDoc(null);
    setError(false);
    loadPdf(attachmentUrl(attachment.id))
      .then((d) => {
        opened = d;
        if (canceled) void d.destroy();
        else setDoc(d);
      })
      .catch(() => {
        if (!canceled) setError(true);
      });
    return () => {
      canceled = true;
      if (opened) void opened.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.id]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={attachment.originalName}
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
    >
      <div className="flex flex-shrink-0 items-center gap-2 px-3 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
        <span className="flex min-w-0 flex-1 flex-col text-white">
          <span className="truncate text-sm font-medium">{attachment.originalName}</span>
          <span className="text-xs text-white/60">{formatBytes(attachment.sizeBytes)}</span>
        </span>
        <a
          href={attachmentUrl(attachment.id, { download: true })}
          download={attachment.originalName}
          aria-label="Download"
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <DownloadIcon />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 pb-[env(safe-area-inset-bottom)]">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-white/80">
            <p className="text-sm">Couldn't display this PDF.</p>
            <a
              href={attachmentUrl(attachment.id, { download: true })}
              download={attachment.originalName}
              className="rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
            >
              Download instead
            </a>
          </div>
        ) : doc ? (
          Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage key={i + 1} doc={doc} pageNumber={i + 1} width={width} />
          ))
        ) : (
          <div className="flex h-full items-center justify-center" role="status" aria-label="Loading PDF">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/20 border-t-white" />
          </div>
        )}
      </div>
    </div>
  );
}
