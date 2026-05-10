/**
 * Python `hostAPI.browser.*` 使用的隐藏 BrowserWindow：`browserSession` 同一分区，
 * `navigateAndWait` 负责导航与就绪信号；不向用户展示窗口。
 */
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
import { allowBrowserNavUrl } from './network';
import { BROWSER_SESSION_PARTITION, EMBEDDED_BROWSER_USER_AGENT } from './browserSession';
import { disposeBrowserLoginWindow } from './browserLogin';
import { getPathValidator } from './workspaceContext';
import { isWorkspaceWriteEnabled } from './configStore';
import { auditLog, scoped } from './logging';

const blog = scoped('browser.embedded');
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
      partition: BROWSER_SESSION_PARTITION,
    },
  });
  automationWindow.on('closed', () => {
    automationWindow = null;
  });
  return automationWindow;
}

function assertBrowserNavUrl(url: string): void {
  if (!url || typeof url !== 'string') {
    throw new Error('browser: url is required');
  }
  if (!allowBrowserNavUrl(url)) {
    throw new Error(
      'Browser navigation blocked: use public https/http URLs, or http(s)://localhost / 127.0.0.1 for local dev.'
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
  assertBrowserNavUrl(url);

  blog.debug({ url, waitUntil, timeoutMs }, 'navigate:start');

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

    void wc.loadURL(url, { userAgent: EMBEDDED_BROWSER_USER_AGENT }).catch((err) => {
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

async function getRenderedOuterHtml(payload: BrowserGetHtmlPayload): Promise<string> {
  assertBrowserNavUrl(payload.url);
  const waitUntil = payload.waitUntil ?? 'load';
  const timeoutMs = Math.min(Math.max(payload.timeoutMs ?? 60_000, 5_000), 180_000);
  const win = getOrCreateWindow();

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

export async function browserGetHtml(payload: BrowserGetHtmlPayload): Promise<string> {
  auditLog.info('BROWSER_GET_HTML', { url: payload.url, waitUntil: payload.waitUntil ?? 'load' });
  return getRenderedOuterHtml(payload);
}

export async function browserScreenshot(
  payload: BrowserScreenshotPayload
): Promise<{ path: string; width: number; height: number }> {
  if (!isWorkspaceWriteEnabled()) {
    throw new Error(
      '工作区写入未启用：无法保存截图到工作区路径，请在侧边横幅或设置中启用写入权限。'
    );
  }
  assertBrowserNavUrl(payload.url);
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
  assertBrowserNavUrl(payload.url);
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
  disposeBrowserLoginWindow();
  if (automationWindow && !automationWindow.isDestroyed()) {
    automationWindow.destroy();
  }
  automationWindow = null;
}
