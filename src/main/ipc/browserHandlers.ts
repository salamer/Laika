/**
 * Chromium 相关 IPC：`openLogin`、`getHtml`/`evaluate`/`screenshot` / 会话元数据；
 * URL 与白名单在主进程别处校验。
 */
import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../types/ipc';
import { auditLog, errorFields } from '../logging';
import { browserEvaluate, browserGetHtml, browserScreenshot } from '../browserRuntime';
import {
  clearPersistedBrowserSession,
  countSessionCookies,
  readBrowserSessionMeta,
} from '../browserSession';
import {
  closeBrowserLoginWindow,
  openBrowserLoginWindow,
} from '../browserLogin';
import type {
  BrowserEvaluatePayload,
  BrowserGetHtmlPayload,
  BrowserScreenshotPayload,
} from '../../types/browserIpc';

function safeSerialize(result: unknown): string {
  if (result === undefined) {
    return 'null';
  }
  try {
    return JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return JSON.stringify(String(result));
  }
}

export function registerBrowserHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.BROWSER_GET_HTML,
    async (
      _event,
      payload: BrowserGetHtmlPayload & { requestId: string }
    ): Promise<{ success: boolean; data?: string; error?: string; requestId: string }> => {
      try {
        const html = await browserGetHtml({
          url: payload.url,
          timeoutMs: payload.timeoutMs,
          waitUntil: payload.waitUntil,
        });
        return { success: true, data: html, requestId: payload.requestId };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'browser.getHtml failed';
        auditLog.error('BROWSER_GET_HTML_ERROR', { url: payload.url, message, ...errorFields(error) });
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.BROWSER_SCREENSHOT,
    async (
      _event,
      payload: BrowserScreenshotPayload & { requestId: string }
    ): Promise<{
      success: boolean;
      data?: string;
      error?: string;
      requestId: string;
    }> => {
      try {
        const meta = await browserScreenshot({
          url: payload.url,
          path: payload.path,
          fullPage: payload.fullPage,
          timeoutMs: payload.timeoutMs,
          waitUntil: payload.waitUntil,
        });
        return { success: true, data: safeSerialize(meta), requestId: payload.requestId };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'browser.screenshot failed';
        auditLog.error('BROWSER_SCREENSHOT_ERROR', { url: payload.url, message, ...errorFields(error) });
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.BROWSER_EVALUATE,
    async (
      _event,
      payload: BrowserEvaluatePayload & { requestId: string }
    ): Promise<{ success: boolean; data?: string; error?: string; requestId: string }> => {
      try {
        const value = await browserEvaluate({
          url: payload.url,
          script: payload.script,
          timeoutMs: payload.timeoutMs,
          waitUntil: payload.waitUntil,
        });
        return { success: true, data: safeSerialize(value), requestId: payload.requestId };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'browser.evaluate failed';
        auditLog.error('BROWSER_EVALUATE_ERROR', { url: payload.url, message, ...errorFields(error) });
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.BROWSER_OPEN_LOGIN,
    (
      event,
      payload: { url: string; requestId: string }
    ): { success: boolean; error?: string; requestId: string } => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        openBrowserLoginWindow(win ?? undefined, payload.url);
        return { success: true, requestId: payload.requestId };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'browser.openLogin failed';
        auditLog.error('BROWSER_OPEN_LOGIN_ERROR', { url: payload.url, message, ...errorFields(error) });
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.BROWSER_CLOSE_LOGIN, (): { success: boolean } => {
    closeBrowserLoginWindow();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_SESSION_INFO, async (): Promise<{
    success: boolean;
    data?: {
      partition: string;
      storageRoot: string;
      cookieCount: number;
      lastOpenedLoginUrl?: string;
      updatedAt: number;
    };
    error?: string;
  }> => {
    try {
      const live = await countSessionCookies();
      const meta = readBrowserSessionMeta();
      return {
        success: true,
        data: {
          partition: meta.partition,
          storageRoot: meta.storageRoot,
          cookieCount: live,
          lastOpenedLoginUrl: meta.lastOpenedLoginUrl,
          updatedAt: meta.updatedAt || Date.now(),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'session info failed';
      return { success: false, error: message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_CLEAR_SESSION, async (): Promise<{
    success: boolean;
    error?: string;
  }> => {
    try {
      await clearPersistedBrowserSession();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'clear session failed';
      auditLog.error('BROWSER_CLEAR_SESSION_ERROR', { message, ...errorFields(error) });
      return { success: false, error: message };
    }
  });
}
