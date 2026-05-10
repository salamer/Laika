/**
 * PDF.js 5.x、Pyodide 0.25+ 等会在运行时使用 `Promise.try`，而 Electron 内置 Chromium
 * 往往在 `Promise.try` 进入稳定版之前 — 缺省会报 `Promise.try is not a function`
 *（PDF.js 会退化为 fake worker）。需在对应 worker / 任何 `import 'pdfjs-dist'` 之前加载。
 */
type PromiseTry = <T, A extends unknown[]>(
  fn: (...args: A) => T,
  ...args: A
) => Promise<Awaited<T>>;

const P = Promise as typeof Promise & { try?: PromiseTry };

if (typeof P.try !== 'function') {
  P.try = function tryPoly<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<Awaited<T>> {
    return new Promise((resolve, reject) => {
      try {
        resolve(fn(...args) as Awaited<T> | PromiseLike<Awaited<T>>);
      } catch (e) {
        reject(e);
      }
    });
  };
}

export {};
