import { BrowserWindow, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { IPC_CHANNELS, IPC_FS_VIEW_ROOT_EVENT } from '../types/ipc';
import { auditLog, errorFields } from './logging';

let viewerWin: BrowserWindow | null = null;

async function resolveExistingDir(raw: string): Promise<{ ok: true; abs: string } | { ok: false; msg: string }> {
  const abs0 = resolve(normalize(raw.trim()));
  if (!existsSync(abs0)) {
    return { ok: false, msg: '路径不存在。' };
  }
  try {
    const rp = await realpath(abs0);
    if (!existsSync(rp)) return { ok: false, msg: '路径不可用。' };
    return { ok: true, abs: rp };
  } catch {
    return { ok: true, abs: abs0 };
  }
}

/**
 * “文件浏览器”独立窗口：`viewer.html`，与主页共用 preload / 打包产物路径。
 */
export function registerViewerWindowHandler(bundle: {
  preloadPath: string;
  rendererDistDir: string;
  viteDevUrl: string | undefined;
}): void {
  ipcMain.handle(IPC_CHANNELS.VIEWER_OPEN_WINDOW, async (_e, payload: { root: string }) => {
    try {
      const res = await resolveExistingDir(payload.root);
      if (!res.ok) return { success: false, error: res.msg };

      const sendRoot = (): void => {
        if (!viewerWin || viewerWin.isDestroyed()) return;
        viewerWin.webContents.send(IPC_FS_VIEW_ROOT_EVENT, res.abs);
      };

      const openOrReload = async (): Promise<void> => {
        if (!viewerWin || viewerWin.isDestroyed()) return;
        const devUrl = bundle.viteDevUrl?.trim();
        if (devUrl) {
          const base = devUrl.replace(/\/$/, '');
          await viewerWin.webContents.loadURL(
            `${base}/viewer.html?root=${encodeURIComponent(res.abs)}`
          );
        } else {
          await viewerWin.webContents.loadFile(join(bundle.rendererDistDir, 'viewer.html'), {
            query: { root: res.abs },
          });
        }
        sendRoot();
      };

      if (viewerWin && !viewerWin.isDestroyed()) {
        await openOrReload();
        viewerWin.show();
        viewerWin.focus();
        auditLog.info('VIEWER_FOCUS', { root: res.abs });
        return { success: true, data: { root: res.abs } };
      }

      viewerWin = new BrowserWindow({
        width: 960,
        height: 680,
        minWidth: 480,
        minHeight: 400,
        title: 'Laika — File viewer',
        backgroundColor: '#101014',
        webPreferences: {
          preload: bundle.preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      viewerWin.on('closed', () => {
        viewerWin = null;
      });

      await openOrReload();
      viewerWin.show();

      auditLog.info('VIEWER_OPEN', { root: res.abs });
      return { success: true, data: { root: res.abs } };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      auditLog.error('VIEWER_OPEN_ERROR', { message, ...errorFields(e) });
      return { success: false, error: message };
    }
  });
}
