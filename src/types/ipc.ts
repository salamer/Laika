export const IPC_CHANNELS = {
  FILE_READ: 'file:read',
  /** 二进制工作区读取，返回 Base64（Pyodide 侧再解码为 bytes）。单文件上限与 FILE_* 一致。 */
  FILE_READ_BASE64: 'file:read-base64',
  FILE_WRITE: 'file:write',
  /** 二进制写入：payload 为 Base64，需工作区写入权限。 */
  FILE_WRITE_BASE64: 'file:write-base64',
  FILE_LIST: 'file:list',
  FILE_STAT: 'file:stat',
  FILE_MKDIR: 'file:mkdir',
  FILE_DELETE: 'file:delete',

  NETWORK_REQUEST: 'network:request',

  /** Chromium (hidden BrowserWindow) — all gated + URL policy in main. */
  BROWSER_GET_HTML: 'browser:get-html',
  BROWSER_SCREENSHOT: 'browser:screenshot',
  BROWSER_EVALUATE: 'browser:evaluate',
  BROWSER_OPEN_LOGIN: 'browser:open-login',
  BROWSER_CLOSE_LOGIN: 'browser:close-login',
  BROWSER_SESSION_INFO: 'browser:session-info',
  BROWSER_CLEAR_SESSION: 'browser:clear-session',

  CONFIG_GET: 'config:get',
  CONFIG_SET_WORKSPACE: 'config:set-workspace',
  CONFIG_SET_WORKSPACE_WRITE: 'config:set-workspace-write',
  DIALOG_SELECT_WORKSPACE: 'dialog:select-workspace',

  /** OpenRouter（DeepSeek）聊天；API Key 仅主进程环境变量。 */
  LLM_CHAT: 'llm:chat',
  LLM_STATUS: 'llm:status',

  /** 独立文件浏览器（绝对路径）。 */
  FS_VIEW_LIST: 'fs-view:list',
  FS_VIEW_READ_TEXT: 'fs-view:read-text',
  FS_VIEW_STAT: 'fs-view:stat',
  /** 注册 `laika-preview://` 只读流 token。 */
  FS_VIEW_PREVIEW_REGISTER: 'fs-view:preview-register',
  /** docx / xlsx(xls) / pptx 结构化预览（主进程解析）。 */
  FS_VIEW_DOCUMENT_PREVIEW: 'fs-view:document-preview',
  FS_VIEW_POPUP_MENU: 'fs-view:popup-menu',
  FS_VIEW_REVEAL_PATH: 'fs-view:reveal-path',
  FS_VIEW_PICK_FOLDER: 'fs-view:pick-folder',
  VIEWER_OPEN_WINDOW: 'viewer:open-window',

  /** 用户确认后的宿主 shell（cwd=工作区）。 */
  SHELL_EXEC_APPROVED: 'shell:exec-approved',
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

/** main → viewer：`webContents.send` 信道名（非 invoke）。 */
export const IPC_FS_VIEW_ROOT_EVENT = 'fs-view:emit-root' as const;
