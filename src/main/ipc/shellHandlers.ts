import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { IPC_CHANNELS } from '../../types/ipc';
import { auditLog, errorFields } from '../logging';
import { getPathValidator } from '../workspaceContext';

const MAX_IO_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 仅应在用户界面显式确认后调用：在工作区 cwd 下执行 shell。
 */
export function registerShellHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.SHELL_EXEC_APPROVED,
    async (
      _evt,
      payload: { script: string; timeoutMs?: number; requestId: string }
    ): Promise<{
      success: boolean;
      data?: { code: number | null; stdout: string; stderr: string };
      error?: string;
      requestId: string;
    }> => {
      const cwd = getPathValidator().getWorkspaceRoot();
      const trimmed = payload.script.trim();
      if (!trimmed) {
        return { success: false, error: 'Empty command', requestId: payload.requestId };
      }

      const timeoutMs = Math.min(Math.max(payload.timeoutMs ?? DEFAULT_TIMEOUT_MS, 5_000), 600_000);
      auditLog.warn('HOST_SHELL_EXEC_STARTED', {
        cwd,
        scriptPreview: trimmed.slice(0, 300),
      });

      try {
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const outChunks: Buffer[] = [];
            const errChunks: Buffer[] = [];
            let outN = 0;
            let errN = 0;

            const child = spawn(trimmed, { cwd, shell: true });

            const timer = setTimeout(() => {
              child.kill('SIGTERM');
              reject(new Error(`Host shell timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            child.stdout?.on('data', (buf: Buffer) => {
              if (outN >= MAX_IO_BYTES) return;
              const take = Math.min(buf.length, MAX_IO_BYTES - outN);
              if (take > 0) {
                outChunks.push(Buffer.from(buf.subarray(0, take)));
                outN += take;
              }
            });

            child.stderr?.on('data', (buf: Buffer) => {
              if (errN >= MAX_IO_BYTES) return;
              const take = Math.min(buf.length, MAX_IO_BYTES - errN);
              if (take > 0) {
                errChunks.push(Buffer.from(buf.subarray(0, take)));
                errN += take;
              }
            });

            child.on('close', (code) => {
              clearTimeout(timer);
              resolve({
                code: typeof code === 'number' ? code : null,
                stdout: Buffer.concat(outChunks).toString('utf-8'),
                stderr: Buffer.concat(errChunks).toString('utf-8'),
              });
            });

            child.on('error', (err) => {
              clearTimeout(timer);
              reject(err);
            });
          }
        );

        auditLog.info('HOST_SHELL_EXEC_DONE', {
          cwd,
          code: result.code,
          stdoutBytes: result.stdout.length,
          stderrBytes: result.stderr.length,
        });

        return { success: true, data: result, requestId: payload.requestId };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        auditLog.error('HOST_SHELL_EXEC_ERROR', { cwd, message, ...errorFields(e) });
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );
}
