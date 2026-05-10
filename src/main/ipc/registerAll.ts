/**
 * 注册所有 `ipcMain.handle` 入口；各子模块在对应 `register*Handlers` 内登记。
 * 安全相关结果应经 `auditLog` 或 `scoped()` 记录。
 */
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { registerFileHandlers } from './fileHandlers';
import { registerNetworkHandlers } from './networkHandlers';
import { registerConfigHandlers } from './configHandlers';
import { registerBrowserHandlers } from './browserHandlers';
import { registerLlmHandlers } from './llmHandlers';
import { registerShellHandlers } from './shellHandlers';
import { registerFsViewerHandlers } from './fsViewerHandlers';
import { registerViewerWindowHandler } from '../viewerWindow';
import { auditLog, errorFields } from '../logging';
import { IPC_WORKSPACE_INFO, IPC_WORKSPACE_RESOLVE } from '../../types/ipc';
import { getPathValidator } from '../workspaceContext';
import { getMainBundledDirs } from '../paths';
import { loadSettings } from '../configStore';

/** @param mainWindowGetter 在主窗口赋值后可返回 BrowserWindow（用于对话框父级）。 */
export function registerAllIPCHandlers(mainWindowGetter: () => BrowserWindow | null): void {
  registerFileHandlers();
  registerNetworkHandlers();
  registerConfigHandlers();
  registerBrowserHandlers();
  registerLlmHandlers();
  registerShellHandlers();
  registerFsViewerHandlers(mainWindowGetter);

  const bundled = getMainBundledDirs();
  registerViewerWindowHandler({
    preloadPath: bundled.preload,
    rendererDistDir: bundled.rendererDistDir,
    viteDevUrl: process.env.VITE_DEV_SERVER_URL,
  });

  ipcMain.handle(IPC_WORKSPACE_INFO, () => {
    const ws = loadSettings();
    return {
      success: true as const,
      data: {
        virtualRoot: '/',
        workspaceRoot: getPathValidator().getWorkspaceRoot(),
        workspaceWriteEnabled: ws.workspaceWriteEnabled,
      },
    };
  });

  ipcMain.handle(IPC_WORKSPACE_RESOLVE, (_event, payload: { path: string }) => {
    try {
      const pathValidator = getPathValidator();
      const absolute = pathValidator.validate(payload.path || '.');
      return { success: true, data: { absolute } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      auditLog.warn('WORKSPACE_RESOLVE_ERROR', { path: payload.path, message, ...errorFields(error) });
      return { success: false, error: message };
    }
  });

  auditLog.info('IPC_REGISTERED', {});
}
