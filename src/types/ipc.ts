export const IPC_CHANNELS = {
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  FILE_LIST: 'file:list',
  FILE_MKDIR: 'file:mkdir',
  FILE_DELETE: 'file:delete',

  NETWORK_REQUEST: 'network:request',

  CONFIG_GET: 'config:get',
  CONFIG_SET_WORKSPACE: 'config:set-workspace',
  DIALOG_SELECT_WORKSPACE: 'dialog:select-workspace',
} as const;

export type IPCChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  requestId?: string;
  timestamp?: number;
}

export interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: number;
}

export interface NetworkResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  requestId: string;
}

export const IPC_WORKSPACE_INFO = 'workspace:info' as const;
export const IPC_WORKSPACE_RESOLVE = 'workspace:resolve' as const;
