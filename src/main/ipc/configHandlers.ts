import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { loadSettings, updateSettings, settingsFilePath } from '../configStore';
import {
  llmConfiguredFromEnv,
  openRouterEndpoint,
  openRouterModel,
} from '../llm/env';
import { setWorkspaceRoot } from '../workspaceContext';
import { initWorkspace } from './workspace';
import { auditLog, errorFields } from '../logging';
import { IPC_CHANNELS } from '../../types/ipc';
import type { AppSettings } from '../../types/settings';

type SetWorkspaceResult =
  | { success: true; data: { workspaceRoot: string; workspaceWriteEnabled: boolean } }
  | { success: false; error: string };

type SetWorkspaceWriteResult =
  | { success: true; data: { workspaceWriteEnabled: boolean } }
  | { success: false; error: string };

const folderDialogOptions: OpenDialogOptions = {
  title: 'Select workspace folder',
  buttonLabel: 'Choose',
  defaultPath: app.getPath('documents'),
  properties: ['openDirectory', 'createDirectory'],
};

export function registerConfigHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, (): { success: true; data: AppSettings } => {
    const s = loadSettings();
    return {
      success: true,
      data: {
        workspaceRoot: s.workspaceRoot,
        workspaceWriteEnabled: s.workspaceWriteEnabled,
        configFilePath: settingsFilePath(),
        browserAllowedHosts: ['*'],
        llmConfigured: llmConfiguredFromEnv(),
        llmChatEndpoint: openRouterEndpoint(),
        llmModel: openRouterModel(),
      },
    };
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
        const cur = loadSettings();
        const pathChanged = resolve(cur.workspaceRoot) !== absolute;
        if (!existsSync(absolute)) {
          mkdirSync(absolute, { recursive: true });
        }
        const nextWrite = pathChanged ? false : cur.workspaceWriteEnabled;
        updateSettings({ workspaceRoot: absolute, workspaceWriteEnabled: nextWrite });
        setWorkspaceRoot(absolute);
        initWorkspace(absolute);
        auditLog.info('WORKSPACE_CONFIG_UPDATED', { workspaceRoot: absolute, workspaceWriteEnabled: nextWrite });
        return {
          success: true,
          data: { workspaceRoot: absolute, workspaceWriteEnabled: nextWrite },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : '保存失败';
        auditLog.error('WORKSPACE_CONFIG_ERROR', { message, ...errorFields(e) });
        return { success: false, error: message };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CONFIG_SET_WORKSPACE_WRITE,
    (_event, payload: { workspaceWriteEnabled: boolean }): SetWorkspaceWriteResult => {
      try {
        updateSettings({
          workspaceWriteEnabled: Boolean(payload.workspaceWriteEnabled),
        });
        const s = loadSettings();
        auditLog.info('WORKSPACE_WRITE_FLAG_UPDATED', {
          workspaceWriteEnabled: s.workspaceWriteEnabled,
        });
        return { success: true, data: { workspaceWriteEnabled: s.workspaceWriteEnabled } };
      } catch (e) {
        const message = e instanceof Error ? e.message : '保存失败';
        auditLog.error('WORKSPACE_WRITE_FLAG_ERROR', { message, ...errorFields(e) });
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
