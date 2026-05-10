/**
 * PDF.js 5+ 使用 `Map.prototype.getOrInsertComputed`（需很新的 Chromium，如 Chrome 145+）。
 * Electron 30 等旧内核会报 `__privateGet(...).getOrInsertComputed is not a function`。
 */

type MapWithGetOrInsertComputed = Map<unknown, unknown> & {
  getOrInsertComputed?: (key: unknown, callback: (key: unknown) => unknown) => unknown;
};

export function installMapGetOrInsertComputedPolyfill(): void {
  if (typeof Map === 'undefined') return;
  const proto = Map.prototype as unknown as MapWithGetOrInsertComputed;
  if (typeof proto.getOrInsertComputed === 'function') return;

  proto.getOrInsertComputed = function getOrInsertComputed(
    this: Map<unknown, unknown>,
    key: unknown,
    callback: (key: unknown) => unknown
  ): unknown {
    if (this.has(key)) return this.get(key);
    const next = callback(key);
    this.set(key, next);
    return next;
  };
}

void installMapGetOrInsertComputedPolyfill();

/** 与上面一致，ES5 写法，prepend 到 pdf.worker blob。 */
export const PDF_WORKER_MAP_GET_OR_INSERT_POLYFILL = `
(function(){
  'use strict';
  if (typeof Map === 'undefined') return;
  var proto = Map.prototype;
  if (typeof proto.getOrInsertComputed !== 'function') {
    proto.getOrInsertComputed = function getOrInsertComputed(key, callback) {
      if (this.has(key)) return this.get(key);
      var v = callback(key);
      this.set(key, v);
      return v;
    };
  }
})();
`.trim();
