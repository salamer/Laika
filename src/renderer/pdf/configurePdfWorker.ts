import { PDF_WORKER_MAP_GET_OR_INSERT_POLYFILL } from '../polyfills/mapGetOrInsertComputed';
import { PDF_WORKER_UINT8_POLYFILL } from '../polyfills/uint8ArrayBinaryMethods';
import { PDF_WORKER_MATH_SUM_PRECISE_POLYFILL } from './mathSumPrecisePolyfill';
import { PDF_WORKER_URL_PARSE_POLYFILL } from './urlParsePolyfill';

import { GlobalWorkerOptions } from 'pdfjs-dist';

let configurePromise: Promise<void> | null = null;
let patchedBlobUrl: string | null = null;

/**
 * 使用 `?url` + fetch 会在 Vite 开发服务器下拿到经管道转换的脚本（可能含 `/@vite/client`），
 * 再塞进 `blob:` worker 时无法解析该 specifier，真实 Worker 失败后又会在 fake worker 里
 * `import(workerSrc)` 同样崩掉。
 *
 * `?raw` 引入的是磁盘上的原始 worker 源码字符串，不包含 Vite 运行时，再与 polyfill 拼成 blob 即可。
 */
export function ensurePdfJsWorkerReady(): Promise<void> {
  if (patchedBlobUrl) {
    GlobalWorkerOptions.workerSrc = patchedBlobUrl;
    return Promise.resolve();
  }

  if (!configurePromise) {
    configurePromise = (async () => {
      const { default: workerSource } = await import(
        /* @vite-ignore */ 'pdfjs-dist/build/pdf.worker.min.mjs?raw'
      );

      const blob = new Blob(
        [
          `${PDF_WORKER_MAP_GET_OR_INSERT_POLYFILL}\n${PDF_WORKER_UINT8_POLYFILL}\n${PDF_WORKER_MATH_SUM_PRECISE_POLYFILL}\n${PDF_WORKER_URL_PARSE_POLYFILL}\n${workerSource}`,
        ],
        {
          type: 'application/javascript',
        }
      );
      patchedBlobUrl = URL.createObjectURL(blob);
      GlobalWorkerOptions.workerSrc = patchedBlobUrl;
    })();
  }

  return configurePromise.catch((e) => {
    configurePromise = null;
    throw e;
  });
}
