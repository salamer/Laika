import type { Session } from 'electron';
import { URL } from 'node:url';
import { auditLog } from './security/audit';

function devServerOrigin(): URL | null {
  const raw = process.env.VITE_DEV_SERVER_URL;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function ipv4Parts(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1, 5).map((x) => Number(x));
  if (o.some((n) => n > 255 || n < 0)) return null;
  return [o[0], o[1], o[2], o[3]];
}

function isNonPublicIPv4(host: string): boolean {
  const p = ipv4Parts(host);
  if (!p) return false;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function isNonPublicHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '[::]') return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;
  if (h === '[::1]' || h === '::1') return true;
  if (isNonPublicIPv4(h)) return true;

  if (h.startsWith('[') && h.endsWith(']')) {
    const inner = h.slice(1, -1);
    if (inner === '::1') return true;
    if (inner.startsWith('fe80:')) return true;
    if (/^f[c-d][0-9a-f]{2}:/i.test(inner)) return true;
    if (inner.startsWith('::ffff:')) {
      const v4 = inner.slice(7);
      if (ipv4Parts(v4)) return isNonPublicIPv4(v4);
    }
  }
  return false;
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

function isDevAssetRequest(url: URL, dev: URL | null): boolean {
  if (!dev) return false;
  return sameOrigin(url, dev);
}

const WEB = new Set(['http:', 'https:', 'ws:', 'wss:']);

export function allowSessionRequest(urlStr: string): boolean {
  if (
    urlStr.startsWith('file:') ||
    urlStr.startsWith('devtools://') ||
    urlStr.startsWith('blob:')
  ) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }
  if (!WEB.has(url.protocol)) return false;

  if (isDevAssetRequest(url, devServerOrigin())) return true;
  if (isNonPublicHostname(url.hostname)) return false;
  return true;
}

export function allowProxiedHttpRequest(urlStr: string): boolean {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (isNonPublicHostname(url.hostname)) return false;
  return true;
}

export function attachNetworkGuards(sess: Session): void {
  sess.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (allowSessionRequest(details.url)) {
      callback({ cancel: false });
      return;
    }
    auditLog.warn('NETWORK_BLOCKED_LOCAL', { url: details.url });
    callback({ cancel: true });
  });
}
