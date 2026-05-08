import { BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  BrowserEvaluatePayload,
  BrowserGetHtmlPayload,
  BrowserScreenshotPayload,
  GotoWaitUntil,
} from '../types/browserIpc';
import { allowProxiedHttpRequest } from './network';
import { getPathValidator } from './workspaceContext';
import { auditLog } from './security/audit';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Laika/1.0';
const MAX_HTML_BYTES = 20 * 1024 * 1024;
const MIN_VIEWPORT = { width: 1280, height: 720 };

let automationWindow: BrowserWindow | null = null;

function getOrCreateWindow(): BrowserWindow {
  if (automationWindow && !automationWindow.isDestroyed()) {
    return automationWindow;
  }
  automationWindow = new BrowserWindow({
    show: false,
    width: MIN_VIEWPORT.width,
    height: MIN_VIEWPORT.height,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false,
      partition: 'persist:laika-browser-automation',
    },
  });
  automationWindow.on('closed', () => {
    automationWindow = null;
  });
  return automationWindow;
}

function assertPublicHttpUrl(url: string): void {
  if (!url || typeof url !== 'string') {
    throw new Error('browser: url is required');
  }
  if (!allowProxiedHttpRequest(url)) {
    throw new Error(
      'Browser navigation blocked: only public http(s) URLs are allowed (no localhost / private networks).'
    );
  }
}

async function navigateAndWait(
  win: BrowserWindow,
  url: string,
  waitUntil: GotoWaitUntil,
  timeoutMs: number
): Promise<void> {
  const wc = win.webContents;
  assertPublicHttpUrl(url);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Navigation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', onFinish);
      wc.removeListener('dom-ready', onDomReady);
      wc.removeListener('did-fail-load', onFail);
    };

    const onFail = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ) => {
      if (!isMainFrame) return;
      cleanup();
      reject(new Error(`Load failed (${errorCode}): ${errorDescription} — ${validatedURL}`));
    };

    const onDomReady = () => {
      cleanup();
      resolve();
    };

    const onFinish = () => {
      if (waitUntil === 'networkidle') {
        setTimeout(() => {
          cleanup();
          resolve();
        }, 750);
      } else {
        cleanup();
        resolve();
      }
    };

    wc.once('did-fail-load', onFail);

    if (waitUntil === 'domcontentloaded') {
      wc.once('dom-ready', onDomReady);
    } else {
      wc.once('did-finish-load', onFinish);
    }

    void wc.loadURL(url, { userAgent: DEFAULT_UA }).catch((err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

async function runUserScript(wc: WebContents, script: string): Promise<unknown> {
  const trimmed = script.trim();
  const looksLikeFn =
    /^\(\s*\)\s*=>/.test(trimmed) ||
    /^function\s*\(/.test(trimmed) ||
    /^async\s+function/.test(trimmed) ||
    /^\([^)]*\)\s*=>/.test(trimmed);

  if (looksLikeFn) {
    return wc.executeJavaScript(`( ${trimmed} )()`, true);
  }
  return wc.executeJavaScript(`(function(){ return ( ${trimmed} ); })()`, true);
}

export async function browserGetHtml(payload: BrowserGetHtmlPayload): Promise<string> {
  assertPublicHttpUrl(payload.url);
  const waitUntil = payload.waitUntil ?? 'load';
  const timeoutMs = Math.min(Math.max(payload.timeoutMs ?? 60_000, 5_000), 180_000);
  const win = getOrCreateWindow();
  auditLog.info('BROWSER_GET_HTML', { url: payload.url, waitUntil });

  await navigateAndWait(win, payload.url, waitUntil, timeoutMs);
  const html = (await win.webContents.executeJavaScript(
    'document.documentElement ? document.documentElement.outerHTML : ""',
    true
  )) as string;
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_HTML_BYTES) {
    throw new Error(`HTML too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
  }
  return html;
}

export async function browserScreenshot(
  payload: BrowserScreenshotPayload
): Promise<{ path: string; width: number; height: number }> {
  assertPublicHttpUrl(payload.url);
  const pv = getPathValidator();
  const safePath = pv.validate(payload.path.replace(/\\/g, '/'));
  const waitUntil = payload.waitUntil ?? 'load';
  const timeoutMs = Math.min(Math.max(payload.timeoutMs ?? 60_000, 5_000), 180_000);
  const win = getOrCreateWindow();
  auditLog.info('BROWSER_SCREENSHOT', { url: payload.url, path: payload.path, fullPage: payload.fullPage });

  await navigateAndWait(win, payload.url, waitUntil, timeoutMs);

  if (payload.fullPage) {
    const scrollHeight = (await win.webContents.executeJavaScript(
      `Math.min(32000, Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, innerHeight))`,
      true
    )) as number;
    const w = MIN_VIEWPORT.width;
    const h = Math.max(MIN_VIEWPORT.height, Math.floor(scrollHeight));
    win.setContentSize(w, h);
    await new Promise((r) => setTimeout(r, 300));
  }

  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  await mkdir(dirname(safePath), { recursive: true });
  await writeFile(safePath, png);
  const size = image.getSize();
  return { path: pv.toVirtualPath(safePath), width: size.width, height: size.height };
}

export async function browserEvaluate(payload: BrowserEvaluatePayload): Promise<unknown> {
  assertPublicHttpUrl(payload.url);
  if (!payload.script || typeof payload.script !== 'string') {
    throw new Error('browser.evaluate: script is required');
  }
  const waitUntil = payload.waitUntil ?? 'load';
  const timeoutMs = Math.min(Math.max(payload.timeoutMs ?? 60_000, 5_000), 180_000);
  const win = getOrCreateWindow();
  auditLog.info('BROWSER_EVALUATE', { url: payload.url });

  await navigateAndWait(win, payload.url, waitUntil, timeoutMs);
  return runUserScript(win.webContents, payload.script);
}

export function disposeBrowserRuntime(): void {
  if (automationWindow && !automationWindow.isDestroyed()) {
    automationWindow.destroy();
  }
  automationWindow = null;
}
