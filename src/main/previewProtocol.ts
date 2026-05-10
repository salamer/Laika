/**
 * 只读本地文件流：`laika-preview://` + token，供 PDF（支持 Range）、媒体、DOCX(fetch) 等使用。
 */
import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { auditLog, errorFields } from './logging';

type TokenEntry = {
  path: string;
  mime: string;
  expiresAt: number;
};

const tokens = new Map<string, TokenEntry>();
const DEFAULT_TTL_MS = 15 * 60_000;

function pruneExpired(): void {
  const now = Date.now();
  for (const [k, v] of tokens) {
    if (v.expiresAt <= now) tokens.delete(k);
  }
}

export function registerPreviewPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'laika-preview',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function guessMime(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '');
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[e] || 'application/octet-stream';
}

export function allocatePreviewUrl(absPath: string, mimeHint?: string): string {
  pruneExpired();
  const ext = absPath.includes('.') ? absPath.slice(absPath.lastIndexOf('.')) : '';
  const mime = mimeHint && mimeHint.trim() ? mimeHint.trim() : guessMime(ext);
  const id = randomUUID();
  tokens.set(id, { path: absPath, mime, expiresAt: Date.now() + DEFAULT_TTL_MS });
  return `laika-preview://file?token=${encodeURIComponent(id)}`;
}

/** 解析 Chromium `Range:` 请求头，`bytes=start-end`。 */
function parseRangeHeader(
  rangeHeader: string | null,
  fileSize: number
): { start: number; end: number } | null {
  if (!rangeHeader || !/^bytes=/i.test(rangeHeader.trim())) return null;
  const part = rangeHeader.replace(/^bytes=/i, '').split(',')[0]?.trim();
  if (!part) return null;
  const m = /^(\d*)-(\d*)$/.exec(part);
  if (!m) return null;
  let start = m[1] === '' ? NaN : parseInt(m[1], 10);
  let end = m[2] === '' ? NaN : parseInt(m[2], 10);
  if (Number.isNaN(start) && Number.isNaN(end)) return null;

  if (Number.isNaN(start)) {
    /** suffix `-500`：最后 size 字节 */
    const suf = Number.isFinite(end) ? end : -1;
    if (suf <= 0) return null;
    start = Math.max(0, fileSize - suf);
    end = fileSize - 1;
    return start <= end ? { start, end } : null;
  }

  start = Number.isFinite(start) ? Math.max(0, start) : 0;
  end = Number.isFinite(end) ? Math.min(end, fileSize - 1) : fileSize - 1;
  return start <= end && start < fileSize ? { start, end } : null;
}

export function registerPreviewProtocolHandler(): void {
  protocol.handle('laika-preview', async (request) => {
    try {
      pruneExpired();
      const url = new URL(request.url);
      const token =
        url.searchParams.get('token') ||
        (/[?&]token=([^&]+)/.exec(request.url)?.[1] ?? null);
      if (!token) {
        return new Response('Missing token', { status: 400 });
      }

      const entry = tokens.get(token);
      if (!entry || entry.expiresAt <= Date.now()) {
        return new Response('Expired or unknown token', { status: 404 });
      }

      const st = await stat(entry.path);
      if (!st.isFile()) {
        return new Response('Not a file', { status: 404 });
      }

      const total = st.size;

      /** PDF 等在 iframe / 嵌入查看器中会发 Range；必须正确处理否则无法打开 */
      const rangeSpec = parseRangeHeader(request.headers.get('range'), total);

      const baseHeaders = new Headers({
        'Content-Type': entry.mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=0, no-store',
      });

      if (rangeSpec) {
        const { start, end } = rangeSpec;
        const chunkSize = end - start + 1;
        const rs = createReadStream(entry.path, { start, end });
        const web = Readable.toWeb(rs) as ReadableStream<Uint8Array>;
        baseHeaders.set('Content-Length', String(chunkSize));
        baseHeaders.set('Content-Range', `bytes ${start}-${end}/${total}`);
        return new Response(web, { status: 206, headers: baseHeaders });
      }

      const rs = createReadStream(entry.path);
      const web = Readable.toWeb(rs) as ReadableStream<Uint8Array>;
      baseHeaders.set('Content-Length', String(total));
      return new Response(web, {
        status: 200,
        headers: baseHeaders,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      auditLog.error('LAIKA_PREVIEW_PROTOCOL', { message, ...errorFields(e) });
      return new Response(message, { status: 500 });
    }
  });
}
