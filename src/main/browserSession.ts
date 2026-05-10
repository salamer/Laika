import { app, session, type Session } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { auditLog } from './logging';

/** 嵌入 Chromium 的持久分区与元数据；不负责 TLS（由 Chromium 默认校验）。
 * - 登录窗：`browserLogin`
 * - 隐藏自动化：`browserRuntime` / hostAPI.browser.*
 */
export const BROWSER_SESSION_PARTITION = 'persist:laika-browser-session';

/** One UA string for all embedded navigations (login + automation). */
export const EMBEDDED_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Laika/1.0';

export function getBrowserSession(): Session {
  return session.fromPartition(BROWSER_SESSION_PARTITION);
}

export interface BrowserSessionMeta {
  partition: string;
  /** Human-readable note — actual files live under Electron userData. */
  storageRoot: string;
  lastOpenedLoginUrl?: string;
  cookieCount: number;
  updatedAt: number;
}

function metaFilePath(): string {
  return join(app.getPath('userData'), 'browser-session', 'session-meta.json');
}

export function readBrowserSessionMeta(): BrowserSessionMeta {
  const fp = metaFilePath();
  const base: BrowserSessionMeta = {
    partition: BROWSER_SESSION_PARTITION,
    storageRoot: join(app.getPath('userData'), 'Partitions'),
    cookieCount: 0,
    updatedAt: 0,
  };
  if (!existsSync(fp)) return base;
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<BrowserSessionMeta>;
    return { ...base, ...raw, partition: BROWSER_SESSION_PARTITION };
  } catch {
    return base;
  }
}

export function writeBrowserSessionMeta(partial: Partial<BrowserSessionMeta>): BrowserSessionMeta {
  const prev = readBrowserSessionMeta();
  const next: BrowserSessionMeta = {
    ...prev,
    ...partial,
    partition: BROWSER_SESSION_PARTITION,
    storageRoot: join(app.getPath('userData'), 'Partitions'),
    updatedAt: Date.now(),
  };
  const dir = join(app.getPath('userData'), 'browser-session');
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaFilePath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

export async function countSessionCookies(): Promise<number> {
  const list = await getBrowserSession().cookies.get({});
  return list.length;
}

export async function refreshBrowserSessionMeta(lastLoginUrl?: string): Promise<BrowserSessionMeta> {
  const n = await countSessionCookies();
  return writeBrowserSessionMeta({
    cookieCount: n,
    lastOpenedLoginUrl: lastLoginUrl,
  });
}

/** Wipe cookies + web storage for the shared automation session (cannot be undone). */
export async function clearPersistedBrowserSession(): Promise<void> {
  const ses = getBrowserSession();
  await ses.clearStorageData({
    storages: [
      'cookies',
      'filesystem',
      'indexdb',
      'localstorage',
      'shadercache',
      'websql',
      'serviceworkers',
      'cachestorage',
    ],
  });
  await ses.clearCache();
  auditLog.warn('BROWSER_SESSION_CLEARED', { partition: BROWSER_SESSION_PARTITION });
  await refreshBrowserSessionMeta(undefined);
}
