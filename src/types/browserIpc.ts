/**
 * Types for Chromium automation via Electron Main (hidden BrowserWindow).
 * Pyodide accesses through hostAPI → IPC only.
 */

export type GotoWaitUntil = 'load' | 'domcontentloaded' | 'networkidle';

export interface BrowserGetHtmlPayload {
  url: string;
  timeoutMs?: number;
  waitUntil?: GotoWaitUntil;
}

export interface BrowserScreenshotPayload {
  url: string;
  /** Workspace-relative path (validated in main). */
  path: string;
  fullPage?: boolean;
  timeoutMs?: number;
  waitUntil?: GotoWaitUntil;
}

export interface BrowserEvaluatePayload {
  url: string;
  /**
   * JS snippet evaluated in page after load.
   * Prefer an IIFE or `() => value` — see `wrapUserScript` in main process.
   */
  script: string;
  timeoutMs?: number;
  waitUntil?: GotoWaitUntil;
}

export interface BrowserScreenshotResult {
  path: string;
  width: number;
  height: number;
}
