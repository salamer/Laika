import { ipcMain } from 'electron';
import { readFile, writeFile, mkdir, readdir, stat, unlink, rm } from 'fs/promises';
import { PathValidationError } from '../security/pathValidator';
import { auditLog } from '../security/audit';
import { IPC_CHANNELS, FileInfo } from '../../types/ipc';
import { join } from 'node:path';
import { getPathValidator } from '../workspaceContext';

const MAX_FILE_SIZE = 50 * 1024 * 1024;

export function registerFileHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.FILE_READ, async (_event, payload: { path: string; requestId: string }) => {
    try {
      const pathValidator = getPathValidator();
      const safePath = pathValidator.validate(payload.path);
      const content = await readFile(safePath, 'utf-8');
      auditLog.info('FILE_READ', { virtualPath: payload.path, safePath, size: content.length });
      return { success: true, data: content, requestId: payload.requestId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      auditLog.error('FILE_READ_ERROR', { virtualPath: payload.path, error: message });
      return { success: false, error: message, requestId: payload.requestId };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_WRITE, async (_event, payload: { path: string; content: string; requestId: string }) => {
    try {
      if (Buffer.byteLength(payload.content, 'utf-8') > MAX_FILE_SIZE) {
        return { success: false, error: 'File too large (max 50MB)', requestId: payload.requestId };
      }
      const pathValidator = getPathValidator();
      const safePath = pathValidator.validate(payload.path);
      await writeFile(safePath, payload.content, 'utf-8');
      auditLog.info('FILE_WRITE', { virtualPath: payload.path, safePath, size: payload.content.length });
      return { success: true, requestId: payload.requestId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      auditLog.error('FILE_WRITE_ERROR', { virtualPath: payload.path, error: message });
      return { success: false, error: message, requestId: payload.requestId };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_LIST, async (_event, payload: { path: string; requestId: string }) => {
    try {
      const pathValidator = getPathValidator();
      const safePath = pathValidator.validate(payload.path || '.');
      const entries = await readdir(safePath, { withFileTypes: true });
      const files: FileInfo[] = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = join(safePath, entry.name);
          const stats = await stat(fullPath);
          return {
            name: entry.name,
            path: pathValidator.toVirtualPath(fullPath),
            isDirectory: entry.isDirectory(),
            size: stats.size,
            modified: stats.mtimeMs,
          };
        })
      );
      return { success: true, data: files, requestId: payload.requestId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message, requestId: payload.requestId };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_MKDIR, async (_event, payload: { path: string; requestId: string }) => {
    try {
      const pathValidator = getPathValidator();
      const safePath = pathValidator.validate(payload.path);
      await mkdir(safePath, { recursive: true });
      auditLog.info('FILE_MKDIR', { virtualPath: payload.path, safePath });
      return { success: true, requestId: payload.requestId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message, requestId: payload.requestId };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.FILE_DELETE,
    async (_event, payload: { path: string; recursive?: boolean; requestId: string }) => {
    try {
      const pathValidator = getPathValidator();
      const safePath = pathValidator.validate(payload.path);
      if (safePath === pathValidator.getWorkspaceRoot()) {
        return { success: false, error: 'Cannot delete workspace root', requestId: payload.requestId };
      }
      if (payload.recursive) {
        await rm(safePath, { recursive: true, force: true });
      } else {
        await unlink(safePath);
      }
      auditLog.info('FILE_DELETE', { virtualPath: payload.path, safePath });
      return { success: true, requestId: payload.requestId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message, requestId: payload.requestId };
    }
  });
}
