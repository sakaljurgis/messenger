// Client-side attachment helpers: image compression (canvas), multipart upload
// with progress, URL building, byte formatting, and chat-list preview text.
//
// The two-step flow: the composer uploads a file to the chat (POST
// /api/chats/:id/attachments) and gets back an AttachmentDTO id, which is then
// linked to a message on send. Images are downscaled/re-encoded by default (with
// an HD escape hatch in the composer) to keep uploads small.

import type { AttachmentDTO } from '@messenger/shared';
import { ApiError, extractErrorMessage } from './api';

const ONE_MB = 1024 * 1024;

/** Image types we re-encode client-side. GIF (animation) and SVG (vector) are left alone. */
const COMPRESSIBLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Whether an image is worth compressing before upload: a supported raster type
 * and larger than ~1MB (small files barely shrink and may even grow).
 */
export function shouldCompress(file: File): boolean {
  return COMPRESSIBLE_TYPES.has(file.type) && file.size > ONE_MB;
}

export interface CompressOptions {
  /** Longest edge of the output, in pixels. Never upscales. */
  maxDim?: number;
  /** JPEG quality 0..1. */
  quality?: number;
}

/**
 * Downscale (never upscale) an image so its longest edge is ≤ maxDim and
 * re-encode it as JPEG. Returns a new `<base>.jpg` File, unless the result would
 * be larger than the original (or anything fails), in which case the original
 * File is returned untouched.
 */
export async function compressImage(
  file: File,
  { maxDim = 2048, quality = 0.85 }: CompressOptions = {},
): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    if (typeof bitmap.close === 'function') bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
    });
    // Bail if encoding failed or the "compressed" file grew (e.g. tiny image).
    if (!blob || blob.size > file.size) return file;

    const base = file.name.replace(/\.[^./\\]+$/, '') || 'image';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/**
 * Upload a single file to a chat via XMLHttpRequest (fetch offers no upload
 * progress). Resolves with the created AttachmentDTO; rejects with an ApiError
 * carrying the server's `{ error }` message and HTTP status.
 */
export function uploadAttachment(
  chatId: number,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<AttachmentDTO> {
  return new Promise<AttachmentDTO>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file);

    xhr.open('POST', `/api/chats/${chatId}/attachments`);
    xhr.withCredentials = true;

    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(event.loaded / event.total);
        }
      };
    }

    xhr.onload = () => {
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = undefined;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        const attachment = (data as { attachment?: AttachmentDTO } | undefined)?.attachment;
        if (attachment) {
          resolve(attachment);
        } else {
          reject(new ApiError(xhr.status, 'Malformed upload response'));
        }
        return;
      }

      const message =
        extractErrorMessage(data) ?? xhr.statusText ?? `Upload failed with status ${xhr.status}`;
      reject(new ApiError(xhr.status, message));
    };

    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled'));

    xhr.send(form);
  });
}

/** Build the streaming URL for an attachment, optionally the thumbnail or download variant. */
export function attachmentUrl(
  id: number,
  opts: { thumb?: boolean; download?: boolean } = {},
): string {
  const params = new URLSearchParams();
  if (opts.thumb) params.set('thumb', '1');
  if (opts.download) params.set('download', '1');
  const query = params.toString();
  return `/api/attachments/${id}${query ? `?${query}` : ''}`;
}

/** Human-readable byte size, e.g. `3.2 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i] ?? 'TB'}`;
}

/**
 * Chat-list preview for a message whose text is empty: a photo count when every
 * attachment is an image, otherwise a paperclip with the first file's name.
 */
export function attachmentPreviewText(attachments: AttachmentDTO[]): string {
  if (attachments.length === 0) return '';
  const firstFile = attachments.find((a) => a.kind === 'file');
  if (firstFile) return `📎 ${firstFile.originalName}`;
  return attachments.length === 1 ? '📷 Photo' : `📷 ${attachments.length} photos`;
}
