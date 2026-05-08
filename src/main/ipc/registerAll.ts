import { ipcMain } from 'electron';
import { registerFileHandlers } from './fileHandlers';
import { registerNetworkHandlers } from './networkHandlers';
import { registerConfigHandlers } from './configHandlers';
import { auditLog } from '../security/audit';
import { IPC_WORKSPACE_INFO } from '../../types/ipc';
import { getPathValidator } from '../workspaceContext';

export function registerAllIPCHandlers(): void {
  registerFileHandlers();
  registerNetworkHandlers();
  registerConfigHandlers();

  ipcMain.handle(IPC_WORKSPACE_INFO, () => ({
    success: true,
    data: {
      virtualRoot: '/',
      workspaceRoot: getPathValidator().getWorkspaceRoot(),
    },
  }));

  auditLog.info('IPC_REGISTERED', {});
}
