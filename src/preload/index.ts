import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  IPC_FS_VIEW_ROOT_EVENT,
  IPC_WORKSPACE_INFO,
  IPC_WORKSPACE_RESOLVE,
  IPCResponse,
  FileInfo,
  NetworkResponse,
} from '../types/ipc';
import type { AppSettings } from '../types/settings';
import type { DocumentPreviewResult } from '../types/documentPreview';

type SetWorkspaceResult =
  | { success: true; data: { workspaceRoot: string; workspaceWriteEnabled: boolean } }
  | { success: false; error: string };

type SetWorkspaceWriteResult =
  | { success: true; data: { workspaceWriteEnabled: boolean } }
  | { success: false; error: string };

function rid(): string {
  return crypto.randomUUID();
}

const api = {
  file: {
    readFile: (path: string): Promise<IPCResponse<string>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, { path, requestId: rid() }),
    readFileBase64: (path: string): Promise<IPCResponse<string>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_BASE64, { path, requestId: rid() }),
    writeFile: (path: string, content: string): Promise<IPCResponse<void>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_WRITE, { path, content, requestId: rid() }),
    writeFileBase64: (path: string, contentBase64: string): Promise<IPCResponse<void>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_WRITE_BASE64, {
        path,
        contentBase64,
        requestId: rid(),
      }),
    listFiles: (path?: string): Promise<IPCResponse<FileInfo[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST, { path: path ?? '.', requestId: rid() }),
    stat: (
      path: string
    ): Promise<IPCResponse<{ size: number; is_directory: boolean; modified_ms: number }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_STAT, { path, requestId: rid() }),
    mkdir: (path: string): Promise<IPCResponse<void>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_MKDIR, { path, requestId: rid() }),
    delete: (
      path: string,
      options?: { recursive?: boolean }
    ): Promise<IPCResponse<void>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_DELETE, {
        path,
        recursive: options?.recursive ?? false,
        requestId: rid(),
      }),
  },

  network: {
    request: (options: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: string;
    }): Promise<IPCResponse<NetworkResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.NETWORK_REQUEST, { ...options, requestId: rid() }),
  },

  config: {
    get: (): Promise<{ success: true; data: AppSettings }> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET),
    setWorkspaceRoot: (workspaceRoot: string): Promise<SetWorkspaceResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET_WORKSPACE, { workspaceRoot }),
    setWorkspaceWriteEnabled: (workspaceWriteEnabled: boolean): Promise<SetWorkspaceWriteResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET_WORKSPACE_WRITE, { workspaceWriteEnabled }),
    pickWorkspaceFolder: (): Promise<
      { success: true; path: string } | { success: false; canceled: boolean }
    > => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_WORKSPACE),
  },

  browser: {
    getHtml: (opts: {
      url: string;
      timeoutMs?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
    }): Promise<IPCResponse<string>> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GET_HTML, { ...opts, requestId: rid() }),
    screenshot: (opts: {
      url: string;
      path: string;
      fullPage?: boolean;
      timeoutMs?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
    }): Promise<IPCResponse<string>> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SCREENSHOT, { ...opts, requestId: rid() }),
    evaluate: (opts: {
      url: string;
      script: string;
      timeoutMs?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
    }): Promise<IPCResponse<string>> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_EVALUATE, { ...opts, requestId: rid() }),

    openLogin: (opts: { url: string }): Promise<IPCResponse<void>> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_OPEN_LOGIN, { ...opts, requestId: rid() }),
    closeLogin: (): Promise<IPCResponse<void>> => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLOSE_LOGIN),
    getSessionInfo: (): Promise<
      IPCResponse<{
        partition: string;
        storageRoot: string;
        cookieCount: number;
        lastOpenedLoginUrl?: string;
        updatedAt: number;
      }>
    > => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SESSION_INFO),
    clearSession: (): Promise<IPCResponse<void>> =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLEAR_SESSION),
  },

  llm: {
    status: (): Promise<
      IPCResponse<{
        configured: boolean;
        endpoint: string;
        model: string;
      }>
    > => ipcRenderer.invoke(IPC_CHANNELS.LLM_STATUS, { requestId: rid() }),
    chat: (opts: {
      messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
    }): Promise<
      IPCResponse<{ content: string; model: string; rawStatus: number }>
    > => ipcRenderer.invoke(IPC_CHANNELS.LLM_CHAT, { ...opts, requestId: rid() }),
  },

  shell: {
    execApproved: (opts: {
      script: string;
      timeoutMs?: number;
    }): Promise<
      IPCResponse<{ code: number | null; stdout: string; stderr: string }>
    > => ipcRenderer.invoke(IPC_CHANNELS.SHELL_EXEC_APPROVED, { ...opts, requestId: rid() }),
  },

  fileViewer: {
    listAbsolute: (opts: { absolutePath: string }): Promise<
      IPCResponse<{
        cwd: string;
        parent: string | null;
        entries: FileInfo[];
      }>
    > => ipcRenderer.invoke(IPC_CHANNELS.FS_VIEW_LIST, { ...opts, requestId: rid() }),

    pickAbsoluteFolder: (): Promise<
      | { success: true; path: string }
      | { success: false; canceled: true }
      | { success: false; canceled: false; error: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.FS_VIEW_PICK_FOLDER),

    readTextAbsolute: (opts: { absolutePath: string }): Promise<
      IPCResponse<{ absolutePath: string; name: string; content: string }>
    > => ipcRenderer.invoke(IPC_CHANNELS.FS_VIEW_READ_TEXT, { ...opts, requestId: rid() }),

    statAbsolute: (opts: { absolutePath: string }): Promise<
      IPCResponse<{
        absolutePath: string;
        name: string;
        isDirectory: boolean;
        size: number;
        modified: number;
      }>
    > => ipcRenderer.invoke(IPC_CHANNELS.FS_VIEW_STAT, { ...opts, requestId: rid() }),

    registerPreviewUrl: (opts: {
      absolutePath: string;
      mimeType?: string;
    }): Promise<IPCResponse<{ url: string; absolutePath: string; mimeType: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FS_VIEW_PREVIEW_REGISTER, { ...opts, requestId: rid() }),

    previewDocument: (opts: { absolutePath: string }): Promise<
      IPCResponse<{ absolutePath: string; preview: DocumentPreviewResult }>
    > => ipcRenderer.invoke(IPC_CHANNELS.FS_VIEW_DOCUMENT_PREVIEW, { ...opts, requestId: rid() }),

    popupPathMenu: (opts: { targetPath: string; isDirectory: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.FS_VIEW_POPUP_MENU, opts),

    revealPathInSystem: (opts: { targetPath: string; isDirectory: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.FS_VIEW_REVEAL_PATH, opts),

    openWindow: (opts: { root: string }): Promise<IPCResponse<{ root: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.VIEWER_OPEN_WINDOW, opts),

    pickFolderAndOpen: async (): Promise<
      | { ok: true }
      | { ok: false; reason: 'canceled' | string }
    > => {
      const r = await ipcRenderer.invoke(IPC_CHANNELS.FS_VIEW_PICK_FOLDER);
      if (r && typeof r === 'object' && 'canceled' in r && r.canceled) {
        return { ok: false, reason: 'canceled' };
      }
      if (r && typeof r === 'object' && 'success' in r && r.success && 'path' in r) {
        const open = await ipcRenderer.invoke(IPC_CHANNELS.VIEWER_OPEN_WINDOW, {
          root: (r as { path: string }).path,
        });
        if (open.success) return { ok: true };
        return { ok: false, reason: (open as { error?: string }).error ?? 'open viewer failed' };
      }
      const err = (r as { error?: string })?.error ?? 'pick failed';
      return { ok: false, reason: err };
    },

    onRootSynced: (listener: (absolutePath: string) => void): (() => void) => {
      const ch = (_evt: unknown, p: string): void => listener(p);
      ipcRenderer.on(IPC_FS_VIEW_ROOT_EVENT, ch);
      return () => ipcRenderer.removeListener(IPC_FS_VIEW_ROOT_EVENT, ch);
    },
  },

  workspace: {
    info: (): Promise<
      IPCResponse<{
        virtualRoot: string;
        workspaceRoot: string;
        workspaceWriteEnabled: boolean;
      }>
    > => ipcRenderer.invoke(IPC_WORKSPACE_INFO),
    resolvePath: (path: string): Promise<IPCResponse<{ absolute: string }>> =>
      ipcRenderer.invoke(IPC_WORKSPACE_RESOLVE, { path }),
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

export type ElectronAPI = typeof api;
