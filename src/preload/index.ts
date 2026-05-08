import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  IPC_WORKSPACE_INFO,
  IPC_WORKSPACE_RESOLVE,
  IPCResponse,
  FileInfo,
  NetworkResponse,
} from '../types/ipc';
import type { AppSettings } from '../types/settings';

type SetWorkspaceResult =
  | { success: true; data: { workspaceRoot: string } }
  | { success: false; error: string };

function rid(): string {
  return crypto.randomUUID();
}

const api = {
  file: {
    readFile: (path: string): Promise<IPCResponse<string>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, { path, requestId: rid() }),
    writeFile: (path: string, content: string): Promise<IPCResponse<void>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_WRITE, { path, content, requestId: rid() }),
    listFiles: (path?: string): Promise<IPCResponse<FileInfo[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST, { path: path ?? '.', requestId: rid() }),
    mkdir: (path: string): Promise<IPCResponse<void>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_MKDIR, { path, requestId: rid() }),
    delete: (path: string): Promise<IPCResponse<void>> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_DELETE, { path, requestId: rid() }),
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
    pickWorkspaceFolder: (): Promise<
      { success: true; path: string } | { success: false; canceled: boolean }
    > => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_WORKSPACE),
  },

  workspace: {
    info: (): Promise<
      IPCResponse<{
        virtualRoot: string;
        workspaceRoot: string;
      }>
    > => ipcRenderer.invoke(IPC_WORKSPACE_INFO),
    resolvePath: (path: string): Promise<IPCResponse<{ absolute: string }>> =>
      ipcRenderer.invoke(IPC_WORKSPACE_RESOLVE, { path }),
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

export type ElectronAPI = typeof api;
