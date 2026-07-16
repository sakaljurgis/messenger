// Lazy pdf.js loader for the in-app PDF viewer.
//
// pdfjs-dist is heavy (~1MB), so it is NEVER in the main bundle: both the
// library and its worker are dynamic imports, fetched the first time a PDF is
// actually opened (Vite splits them into their own chunks; the `?url` import
// resolves to the emitted worker asset's URL). The module is memoized so a
// second open reuses the already-initialized library.
//
// `openPdfDocument` narrows pdf.js to the minimal structural interfaces the
// viewer consumes (`PdfDocumentLike`/`PdfPageLike`), which is also the DI seam:
// PdfViewer takes a `loadPdf` prop of this shape, so tests stub documents
// without touching pdfjs-dist (jsdom can neither run its worker nor rasterize).

import type { PageViewport } from 'pdfjs-dist';

/** The viewport slice the viewer uses. Callers must hand the SAME object they
 *  got from `getViewport` back to `render` (it's a live pdf.js PageViewport
 *  underneath, only narrowed here). */
export interface PdfViewportLike {
  width: number;
  height: number;
}

/** The slice of a pdf.js page the viewer uses. */
export interface PdfPageLike {
  getViewport(params: { scale: number }): PdfViewportLike;
  render(params: { canvas: HTMLCanvasElement; viewport: PdfViewportLike }): {
    promise: Promise<void>;
  };
}

/** The slice of a pdf.js document the viewer uses. */
export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

/** Import pdf.js + point it at its worker asset, once per session. */
function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  pdfjsPromise ??= (async () => {
    const [pdfjs, workerUrl] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
    return pdfjs;
  })();
  return pdfjsPromise;
}

/** Fetch and parse a PDF (same-origin — the session cookie rides along).
 *  Returned as the viewer's minimal document shape; `destroy` delegates to the
 *  loading task (in pdf.js v6 the document proxy no longer owns teardown). */
export async function openPdfDocument(url: string): Promise<PdfDocumentLike> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ url });
  const doc = await task.promise;
  return {
    numPages: doc.numPages,
    getPage: async (pageNumber) => {
      const page = await doc.getPage(pageNumber);
      return {
        getViewport: (params) => page.getViewport(params),
        // The viewport given back here is the PageViewport from getViewport
        // above, just narrowed to PdfViewportLike on the way through.
        render: ({ canvas, viewport }) => {
          const renderTask = page.render({ canvas, viewport: viewport as PageViewport });
          return { promise: renderTask.promise };
        },
      };
    },
    destroy: () => task.destroy(),
  };
}
