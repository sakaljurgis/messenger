import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDTO } from '@messenger/shared';
import {
  attachmentPreviewText,
  attachmentUrl,
  compressImage,
  formatBytes,
  shouldCompress,
  uploadAttachment,
} from './attachments';

/** A File with a controllable reported size (jsdom derives size from the parts otherwise). */
function fakeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size, configurable: true });
  return file;
}

function image(id: number, name = `${id}.jpg`): AttachmentDTO {
  return {
    id,
    kind: 'image',
    originalName: name,
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
    width: 100,
    height: 100,
    hasThumb: true,
  };
}

function doc(id: number, name: string): AttachmentDTO {
  return {
    id,
    kind: 'file',
    originalName: name,
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    width: null,
    height: null,
    hasThumb: false,
  };
}

const MB = 1024 * 1024;

describe('shouldCompress', () => {
  it('compresses large jpeg/png/webp images', () => {
    expect(shouldCompress(fakeFile('a.jpg', 'image/jpeg', 2 * MB))).toBe(true);
    expect(shouldCompress(fakeFile('a.png', 'image/png', 2 * MB))).toBe(true);
    expect(shouldCompress(fakeFile('a.webp', 'image/webp', 2 * MB))).toBe(true);
  });

  it('skips gif and svg (animation / vector)', () => {
    expect(shouldCompress(fakeFile('a.gif', 'image/gif', 2 * MB))).toBe(false);
    expect(shouldCompress(fakeFile('a.svg', 'image/svg+xml', 2 * MB))).toBe(false);
  });

  it('skips small images (barely shrink, might grow)', () => {
    expect(shouldCompress(fakeFile('a.jpg', 'image/jpeg', 500 * 1024))).toBe(false);
  });

  it('skips non-image files', () => {
    expect(shouldCompress(fakeFile('a.pdf', 'application/pdf', 2 * MB))).toBe(false);
  });

  it('skips videos (uploaded as-is, never re-encoded client-side)', () => {
    expect(shouldCompress(fakeFile('a.mp4', 'video/mp4', 2 * MB))).toBe(false);
    expect(shouldCompress(fakeFile('a.webm', 'video/webm', 2 * MB))).toBe(false);
  });
});

describe('compressImage', () => {
  let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let origToBlob: typeof HTMLCanvasElement.prototype.toBlob;

  beforeEach(() => {
    origGetContext = HTMLCanvasElement.prototype.getContext;
    origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: vi.fn() })) as never;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })),
    );
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = origGetContext;
    HTMLCanvasElement.prototype.toBlob = origToBlob;
    vi.unstubAllGlobals();
  });

  it('re-encodes to a smaller <base>.jpg when compression helps', async () => {
    HTMLCanvasElement.prototype.toBlob = function toBlob(cb: BlobCallback) {
      cb({ size: 100 } as Blob);
    };
    const file = fakeFile('DSC_0001.PNG', 'image/png', 5 * MB);
    const result = await compressImage(file);
    expect(result).not.toBe(file);
    expect(result.name).toBe('DSC_0001.jpg');
    expect(result.type).toBe('image/jpeg');
  });

  it('keeps the original when the compressed blob is larger', async () => {
    HTMLCanvasElement.prototype.toBlob = function toBlob(cb: BlobCallback) {
      cb({ size: 10 * MB } as Blob);
    };
    const file = fakeFile('tiny.png', 'image/png', 500);
    const result = await compressImage(file);
    expect(result).toBe(file);
  });

  it('returns the original when anything throws', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('decode failed');
      }),
    );
    const file = fakeFile('bad.png', 'image/png', 5 * MB);
    expect(await compressImage(file)).toBe(file);
  });
});

describe('uploadAttachment', () => {
  class MockXHR {
    static instances: MockXHR[] = [];
    static script: (xhr: MockXHR) => void = () => {};

    upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    withCredentials = false;
    status = 0;
    statusText = '';
    responseText = '';
    method = '';
    url = '';
    sentBody: unknown = null;

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    send(body: unknown) {
      this.sentBody = body;
      MockXHR.instances.push(this);
      MockXHR.script(this);
    }
  }

  beforeEach(() => {
    MockXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', MockXHR as unknown as typeof XMLHttpRequest);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs multipart with credentials, reports progress, and resolves the DTO', async () => {
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
    MockXHR.script = (xhr) => {
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent);
      xhr.status = 201;
      xhr.responseText = JSON.stringify({ attachment: dto });
      xhr.onload?.();
    };

    const progress: number[] = [];
    const file = new File(['data'], 'p.jpg', { type: 'image/jpeg' });
    const result = await uploadAttachment(10, file, (f) => progress.push(f));

    expect(result).toEqual(dto);
    const xhr = MockXHR.instances[0]!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/chats/10/attachments');
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.sentBody).toBeInstanceOf(FormData);
    expect((xhr.sentBody as FormData).get('file')).toBeInstanceOf(File);
    expect(((xhr.sentBody as FormData).get('file') as File).name).toBe('p.jpg');
    expect(progress).toEqual([0.5, 1]);
  });

  it('rejects with an ApiError carrying the server message and status', async () => {
    MockXHR.script = (xhr) => {
      xhr.status = 413;
      xhr.responseText = JSON.stringify({ error: 'File too large' });
      xhr.onload?.();
    };
    const file = new File(['x'], 'big.bin', { type: 'application/octet-stream' });
    await expect(uploadAttachment(10, file)).rejects.toMatchObject({
      name: 'ApiError',
      status: 413,
      message: 'File too large',
    });
  });
});

describe('attachmentUrl', () => {
  it('builds base, thumb, download, and combined variants', () => {
    expect(attachmentUrl(5)).toBe('/api/attachments/5');
    expect(attachmentUrl(5, { thumb: true })).toBe('/api/attachments/5?thumb=1');
    expect(attachmentUrl(5, { download: true })).toBe('/api/attachments/5?download=1');
    expect(attachmentUrl(5, { thumb: true, download: true })).toBe(
      '/api/attachments/5?thumb=1&download=1',
    );
  });
});

describe('formatBytes', () => {
  it('formats bytes through gigabytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(3.2 * MB)).toBe('3.2 MB');
    expect(formatBytes(5 * 1024 * MB)).toBe('5.0 GB');
  });
});

describe('attachmentPreviewText', () => {
  it('summarizes images by count and files by name', () => {
    expect(attachmentPreviewText([image(1)])).toBe('📷 Photo');
    expect(attachmentPreviewText([image(1), image(2), image(3)])).toBe('📷 3 photos');
    expect(attachmentPreviewText([doc(1, 'report.pdf')])).toBe('📎 report.pdf');
    // A mix prefers the first file.
    expect(attachmentPreviewText([image(1), doc(2, 'notes.txt')])).toBe('📎 notes.txt');
    expect(attachmentPreviewText([])).toBe('');
  });
});
