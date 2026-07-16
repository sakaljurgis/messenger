import { useEffect, useRef } from 'react';
import type { AttachmentDTO } from '@messenger/shared';
import { attachmentUrl, formatBytes } from '../lib/attachments';

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

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** Minimum horizontal travel (px) for a touch gesture to count as a swipe. */
const SWIPE_THRESHOLD_PX = 48;

/**
 * Full-screen image viewer. Shows the uploaded (non-thumbnail) image, a download
 * and close control top-right, and the file name + size as a caption. Closes on
 * backdrop click and Escape; the image, controls, and caption swallow clicks so
 * they don't dismiss it.
 *
 * When `images` (the ordered photos of the loaded chat window) is provided, the
 * lightbox becomes a gallery: prev/next chevrons (desktop, sm+), ArrowLeft/Right
 * keys, and a horizontal swipe (mobile) step through it via `onNavigate`, and a
 * "3 / 12" position counter joins the caption. With a single image (or when the
 * current attachment isn't in the list) all navigation affordances disappear.
 */
export default function Lightbox({
  attachment,
  images = [],
  onNavigate,
  onClose,
}: {
  attachment: AttachmentDTO;
  /** Ordered gallery this attachment belongs to (all loaded chat photos). */
  images?: AttachmentDTO[];
  /** Show a neighboring gallery image (prev/next); required for navigation. */
  onNavigate?: (a: AttachmentDTO) => void;
  onClose: () => void;
}) {
  const index = images.findIndex((a) => a.id === attachment.id);
  const prev = index > 0 ? images[index - 1] : undefined;
  const next = index >= 0 && index < images.length - 1 ? images[index + 1] : undefined;
  const canNavigate = onNavigate !== undefined;
  // Where the current touch gesture started; null when it began on a control
  // (buttons/links must never double as swipe surfaces).
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (!canNavigate) return;
      if (e.key === 'ArrowLeft' && prev) onNavigate(prev);
      if (e.key === 'ArrowRight' && next) onNavigate(next);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNavigate, canNavigate, prev, next]);

  // Preload the neighbors so stepping through the gallery feels instant.
  useEffect(() => {
    for (const neighbor of [prev, next]) {
      if (neighbor) new Image().src = attachmentUrl(neighbor.id);
    }
  }, [prev, next]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={attachment.originalName}
      onClick={onClose}
      onTouchStart={(e) => {
        if ((e.target as HTMLElement).closest('a, button')) {
          touchStart.current = null;
          return;
        }
        const t = e.touches[0];
        touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
      }}
      onTouchEnd={(e) => {
        const start = touchStart.current;
        touchStart.current = null;
        if (!start || !canNavigate) return;
        const t = e.changedTouches[0];
        if (!t) return;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return;
        // Swipe left → the next photo slides in; swipe right → the previous.
        const target = dx < 0 ? next : prev;
        if (target) onNavigate(target);
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
    >
      <div className="absolute right-3 top-3 flex items-center gap-2 pt-[env(safe-area-inset-top)]">
        <a
          href={attachmentUrl(attachment.id, { download: true })}
          download={attachment.originalName}
          onClick={(e) => e.stopPropagation()}
          aria-label="Download"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <DownloadIcon />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <CloseIcon />
        </button>
      </div>

      <img
        src={attachmentUrl(attachment.id)}
        alt={attachment.originalName}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[95vw] object-contain"
      />

      {canNavigate && prev && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(prev);
          }}
          aria-label="Previous photo"
          className="absolute left-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 sm:flex"
        >
          <ChevronLeftIcon />
        </button>
      )}
      {canNavigate && next && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(next);
          }}
          aria-label="Next photo"
          className="absolute right-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 sm:flex"
        >
          <ChevronRightIcon />
        </button>
      )}

      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-4 left-0 right-0 px-4 text-center text-sm text-white/80"
      >
        {index >= 0 && images.length > 1 && (
          <span className="mr-2 text-white/60">{`${index + 1} / ${images.length}`}</span>
        )}
        {attachment.originalName} · {formatBytes(attachment.sizeBytes)}
      </div>
    </div>
  );
}
