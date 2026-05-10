import pkg from 'pdfjs-dist/package.json';

/**
 * Remote CDN URLs pointing at the **installed** pdfjs-dist version (offline previews fall back to PDF fallback glyphs unless bundled separately).
 */
const CDN_ROOT = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pkg.version}`;

export function getPdfjsCMapUrl(): string {
  return `${CDN_ROOT}/cmaps/`;
}

export function getPdfjsStandardFontDataUrl(): string {
  return `${CDN_ROOT}/standard_fonts/`;
}
