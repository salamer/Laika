import '../polyfills/promiseTry';
import '../polyfills/uint8ArrayBinaryMethods';
import '../polyfills/mapGetOrInsertComputed';
import '../pdf/mathSumPrecisePolyfill';
import '../pdf/urlParsePolyfill';
import { ensurePdfJsWorkerReady } from '../pdf/configurePdfWorker';
import { getPdfjsCMapUrl, getPdfjsStandardFontDataUrl } from '../pdf/pdfjsBundledAssetBase';

import { useEffect, useRef, useState } from 'react';
import { getDocument, type PDFDocumentProxy, type PDFDocumentLoadingTask, type RenderTask } from 'pdfjs-dist';

type Props = {
  /** Raw PDF bytes. The viewer copies internally so the buffer can be reused. */
  data: ArrayBuffer;
};

export default function PdfJsCanvasViewer({ data }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !data.byteLength) return;

    let cancelled = false;
    const renderTasks: RenderTask[] = [];
    let pdfDoc: PDFDocumentProxy | null = null;
    let loadTask: PDFDocumentLoadingTask | null = null;

    setLoadErr(null);
    el.replaceChildren();

    void (async () => {
      try {
        await ensurePdfJsWorkerReady();
        if (cancelled) return;

        loadTask = getDocument({
          data: new Uint8Array(data.slice(0)),
          cMapUrl: getPdfjsCMapUrl(),
          cMapPacked: true,
          standardFontDataUrl: getPdfjsStandardFontDataUrl(),
        });

        const pdf = await loadTask.promise;
        loadTask = null;
        if (cancelled) {
          await pdf.destroy().catch(() => {});
          return;
        }
        pdfDoc = pdf;

        const cssW = Math.max(280, el.clientWidth || 640);
        const page1 = await pdf.getPage(1);
        if (cancelled) return;

        const baseVp = page1.getViewport({ scale: 1 });
        const scale = Math.min(2.25, Math.max(0.5, (cssW - 24) / baseVp.width));

        const frag = document.createDocumentFragment();
        for (let p = 1; p <= pdf.numPages; p++) {
          if (cancelled) break;
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.className =
            'block mx-auto mb-4 max-w-full rounded-lg shadow-lg border border-white/[0.08] bg-zinc-900/40';
          canvas.width = viewport.width;
          canvas.height = viewport.height;

          const task = page.render({ canvas, viewport });
          renderTasks.push(task);
          try {
            await task.promise;
          } catch {
            if (cancelled) break;
            throw new Error('页面渲染失败');
          }
          if (cancelled) break;
          frag.appendChild(canvas);
        }

        if (cancelled) return;
        el.appendChild(frag);
        await pdf.destroy().catch(() => {});
        pdfDoc = null;
      } catch (e) {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      for (const t of renderTasks) {
        try {
          t.cancel();
        } catch {
          //
        }
      }
      renderTasks.length = 0;
      void pdfDoc?.destroy().catch(() => {});
      pdfDoc = null;
      void loadTask?.destroy().catch(() => {});
      loadTask = null;
      el.replaceChildren();
    };
  }, [data]);

  return (
    <div ref={rootRef} className="flex-1 min-h-0 overflow-auto px-4 py-4 pb-10">
      {loadErr ? <p className="text-sm text-amber-200/95 px-2 mb-4 text-center">{loadErr}</p> : null}
    </div>
  );
}
