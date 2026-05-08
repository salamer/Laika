/** Contract mirrored by `globalThis.hostAPI` in the Pyodide worker (Python: `from js import hostAPI`). */

import type { GotoWaitUntil } from './browserIpc';

export interface HostFileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: number;
}

export interface HostHttpRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HostHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  requestId: string;
}

/**
 * Chromium via Electron Main hidden `BrowserWindow` (not in Pyodide).
 */

export type HostBrowserGetHtml = {
  url: string;
  timeoutMs?: number;
  waitUntil?: GotoWaitUntil;
};

export type HostBrowserScreenshot = {
  url: string;
  path: string;
  fullPage?: boolean;
  timeoutMs?: number;
  waitUntil?: GotoWaitUntil;
};

export type HostBrowserEvaluate = {
  url: string;
  script: string;
  timeoutMs?: number;
  waitUntil?: GotoWaitUntil;
};

export interface HostAPIBridge {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  listFiles: (path?: string) => Promise<unknown[]>;
  mkdir: (path: string) => Promise<void>;
  getWorkspaceInfo: () => Promise<string>;
  resolveWorkspacePath: (path: string) => Promise<string>;
  httpRequest: (options: unknown) => Promise<string>;
  deleteFile: (path: string, recursive: boolean) => Promise<void>;

  browserGetHtml: (optsJson: string) => Promise<string>;
  browserScreenshot: (optsJson: string) => Promise<string>;
  browserEvaluate: (optsJson: string) => Promise<string>;

  browser: {
    getHtml: (opts: unknown) => Promise<string>;
    screenshot: (opts: unknown) => Promise<{ path: string; width: number; height: number }>;
    evaluate: (opts: unknown) => Promise<unknown>;
  };
}
