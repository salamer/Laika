import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { loadSettings, saveSettings, settingsFilePath } from '../configStore';
import { setWorkspaceRoot } from '../workspaceContext';
import { initWorkspace } from './workspace';
import { auditLog } from '../security/audit';
import { IPC_CHANNELS } from '../../types/ipc';
import type { AppSettings } from '../../types/settings';

type SetWorkspaceResult =
  | { success: true; data: { workspaceRoot: string } }
  | { success: false; error: string };

const folderDialogOptions: OpenDialogOptions = {
  title: 'Select workspace folder',
  buttonLabel: 'Choose',
  defaultPath: app.getPath('documents'),
  properties: ['openDirectory', 'createDirectory'],
};

export function registerConfigHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, (): { success: true; data: AppSettings } => {
    const { workspaceRoot } = loadSettings();
    return { success: true, data: { workspaceRoot, configFilePath: settingsFilePath(), browserAllowedHosts: ['*'] } };
  });

  ipcMain.handle(
    IPC_CHANNELS.CONFIG_SET_WORKSPACE,
    (_event, payload: { workspaceRoot: string }): SetWorkspaceResult => {
      try {
        const raw = payload.workspaceRoot?.trim();
        if (!raw) {
          return { success: false, error: '路径不能为空' };
        }
        const absolute = resolve(raw);
        if (!existsSync(absolute)) {
          mkdirSync(absolute, { recursive: true });
        }
        saveSettings({ workspaceRoot: absolute });
        setWorkspaceRoot(absolute);
        initWorkspace(absolute);
        auditLog.info('WORKSPACE_CONFIG_UPDATED', { workspaceRoot: absolute });
        return { success: true, data: { workspaceRoot: absolute } };
      } catch (e) {
        const message = e instanceof Error ? e.message : '保存失败';
        auditLog.error('WORKSPACE_CONFIG_ERROR', { error: message });
        return { success: false, error: message };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_WORKSPACE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, folderDialogOptions)
      : await dialog.showOpenDialog(folderDialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false as const, canceled: true };
    }
    return { success: true as const, path: result.filePaths[0] };
  });
}
