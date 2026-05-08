import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../types/ipc';
import { auditLog } from '../security/audit';
import { browserEvaluate, browserGetHtml, browserScreenshot } from '../browserRuntime';
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
        auditLog.error('BROWSER_GET_HTML_ERROR', { message, url: payload.url });
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
        auditLog.error('BROWSER_SCREENSHOT_ERROR', { message, url: payload.url });
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
        auditLog.error('BROWSER_EVALUATE_ERROR', { message, url: payload.url });
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );
}
