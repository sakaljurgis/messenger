import { useEffect, useRef, useState } from 'react';
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

/** Slide animation duration; also the commit timer for a settle. */
const SLIDE_MS = 250;
/** Minimum horizontal travel (px) for a released drag to change photo. */
const SWIPE_COMMIT_PX = 48;
/** Finger travel before a touch is treated as a horizontal drag at all. */
const DRAG_INTENT_PX = 8;
/** How much an edge drag (no neighbor that way) follows the finger. */
const EDGE_RESISTANCE = 0.25;

/**
 * Full-screen image viewer. Shows the uploaded (non-thumbnail) image, a download
 * and close control top-right, and the file name + size as a caption. Closes on
 * backdrop click and Escape; the image, controls, and caption swallow clicks so
 * they don't dismiss it.
 *
 * When `images` (the ordered photos of the loaded chat window) is provided, the
 * lightbox becomes a sliding carousel: the previous/current/next photos sit on
 * a 3-slot track (which doubles as neighbor preloading), a touch drag moves the
 * track with the finger and snaps — past SWIPE_COMMIT_PX the neighbor slides
 * in, otherwise the current photo springs back — and prev/next chevrons
 * (desktop, sm+) and ArrowLeft/Right keys animate the same slide. An "n / y"
 * chip sits top-center. Navigation commits (onNavigate) when the slide
 * animation lands, driven by a timer so a spammed input can't tear the track.
 * With a single photo (or when the current attachment isn't in the list) all
 * navigation affordances disappear.
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

  // Live finger offset (px) while dragging; the track follows it 1:1.
  const [dragX, setDragX] = useState(0);
  // Which neighbor the track is animating toward (+1 = next, -1 = prev);
  // null when idle. While set, all other navigation input is ignored.
  const [settle, setSettle] = useState<1 | -1 | null>(null);
  // Where the current touch began; null when it began on a control (buttons/
  // links must never double as swipe surfaces) or when there's no touch.
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  // True once the touch has shown horizontal intent (drives transition on/off).
  const dragging = useRef(false);
  // A drag's touchend is often followed by a synthetic click on whatever is
  // under the finger — swallow exactly one so a swipe can't close the viewer.
  const suppressClick = useRef(false);
  // Commit is a timer, not transitionend: identical behavior in jsdom (no
  // transition events) and a guaranteed landing even if a frame is dropped.
  const commitTimer = useRef<number | null>(null);
  // The commit render swaps the new current photo into the centered slot; the
  // track must snap (not animate) back to center on that one render.
  const skipTransition = useRef(false);

  useEffect(() => {
    skipTransition.current = false;
  });

  useEffect(() => {
    return () => {
      if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    };
  }, []);

  /** Animate the track one slot toward `dir` and commit when it lands. */
  function beginSettle(dir: 1 | -1) {
    if (settle !== null || !canNavigate) return;
    const target = dir === 1 ? next : prev;
    if (!target) return;
    setSettle(dir);
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = null;
      skipTransition.current = true;
      setSettle(null);
      setDragX(0);
      onNavigate?.(target);
    }, SLIDE_MS);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') beginSettle(-1);
      if (e.key === 'ArrowRight') beginSettle(1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, onNavigate, canNavigate, prev, next, settle]);

  const slides: { image: AttachmentDTO; pos: number }[] = canNavigate
    ? [
        ...(prev ? [{ image: prev, pos: -1 }] : []),
        { image: attachment, pos: 0 },
        ...(next ? [{ image: next, pos: 1 }] : []),
      ]
    : [{ image: attachment, pos: 0 }];

  const trackTransform =
    settle !== null
      ? `translateX(${settle * -100}%)`
      : `translateX(${dragX}px)`;
  const trackTransition =
    dragging.current || skipTransition.current ? 'none' : `transform ${SLIDE_MS}ms ease-out`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={attachment.originalName}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        onClose();
      }}
      onTouchStart={(e) => {
        // A new gesture starts clean: if the previous drag's synthetic click
        // never came (browsers vary), the stale suppression must not eat the
        // next real tap.
        suppressClick.current = false;
        if (settle !== null || (e.target as HTMLElement).closest('a, button')) {
          dragStart.current = null;
          return;
        }
        const t = e.touches[0];
        dragStart.current = t ? { x: t.clientX, y: t.clientY } : null;
      }}
      onTouchMove={(e) => {
        const start = dragStart.current;
        if (!start || settle !== null || !canNavigate) return;
        const t = e.touches[0];
        if (!t) return;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (!dragging.current) {
          // Mostly-vertical movement is not a swipe — leave it alone entirely.
          if (Math.abs(dx) < DRAG_INTENT_PX || Math.abs(dx) <= Math.abs(dy)) return;
          dragging.current = true;
        }
        const pastEdge = (dx > 0 && !prev) || (dx < 0 && !next);
        setDragX(pastEdge ? dx * EDGE_RESISTANCE : dx);
      }}
      onTouchEnd={(e) => {
        const start = dragStart.current;
        dragStart.current = null;
        const wasDragging = dragging.current;
        dragging.current = false;
        if (!wasDragging || settle !== null) return;
        suppressClick.current = true;
        const t = e.changedTouches[0];
        const dx = t ? t.clientX - start!.x : 0;
        if (dx <= -SWIPE_COMMIT_PX && next) beginSettle(1);
        else if (dx >= SWIPE_COMMIT_PX && prev) beginSettle(-1);
        else setDragX(0); // spring back (transition is back on now)
      }}
      className="fixed inset-0 z-50 touch-none overflow-hidden bg-black/90"
    >
      <div
        className="absolute inset-0"
        style={{ transform: trackTransform, transition: trackTransition }}
      >
        {slides.map(({ image, pos }) => (
          <div
            key={image.id}
            className="absolute inset-y-0 w-full flex items-center justify-center"
            style={{ left: `${pos * 100}%` }}
          >
            <img
              src={attachmentUrl(image.id)}
              alt={image.originalName}
              onClick={(e) => e.stopPropagation()}
              className="max-h-[90vh] max-w-[95vw] object-contain"
            />
          </div>
        ))}
      </div>

      {index >= 0 && images.length > 1 && (
        <div className="absolute left-1/2 top-3 -translate-x-1/2 pt-[env(safe-area-inset-top)]">
          <span className="rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium text-white">
            {index + 1} / {images.length}
          </span>
        </div>
      )}

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
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <CloseIcon />
        </button>
      </div>

      {canNavigate && prev && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            beginSettle(-1);
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
            beginSettle(1);
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
        {attachment.originalName} · {formatBytes(attachment.sizeBytes)}
      </div>
    </div>
  );
}
