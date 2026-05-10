import { useState, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import type { WorkerCommand, WorkerResponse, WorkerResultResponse } from '../../types/worker';
import { createBridgeLogger, summarizeHostArgs, summarizeHostResult } from '../../shared/bridgeLogger';

/** 宿主侧：`HOST_CALL` 在此落地为 Electron IPC；结构与 Worker 对称。 */
const log = createBridgeLogger('pyodideHostBridge');

interface WorkerState {
  state: 'uninitialized' | 'initializing' | 'ready' | 'busy' | 'error' | 'terminated';
  pyodideVersion?: string;
  uptimeMs: number;
}

export type ExecuteOptions = {
  timeoutMs?: number;
  /** When set to `shell`, `code` is parsed with bashlex and run in Python. */
  mode?: 'python' | 'shell';
  resetShellSession?: boolean;
  /** stdout/stderr chunks for this run only (request-scoped). */
  onStream?: (stream: 'stdout' | 'stderr', text: string) => void;
};

export function usePyodideWorker() {
  const workerRef = useRef<Worker | null>(null);
  const streamByRequestRef = useRef<
    Map<string, (stream: 'stdout' | 'stderr', text: string) => void>
  >(new Map());

  const [status, setStatus] = useState<WorkerState>({
    state: 'uninitialized',
    uptimeMs: 0,
  });

  const pendingRequests = useRef<
    Map<
      string,
      {
        resolve: (value: WorkerResultResponse['payload']) => void;
        reject: (reason: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >
  >(new Map());

  const handleHostCall = useCallback(
    async (worker: Worker, method: string, args: unknown[], requestId: string): Promise<void> => {
      const t0 = performance.now();

      /** 每条 Python→Worker→此处的宿主调用都打点；磁盘 IO 与方法名见 `summarizeHostArgs`。 */
      log.debug('hostBridge:incoming', {
        requestId,
        method,
        ...summarizeHostArgs(method, args),
      });

      try {
        let result: unknown;

        switch (method) {
          /** --- Workspace 文件读写（高频 IO） --- */
          case 'deleteFile': {
            const recursive = Boolean(args[1]);
            const response = await window.electronAPI.file.delete(args[0] as string, { recursive });
            if (!response.success) throw new Error(response.error);
            result = null;
            break;
          }
          case 'readFile': {
            const response = await window.electronAPI.file.readFile(args[0] as string);
            if (!response.success) throw new Error(response.error);
            result = response.data;
            break;
          }
          case 'readFileBase64': {
            const response = await window.electronAPI.file.readFileBase64(args[0] as string);
            if (!response.success) throw new Error(response.error);
            result = response.data;
            break;
          }
          case 'writeFile': {
            const response = await window.electronAPI.file.writeFile(
              args[0] as string,
              args[1] as string
            );
            if (!response.success) throw new Error(response.error);
            result = null;
            break;
          }
          case 'writeFileBase64': {
            const response = await window.electronAPI.file.writeFileBase64(
              args[0] as string,
              args[1] as string
            );
            if (!response.success) throw new Error(response.error);
            result = null;
            break;
          }
          case 'listFiles': {
            const response = await window.electronAPI.file.listFiles(args[0] as string);
            if (!response.success) throw new Error(response.error);
            result = response.data;
            break;
          }
          case 'statFile': {
            const response = await window.electronAPI.file.stat(args[0] as string);
            if (!response.success) throw new Error(response.error);
            result = JSON.stringify(response.data);
            break;
          }
          case 'mkdir': {
            const response = await window.electronAPI.file.mkdir(args[0] as string);
            if (!response.success) throw new Error(response.error);
            result = null;
            break;
          }
          /** --- 工作区元数据（轻量 IPC） --- */
          case 'workspaceInfo': {
            const response = await window.electronAPI.workspace.info();
            if (!response.success) throw new Error(response.error);
            result = JSON.stringify(response.data);
            break;
          }
          case 'workspaceResolvePath': {
            const response = await window.electronAPI.workspace.resolvePath(args[0] as string);
            if (!response.success) throw new Error(response.error);
            result = JSON.stringify(response.data);
            break;
          }
          /** --- 受控网络 / 浏览器自动化（可能较慢） --- */
          case 'httpRequest': {
            const raw = args[0];
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const response = await window.electronAPI.network.request(parsed);
            if (!response.success) throw new Error(response.error);
            result = JSON.stringify(response.data);
            break;
          }
          case 'browserGetHtml': {
            const opts = JSON.parse(args[0] as string) as {
              url: string;
              timeoutMs?: number;
              waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
            };
            const response = await window.electronAPI.browser.getHtml(opts);
            if (!response.success) throw new Error(response.error);
            result = response.data;
            break;
          }
          case 'browserOpenLogin': {
            const opts = JSON.parse(args[0] as string) as { url: string };
            const response = await window.electronAPI.browser.openLogin(opts);
            if (!response.success) throw new Error(response.error);
            result = null;
            break;
          }
          case 'browserScreenshot': {
            const opts = JSON.parse(args[0] as string) as {
              url: string;
              path: string;
              fullPage?: boolean;
              timeoutMs?: number;
              waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
            };
            const response = await window.electronAPI.browser.screenshot(opts);
            if (!response.success) throw new Error(response.error);
            result = response.data;
            break;
          }
          case 'browserEvaluate': {
            const opts = JSON.parse(args[0] as string) as {
              url: string;
              script: string;
              timeoutMs?: number;
              waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
            };
            const response = await window.electronAPI.browser.evaluate(opts);
            if (!response.success) throw new Error(response.error);
            result = response.data;
            break;
          }
          default:
            throw new Error(`Unknown host method: ${method}`);
        }

        const elapsedMs = Math.round(performance.now() - t0);
        log.debug('hostBridge:electronDone', {
          requestId,
          method,
          elapsedMs,
          ...summarizeHostResult(method, result),
        });

        worker.postMessage({ type: 'HOST_RESPONSE', requestId, result });
      } catch (error) {
        log.error('hostBridge:electronError', {
          requestId,
          method,
          ...summarizeHostArgs(method, args),
          error: error instanceof Error ? error.message : String(error),
        });
        worker.postMessage({
          type: 'HOST_RESPONSE',
          requestId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
    []
  );

  /** 创建 DedicatedWorker；生命周期与 Pyodide 实例一一对应。 */
  const createWorker = useCallback((): Worker => {
    if (workerRef.current) {
      log.debug('worker:terminate:previous');
      workerRef.current.terminate();
    }

    log.info('worker:spawn');

    const worker = new Worker(new URL('../../worker/pyodideWorker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (
      event: MessageEvent<
        WorkerResponse | { type: 'HOST_CALL'; method: string; args: unknown[]; requestId: string }
      >
    ) => {
      const msg = event.data;

      if (msg.type === 'HOST_CALL') {
        handleHostCall(worker, msg.method, msg.args, msg.requestId);
        return;
      }

      if (msg.type === 'OUTPUT') {
        const handler = streamByRequestRef.current.get(msg.payload.requestId);
        if (handler) {
          flushSync(() => {
            handler(msg.payload.stream, msg.payload.text);
          });
        }
        return;
      }

      switch (msg.type) {
        case 'STATUS':
          setStatus(msg.payload as WorkerState);
          break;
        case 'RESULT':
        case 'ERROR': {
          const rid = msg.payload.requestId;
          streamByRequestRef.current.delete(rid);
          const pending = pendingRequests.current.get(rid);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRequests.current.delete(rid);
            if (msg.type === 'RESULT') pending.resolve(msg.payload);
            else pending.reject(new Error(msg.payload.message));
          }
          break;
        }
        case 'INITIALIZED':
          setStatus((prev) => ({ ...prev, pyodideVersion: msg.payload.pyodideVersion }));
          break;
        default:
          break;
      }
    };

    worker.onerror = (error) => {
      log.error('worker:runtimeError', { message: error.message, filename: error.filename, lineno: error.lineno });
      setStatus((prev) => ({ ...prev, state: 'error' }));
    };

    workerRef.current = worker;
    return worker;
  }, [handleHostCall]);

  const initialize = useCallback(async (): Promise<void> => {
    const worker = createWorker();
    log.info('pyodide:initialize:posted');
    setStatus({ state: 'initializing', uptimeMs: 0 });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Pyodide initialization timed out'));
      }, 300_000);

      const handler = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.type === 'INITIALIZED') {
          worker.removeEventListener('message', handler);
          clearTimeout(timeout);
          log.info('pyodide:initialize:ready');
          resolve();
        } else if (event.data.type === 'ERROR') {
          worker.removeEventListener('message', handler);
          clearTimeout(timeout);
          log.error('pyodide:initialize:workerError', { message: event.data.payload.message });
          reject(new Error(event.data.payload.message));
        }
      };

      worker.addEventListener('message', handler);
      worker.postMessage({ type: 'INIT' } as WorkerCommand);
    });
  }, [createWorker]);

  const execute = useCallback(async (code: string, options?: ExecuteOptions) => {
    const worker = workerRef.current;
    if (!worker) throw new Error('Worker not initialized');

    const requestId = crypto.randomUUID();
    const timeoutMs = options?.timeoutMs ?? 120_000;

    log.debug('pyodide:execute:posted', {
      requestId,
      mode: options?.mode ?? 'python',
      codeChars: code.length,
      timeoutMs,
      resetShellSession: options?.resetShellSession,
    });

    if (options?.onStream) {
      streamByRequestRef.current.set(requestId, options.onStream);
    }

    return new Promise<WorkerResultResponse['payload']>((resolve, reject) => {
      const timer = setTimeout(() => {
        streamByRequestRef.current.delete(requestId);
        pendingRequests.current.delete(requestId);
        reject(new Error('Execution timed out'));
      }, timeoutMs + 10_000);

      pendingRequests.current.set(requestId, { resolve, reject, timer });

      worker.postMessage({
        type: 'EXECUTE',
        payload: {
          code,
          timeoutMs,
          requestId,
          mode: options?.mode ?? 'python',
          resetShellSession: options?.resetShellSession,
        },
      } as WorkerCommand);
    });
  }, []);

  const terminate = useCallback(() => {
    log.info('pyodide:terminate:requested');
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'TERMINATE' } as WorkerCommand);
      setTimeout(() => {
        workerRef.current?.terminate();
        workerRef.current = null;
      }, 100);
    }
    setStatus({ state: 'terminated', uptimeMs: 0 });
    streamByRequestRef.current.clear();
    pendingRequests.current.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new Error('Worker terminated'));
    });
    pendingRequests.current.clear();
  }, []);

  const restart = useCallback(async () => {
    terminate();
    await new Promise((r) => setTimeout(r, 200));
    await initialize();
  }, [terminate, initialize]);

  return {
    status,
    isExecuting: status.state === 'busy',
    initialize,
    execute,
    terminate,
    restart,
  };
}
