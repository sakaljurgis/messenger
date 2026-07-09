import { useEffect } from 'react';
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

/**
 * Full-screen image viewer. Shows the uploaded (non-thumbnail) image, a download
 * and close control top-right, and the file name + size as a caption. Closes on
 * backdrop click and Escape; the image, controls, and caption swallow clicks so
 * they don't dismiss it.
 */
export default function Lightbox({
  attachment,
  onClose,
}: {
  attachment: AttachmentDTO;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={attachment.originalName}
      onClick={onClose}
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

      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-4 left-0 right-0 px-4 text-center text-sm text-white/80"
      >
        {attachment.originalName} · {formatBytes(attachment.sizeBytes)}
      </div>
    </div>
  );
}
