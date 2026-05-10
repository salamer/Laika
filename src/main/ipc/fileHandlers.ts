import { ipcMain } from 'electron';
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'fs/promises';
import { auditLog, errorFields } from '../logging';
import { IPC_CHANNELS, FileInfo } from '../../types/ipc';
import { join } from 'node:path';
import { getPathValidator } from '../workspaceContext';
import { isWorkspaceWriteEnabled } from '../configStore';

const MAX_FILE_SIZE = 50 * 1024 * 1024;

function writeForbiddenMessage(): string {
  return '工作区写入未启用：请在代码侧横幅中授权写入，或通过设置开启。';
}

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
      auditLog.error('FILE_READ_ERROR', { virtualPath: payload.path, message, ...errorFields(error) });
      return { success: false, error: message, requestId: payload.requestId };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_READ_BASE64, async (_event, payload: { path: string; requestId: string }) => {
    try {
      const pathValidator = getPathValidator();
      const safePath = pathValidator.validate(payload.path);
      const buf = await readFile(safePath);
      if (buf.length > MAX_FILE_SIZE) {
        return { success: false, error: 'File too large (max 50MB)', requestId: payload.requestId };
      }
      auditLog.info('FILE_READ_BASE64', { virtualPath: payload.path, safePath, bytes: buf.length });
      return { success: true, data: buf.toString('base64'), requestId: payload.requestId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      auditLog.error('FILE_READ_BASE64_ERROR', { virtualPath: payload.path, message, ...errorFields(error) });
      return { success: false, error: message, requestId: payload.requestId };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_WRITE, async (_event, payload: { path: string; content: string; requestId: string }) => {
    try {
      if (!isWorkspaceWriteEnabled()) {
        return { success: false, error: writeForbiddenMessage(), requestId: payload.requestId };
      }
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
      auditLog.error('FILE_WRITE_ERROR', { virtualPath: payload.path, message, ...errorFields(error) });
      return { success: false, error: message, requestId: payload.requestId };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.FILE_WRITE_BASE64,
    async (_event, payload: { path: string; contentBase64: string; requestId: string }) => {
      try {
        if (!isWorkspaceWriteEnabled()) {
          return { success: false, error: writeForbiddenMessage(), requestId: payload.requestId };
        }
        const pathValidator = getPathValidator();
        const safePath = pathValidator.validate(payload.path);
        let buf: Buffer;
        try {
          buf = Buffer.from(payload.contentBase64, 'base64');
        } catch {
          return { success: false, error: 'Invalid Base64 payload', requestId: payload.requestId };
        }
        if (buf.length > MAX_FILE_SIZE) {
          return { success: false, error: 'File too large (max 50MB)', requestId: payload.requestId };
        }
        await writeFile(safePath, buf);
        auditLog.info('FILE_WRITE_BASE64', {
          virtualPath: payload.path,
          safePath,
          bytes: buf.length,
        });
        return { success: true, requestId: payload.requestId };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        auditLog.error('FILE_WRITE_BASE64_ERROR', {
          virtualPath: payload.path,
          message,
          ...errorFields(error),
        });
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );

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

  ipcMain.handle(IPC_CHANNELS.FILE_STAT, async (_event, payload: { path: string; requestId: string }) => {
    try {
      const pathValidator = getPathValidator();
      const safePath = pathValidator.validate(payload.path || '.');
      const st = await stat(safePath);
      auditLog.info('FILE_STAT', { virtualPath: payload.path, safePath });
      return {
        success: true,
        data: {
          size: st.size,
          is_directory: st.isDirectory(),
          modified_ms: st.mtimeMs,
        },
        requestId: payload.requestId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      auditLog.warn('FILE_STAT_ERROR', { path: payload.path, message, ...errorFields(error) });
      return { success: false, error: message, requestId: payload.requestId };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_MKDIR, async (_event, payload: { path: string; requestId: string }) => {
    try {
      if (!isWorkspaceWriteEnabled()) {
        return { success: false, error: writeForbiddenMessage(), requestId: payload.requestId };
      }
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
        if (!isWorkspaceWriteEnabled()) {
          return { success: false, error: writeForbiddenMessage(), requestId: payload.requestId };
        }
        const pathValidator = getPathValidator();
        const safePath = pathValidator.validate(payload.path);
        if (safePath === pathValidator.getWorkspaceRoot()) {
          return { success: false, error: 'Cannot delete workspace root', requestId: payload.requestId };
        }
        await rm(safePath, { recursive: Boolean(payload.recursive), force: Boolean(payload.recursive) });
        auditLog.info('FILE_DELETE', { virtualPath: payload.path, safePath });
        return { success: true, requestId: payload.requestId };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );
}
