/**
 * PDF.js 5+ 假设存在 TC39 TypedArray `.toHex()` / `.toBase64()` / `Uint8Array.fromBase64()`，
 * 较旧的 Electron/Chromium 尚未实现时会报 `a.toHex is not a function` 等。
 * Worker 运行在独立上下文，必须用 {@link PDF_WORKER_UINT8_POLYFILL} 打进 worker blob。
 */
export function installUint8ArrayBinaryMethodsForRenderer(): void {
  if (typeof Uint8Array === 'undefined') return;

  const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
  if (typeof proto.toHex !== 'function') {
    proto.toHex = function toHex(this: Uint8Array): string {
      let s = '';
      for (let i = 0; i < this.length; i++) {
        s += this[i]!.toString(16).padStart(2, '0');
      }
      return s;
    };
  }

  const Ctor = Uint8Array as typeof Uint8Array & { fromBase64?: (b64: string) => Uint8Array };
  if (typeof Ctor.fromBase64 !== 'function') {
    Ctor.fromBase64 = function fromBase64(b64: string): Uint8Array {
      const bin = atob(b64);
      const n = bin.length;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
      return out;
    };
  }

  if (typeof proto.toBase64 !== 'function') {
    proto.toBase64 = function toBase64(this: Uint8Array): string {
      let bin = '';
      for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]!);
      return btoa(bin);
    };
  }
}

void installUint8ArrayBinaryMethodsForRenderer();

/** 与上面逻辑一致（ES5 风格），prepend 到 `pdf.worker`，避免混淆器去掉 `fn.toString()`。 */
export const PDF_WORKER_UINT8_POLYFILL = `
(function(){
  'use strict';
  if (typeof Uint8Array === 'undefined') return;
  var proto = Uint8Array.prototype;
  if (typeof proto.toHex !== 'function') {
    proto.toHex = function toHex() {
      var s = '';
      for (var i = 0; i < this.length; i++) {
        s += this[i].toString(16).padStart(2, '0');
      }
      return s;
    };
  }
  var Ctor = Uint8Array;
  if (typeof Ctor.fromBase64 !== 'function') {
    Ctor.fromBase64 = function fromBase64(b64) {
      var bin = atob(b64);
      var n = bin.length;
      var out = new Uint8Array(n);
      for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
      return out;
    };
  }
  if (typeof proto.toBase64 !== 'function') {
    proto.toBase64 = function toBase64() {
      var bin = '';
      for (var i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]);
      return btoa(bin);
    };
  }
})();
`.trim();
