/**
 * PDF.js 5.x may call URL.parse (newer browsers); polyfill for Electron 30 / older Chromium.
 */
export const PDF_WORKER_URL_PARSE_POLYFILL = String.raw`(() => {
  if (typeof URL.parse === "function") return;
  URL.parse = function parse(url, base) {
    try {
      if (base !== undefined) return new URL(String(url), base);
      return new URL(String(url));
    } catch (_e) {
      return null;
    }
  };
})();`;

export function installUrlParsePolyfill(): void {
  const U = URL as typeof URL & { parse?: (url: string | URL, base?: string | URL) => URL | null };
  if (typeof U.parse === 'function') return;
  U.parse = (url: string | URL, base?: string | URL): URL | null => {
    try {
      if (base !== undefined) return new URL(url, base);
      return new URL(url);
    } catch {
      return null;
    }
  };
}

void installUrlParsePolyfill();
