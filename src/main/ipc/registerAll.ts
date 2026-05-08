import { ipcMain } from 'electron';
import { registerFileHandlers } from './fileHandlers';
import { registerNetworkHandlers } from './networkHandlers';
import { registerConfigHandlers } from './configHandlers';
import { registerBrowserHandlers } from './browserHandlers';
import { auditLog } from '../security/audit';
import { IPC_WORKSPACE_INFO, IPC_WORKSPACE_RESOLVE } from '../../types/ipc';
import { getPathValidator } from '../workspaceContext';

export function registerAllIPCHandlers(): void {
  registerFileHandlers();
  registerNetworkHandlers();
  registerConfigHandlers();
  registerBrowserHandlers();

  ipcMain.handle(IPC_WORKSPACE_INFO, () => ({
    success: true,
    data: {
      virtualRoot: '/',
      workspaceRoot: getPathValidator().getWorkspaceRoot(),
    },
  }));

  ipcMain.handle(IPC_WORKSPACE_RESOLVE, (_event, payload: { path: string }) => {
    try {
      const pathValidator = getPathValidator();
      const absolute = pathValidator.validate(payload.path || '.');
      return { success: true, data: { absolute } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      auditLog.warn('WORKSPACE_RESOLVE_ERROR', { path: payload.path, message });
      return { success: false, error: message };
    }
  });

  auditLog.info('IPC_REGISTERED', {});
}
