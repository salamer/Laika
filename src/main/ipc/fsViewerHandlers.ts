import { ipcMain, dialog, BrowserWindow, Menu, shell, clipboard } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { basename, dirname, normalize, resolve, sep } from 'node:path';
import { IPC_CHANNELS } from '../../types/ipc';
import type { FileInfo } from '../../types/ipc';
import type { DocumentPreviewResult } from '../../types/documentPreview';
import { auditLog, errorFields } from '../logging';
import { allocatePreviewUrl } from '../previewProtocol';
import { previewOfficeBuffer } from '../documentPreview';

const MAX_TEXT_PREVIEW = 512 * 1024;

async function canonicalize(existingPath: string): Promise<string | null> {
  const abs = resolve(normalize(existingPath.trim()));
  if (!existsSync(abs)) return null;
  try {
    return await realpath(abs);
  } catch {
    return abs;
  }
}

/**
 * 文件浏览器：任意「存在」绝对路径列出目录或预览 UTF-8/UTF16 文本片段。
 */
export function registerFsViewerHandlers(getMainWindow?: () => BrowserWindow | null): void {
  ipcMain.handle(
    IPC_CHANNELS.FS_VIEW_LIST,
    async (_e, payload: { absolutePath: string; requestId: string }) => {
      try {
        const can = await canonicalize(payload.absolutePath);
        if (!can)
          return { success: false, error: 'Path does not exist', requestId: payload.requestId };
        const st = await stat(can);
        if (!st.isDirectory()) {
          return { success: false, error: 'Not a directory', requestId: payload.requestId };
        }

        const cwd = can;
        const pd = dirname(cwd);
        const parent: string | null = pd === cwd ? null : pd;

        const dirents = await readdir(cwd, { withFileTypes: true });
        const entries: FileInfo[] = [];

        for (const d of dirents) {
          const joined = `${cwd}${sep}${d.name}`;
          try {
            const s = await stat(joined);
            entries.push({
              name: d.name,
              path: joined,
              isDirectory: d.isDirectory(),
              size: s.size,
              modified: s.mtimeMs,
            });
          } catch {
            entries.push({
              name: d.name,
              path: joined,
              isDirectory: d.isDirectory(),
              size: 0,
              modified: 0,
            });
          }
        }

        entries.sort(
          (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)
        );

        return {
          success: true,
          data: { cwd, parent, entries },
          requestId: payload.requestId,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        auditLog.error('FS_VIEW_LIST_ERROR', { message, ...errorFields(e) });
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FS_VIEW_READ_TEXT,
    async (_e, payload: { absolutePath: string; requestId: string }) => {
      try {
        const can = await canonicalize(payload.absolutePath);
        if (!can)
          return { success: false, error: 'Path does not exist', requestId: payload.requestId };
        const st = await stat(can);
        if (st.isDirectory()) {
          return { success: false, error: 'Is a directory', requestId: payload.requestId };
        }
        if (st.size > MAX_TEXT_PREVIEW) {
          return {
            success: false,
            error: `File too large for preview (${st.size} bytes, max ${MAX_TEXT_PREVIEW})`,
            requestId: payload.requestId,
          };
        }
        const raw = await readFile(can);
        const nulIx = raw.indexOf(0);
        if (nulIx !== -1 && nulIx < 1024) {
          return {
            success: false,
            error: 'Preview supports text files only',
            requestId: payload.requestId,
          };
        }

        let text = raw.toString('utf8');
        if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
          text = raw.slice(2).toString('utf16le');
        }

        return {
          success: true,
          data: { absolutePath: can, name: basename(can), content: text },
          requestId: payload.requestId,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        auditLog.error('FS_VIEW_READ_TEXT_ERROR', { message, ...errorFields(e) });
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FS_VIEW_STAT,
    async (_e, payload: { absolutePath: string; requestId: string }) => {
      try {
        const can = await canonicalize(payload.absolutePath);
        if (!can)
          return { success: false, error: 'Path does not exist', requestId: payload.requestId };
        const st = await stat(can);
        return {
          success: true,
          requestId: payload.requestId,
          data: {
            absolutePath: can,
            name: basename(can),
            isDirectory: st.isDirectory(),
            size: st.size,
            modified: st.mtimeMs,
          },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FS_VIEW_PREVIEW_REGISTER,
    async (_e, payload: { absolutePath: string; mimeType?: string; requestId: string }) => {
      try {
        const can = await canonicalize(payload.absolutePath);
        if (!can)
          return { success: false, error: 'Path does not exist', requestId: payload.requestId };
        const st = await stat(can);
        if (!st.isFile()) {
          return { success: false, error: 'Not a file', requestId: payload.requestId };
        }
        const url = allocatePreviewUrl(can, payload.mimeType);
        auditLog.info('FS_PREVIEW_TOKEN', { path: can, mime: payload.mimeType });
        return {
          success: true,
          requestId: payload.requestId,
          data: { url, absolutePath: can, mimeType: payload.mimeType ?? '' },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FS_VIEW_DOCUMENT_PREVIEW,
    async (_e, payload: { absolutePath: string; requestId: string }) => {
      try {
        const can = await canonicalize(payload.absolutePath);
        if (!can)
          return { success: false, error: 'Path does not exist', requestId: payload.requestId };
        const st = await stat(can);
        if (!st.isFile()) {
          return { success: false, error: 'Not a file', requestId: payload.requestId };
        }
        const name = basename(can);
        const lower = name.toLowerCase();
        if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls') && !lower.endsWith('.pptx')) {
          return {
            success: false,
            error: '该通道仅支持 xlsx / xls / pptx（Word 由内嵌 docx-preview 渲染）',
            requestId: payload.requestId,
          };
        }

        const buf = await readFile(can);
        const result: DocumentPreviewResult = await previewOfficeBuffer(name, buf);
        return {
          success: true,
          requestId: payload.requestId,
          data: { absolutePath: can, preview: result },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        auditLog.error('FS_DOCUMENT_PREVIEW_ERROR', { message, ...errorFields(e) });
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FS_VIEW_POPUP_MENU,
    async (event, payload: { targetPath: string; isDirectory: boolean }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { success: false as const, error: 'no-window' };
      const p = payload.targetPath;
      const isDir = payload.isDirectory;
      const revealLabel =
        process.platform === 'darwin' ? '在访达中显示' : '在资源管理器中显示';
      const items: Electron.MenuItemConstructorOptions[] = [
        {
          label: isDir ? '打开此文件夹' : revealLabel,
          click: () => {
            if (isDir) void shell.openPath(p);
            else shell.showItemInFolder(p);
          },
        },
      ];
      if (!isDir) {
        items.push({
          label: '使用默认应用打开',
          click: () => void shell.openPath(p),
        });
      }
      items.push(
        { type: 'separator' },
        {
          label: '复制绝对路径',
          click: () => clipboard.writeText(p),
        }
      );
      const menu = Menu.buildFromTemplate(items);
      menu.popup({ window: win });
      return { success: true as const };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.FS_VIEW_REVEAL_PATH,
    async (_evt, payload: { targetPath: string; isDirectory: boolean }) => {
      try {
        if (payload.isDirectory) await shell.openPath(payload.targetPath);
        else shell.showItemInFolder(payload.targetPath);
        return { success: true as const };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        auditLog.warn('FS_REVEAL_PATH', { message, ...errorFields(e) });
        return { success: false as const, error: message };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.FS_VIEW_PICK_FOLDER, async (evt) => {
    try {
      const bw = BrowserWindow.fromWebContents(evt.sender) ?? getMainWindow?.() ?? null;
      const opts: Electron.OpenDialogOptions = {
        title: '要在文件浏览器中打开的文件夹',
        properties: ['openDirectory', 'createDirectory'],
      };
      const r = bw ? await dialog.showOpenDialog(bw, opts) : await dialog.showOpenDialog(opts);

      if (r.canceled || r.filePaths.length === 0) {
        return { success: false, canceled: true as const };
      }
      auditLog.info('FS_VIEW_FOLDER_PICKED', { folder: r.filePaths[0] });
      let abs = resolve(normalize(r.filePaths[0]));
      abs = await realpath(abs);
      return { success: true as const, path: abs };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, canceled: false as const, error: message };
    }
  });
}
