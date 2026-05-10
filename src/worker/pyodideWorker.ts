/// <reference lib="webworker" />

/** Pyodide 0.25+ (and PDF.js) call `Promise.try`; Electron’s Chromium often lacks it. */
import '../renderer/polyfills/promiseTry';

import type { WorkerCommand, WorkerExecuteCommand, WorkerResponse } from '../types/worker';
import { PRELOAD_PYODIDE_PACKAGES, PRELOAD_PYPI_PACKAGES } from './preloadPackages';

import laikaShellSource from './python/laika_shell.py?raw';
import laikaFsSource from './python/laika_fs.py?raw';

const PYODIDE_VERSION = '0.25.1';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// Pyodide is loaded from CDN at runtime; keep loose typing for the instance.
type PyodideRuntime = {
  version: string;
  runPythonAsync: (code: string) => Promise<unknown>;
  pyimport: (name: string) => unknown;
  loadPackage: (pkgs: string | string[]) => Promise<void>;
};

let pyodide: PyodideRuntime | null = null;
let isInitialized = false;
const startTime = Date.now();
let currentRequestId = '';
const stdoutBuffer: string[] = [];
const stderrBuffer: string[] = [];

const pendingHost = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function emitMessage(response: WorkerResponse): void {
  self.postMessage(response);
}

function emitStdout(text: string): void {
  stdoutBuffer.push(text);
  emitMessage({
    type: 'OUTPUT',
    payload: { stream: 'stdout', text, requestId: currentRequestId },
  });
}

function emitStderr(text: string): void {
  stderrBuffer.push(text);
  emitMessage({
    type: 'OUTPUT',
    payload: { stream: 'stderr', text, requestId: currentRequestId },
  });
}

function postHostCall(method: string, args: unknown[], requestId: string): void {
  self.postMessage({ type: 'HOST_CALL', method, args, requestId });
}

function hostCall<T>(method: string, args: unknown[], timeoutMs: number): Promise<T> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHost.delete(requestId);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pendingHost.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
    postHostCall(method, args, requestId);
  });
}

function pyOptsToJson(opts: unknown): string {
  if (typeof opts === 'string') return opts;
  const o = opts as { toJs?: (x?: unknown) => unknown };
  if (opts && typeof o.toJs === 'function') {
    try {
      return JSON.stringify(o.toJs({ dict_converter: Object.fromEntries }));
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.stringify(opts);
  } catch {
    throw new Error('browser: options must be a dict/str serializable to JSON');
  }
}

const hostAPIBridge = {
  readFile: (path: string) => hostCall<string>('readFile', [path], 15_000),
  readFileBase64: (path: string) => hostCall<string>('readFileBase64', [path], 120_000),
  writeFile: (path: string, content: string) => hostCall<void>('writeFile', [path, content], 15_000),
  writeFileBase64: (path: string, contentBase64: string) =>
    hostCall<void>('writeFileBase64', [path, contentBase64], 120_000),
  listFiles: (path = '.') => hostCall<unknown[]>('listFiles', [path], 15_000),
  statFile: (path: string) => hostCall<string>('statFile', [path], 15_000),
  mkdir: (path: string) => hostCall<void>('mkdir', [path], 15_000),
  getWorkspaceInfo: () => hostCall<string>('workspaceInfo', [], 5_000),
  resolveWorkspacePath: (path: string) => hostCall<string>('workspaceResolvePath', [path], 5_000),
  httpRequest: (options: unknown) =>
    hostCall<string>(
      'httpRequest',
      [typeof options === 'string' ? options : JSON.stringify(options)],
      60_000
    ),
  deleteFile: (path: string, recursive: boolean) =>
    hostCall<void>('deleteFile', [path, recursive], 30_000),
  /** Low-level: JSON string payload (for advanced Python `json.dumps`). */
  browserGetHtml: (optsJson: string) =>
    hostCall<string>('browserGetHtml', [optsJson], 180_000),
  browserScreenshot: (optsJson: string) =>
    hostCall<string>('browserScreenshot', [optsJson], 180_000),
  browserEvaluate: (optsJson: string) =>
    hostCall<string>('browserEvaluate', [optsJson], 180_000),
  /** `await hostAPI.browser.getHtml({"url": "https://..."})` — Pyodide dict → JSON. */
  browser: {
    getHtml: (opts: unknown) =>
      hostCall<string>('browserGetHtml', [pyOptsToJson(opts)], 180_000),
    screenshot: async (opts: unknown) => {
      const raw = await hostCall<string>('browserScreenshot', [pyOptsToJson(opts)], 180_000);
      return JSON.parse(raw) as { path: string; width: number; height: number };
    },
    evaluate: async (opts: unknown) => {
      const raw = await hostCall<string>('browserEvaluate', [pyOptsToJson(opts)], 180_000);
      return JSON.parse(raw) as unknown;
    },
  },
};

(globalThis as unknown as { hostAPI: typeof hostAPIBridge }).hostAPI = hostAPIBridge;

async function preloadMicropipPackages(runtime: PyodideRuntime, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  await runtime.loadPackage(['micropip']);
  const micropip = runtime.pyimport('micropip') as { install: (req: string) => Promise<void> };
  for (const req of names) {
    await micropip.install(req);
  }
}

async function initializePyodide(): Promise<void> {
  try {
    emitMessage({
      type: 'STATUS',
      payload: { state: 'initializing', uptimeMs: Date.now() - startTime },
    });

    const pyodideModule = await import(/* @vite-ignore */ `${PYODIDE_CDN}pyodide.mjs`);
    const loadPyodide =
      pyodideModule.loadPyodide ??
      (pyodideModule as unknown as { default?: { loadPyodide?: typeof pyodideModule.loadPyodide } })
        .default?.loadPyodide ??
      (pyodideModule as unknown as { default: typeof pyodideModule.loadPyodide }).default;
    if (typeof loadPyodide !== 'function') {
      throw new Error('Pyodide: loadPyodide not found (expected named export from pyodide.mjs)');
    }

    const runtime = await loadPyodide({
      indexURL: PYODIDE_CDN,
      stdout: (t: string) => emitStdout(t),
      stderr: (t: string) => emitStderr(t),
    });

    await runtime.runPythonAsync(`
import json
from js import hostAPI

_DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Laika/1.0"
)


async def laika_http_request(url, method="GET", headers=None, body=None):
    """经 Electron 代理的 HTTP（公网 URL）。异步，须 await。返回 dict: status, statusText, headers, body, requestId。"""
    h = {"User-Agent": _DEFAULT_UA}
    if headers:
        h.update(headers)
    opts = {"method": method, "url": url, "headers": h}
    if body is not None:
        opts["body"] = body
    raw = await hostAPI.httpRequest(json.dumps(opts))
    return json.loads(raw)


async def laika_http_get(url, headers=None):
    return await laika_http_request(url, "GET", headers=headers)


async def laika_read_file(path: str) -> str:
    """读工作区内文本文件 UTF-8。path 相对工作区根，如 data/note.txt（勿用绝对路径）。"""
    return await hostAPI.readFile(path)


async def laika_read_file_bytes(path: str) -> bytes:
    """二进制读入（宿主 Base64）；配合 io.BytesIO + 预装第三方库解析。"""
    import base64
    b64 = await hostAPI.readFileBase64(path)
    return base64.b64decode(b64)


async def laika_write_file_bytes(path: str, content: bytes) -> None:
    """二进制写入（需写入权限）；PDF/Office 等均经此序列化落盘。"""
    import base64
    b64 = base64.b64encode(content).decode("ascii")
    await hostAPI.writeFileBase64(path, b64)


async def laika_write_file(path: str, content: str) -> None:
    """写文本 UTF-8。单文件最大约 50MB。"""
    await hostAPI.writeFile(path, content)


async def laika_mkdir(path: str) -> None:
    """创建目录（可递归）。"""
    await hostAPI.mkdir(path)


async def laika_list_files(path: str = "."):
    """列目录；每项含 name, path, isDirectory, size, modified。"""
    items = await hostAPI.listFiles(path)
    return items.to_py() if hasattr(items, "to_py") else list(items)


async def laika_stat_dict(path: str) -> dict:
    """元数据字典：size / is_directory / modified_ms。"""
    raw = await hostAPI.statFile(path)
    return json.loads(raw)


async def laika_workspace_info():
    """返回 { virtualRoot, workspaceRoot, workspaceWriteEnabled }；绝对路径与工作区对齐；写入由应用内授权开关控制。"""
    raw = await hostAPI.getWorkspaceInfo()
    return json.loads(raw)


async def laika_resolve_local_path(virtual_path: str) -> str:
    """虚路径 -> 本机绝对路径（便于在 Finder/资源管理器里找文件）。读写仍请用 laika_read_file 等虚路径。"""
    raw = await hostAPI.resolveWorkspacePath(virtual_path)
    return json.loads(raw)["absolute"]


async def laika_delete_file(path: str, recursive: bool = False) -> None:
    """删除工作区内文件或目录；recursive=True 时递归删除目录。"""
    await hostAPI.deleteFile(path, recursive)
`);

    const bundled = [...PRELOAD_PYODIDE_PACKAGES];
    if (bundled.length > 0) {
      emitStdout(`[Laika] loadPackage: ${bundled.join(', ')}\n`);
      await runtime.loadPackage(bundled);
    }

    const pypiExtra = [...PRELOAD_PYPI_PACKAGES];
    if (pypiExtra.length > 0) {
      emitStdout(`[Laika] micropip: ${pypiExtra.join(', ')}\n`);
      await preloadMicropipPackages(runtime, pypiExtra);
    }

    emitStdout('[Laika] compiling laika_shell.py (bashlex)\\n');
    await runtime.runPythonAsync(
      `exec(compile(${JSON.stringify(laikaShellSource)}, 'laika_shell.py', 'exec'))`
    );

    emitStdout('[Laika] compiling laika_fs.py (posix-like workspace API)\\n');
    await runtime.runPythonAsync(`exec(compile(${JSON.stringify(laikaFsSource)}, 'laika_fs.py', 'exec'))`);

    emitStdout(
      '[Laika] Workspace FS: import laika_fs · await laika_fs.listdir(".") · read_bytes / write_bytes …\n'
    );

    pyodide = runtime;
    isInitialized = true;

    const preloadedCount = bundled.length + pypiExtra.length;

    emitMessage({
      type: 'INITIALIZED',
      payload: {
        pyodideVersion: runtime.version,
        availablePackages: preloadedCount,
      },
    });

    emitMessage({
      type: 'STATUS',
      payload: { state: 'ready', pyodideVersion: runtime.version, uptimeMs: Date.now() - startTime },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to initialize Pyodide';
    emitMessage({
      type: 'ERROR',
      payload: { message, requestId: '' },
    });
    emitMessage({
      type: 'STATUS',
      payload: { state: 'error', uptimeMs: Date.now() - startTime },
    });
  }
}

function buildRunSource(payload: WorkerExecuteCommand['payload']): string {
  const mode = payload.mode ?? 'python';
  if (mode !== 'shell') return payload.code;
  const parts: string[] = [];
  if (payload.resetShellSession) parts.push('await laika_reset_shell_session()');
  if (payload.code.trim()) {
    parts.push(
      `(await laika_run_shell(__import__("json").loads(${JSON.stringify(JSON.stringify(payload.code))})))`
    );
  }
  if (parts.length === 0) parts.push('0');
  return parts.join('\n');
}

async function executePython(payload: WorkerExecuteCommand['payload'], timeoutMs: number): Promise<void> {
  const code = buildRunSource(payload);
  if (!isInitialized || !pyodide) {
    emitMessage({
      type: 'ERROR',
      payload: { message: 'Pyodide not initialized', requestId: currentRequestId },
    });
    return;
  }

  stdoutBuffer.length = 0;
  stderrBuffer.length = 0;
  const startExec = Date.now();

  emitMessage({
    type: 'STATUS',
    payload: { state: 'busy', uptimeMs: Date.now() - startTime },
  });

  try {
    const execPromise = pyodide.runPythonAsync(code);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Execution timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const result = await Promise.race([execPromise, timeoutPromise]);
    const executionTimeMs = Date.now() - startExec;

    let serializedResult: unknown;
    try {
      if (result !== undefined && result !== null) {
        const r = result as { toJs?: (opts?: object) => unknown };
        if (typeof r.toJs === 'function') {
          serializedResult = r.toJs({ dict_converter: Object.fromEntries });
        } else {
          serializedResult = String(result);
        }
      } else {
        serializedResult = null;
      }
    } catch {
      serializedResult = String(result);
    }

    emitMessage({
      type: 'RESULT',
      payload: {
        result: serializedResult,
        stdout: [...stdoutBuffer],
        stderr: [...stderrBuffer],
        executionTimeMs,
        requestId: currentRequestId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Execution error';
    const stack = error instanceof Error ? error.stack : undefined;
    emitMessage({
      type: 'ERROR',
      payload: { message, stack, requestId: currentRequestId },
    });
  } finally {
    emitMessage({
      type: 'STATUS',
      payload: { state: 'ready', uptimeMs: Date.now() - startTime },
    });
  }
}

async function installPackage(packageName: string): Promise<void> {
  if (!isInitialized || !pyodide) {
    emitMessage({
      type: 'ERROR',
      payload: { message: 'Pyodide not initialized', requestId: '' },
    });
    return;
  }

  try {
    await pyodide.loadPackage(['micropip']);
    const micropip = pyodide.pyimport('micropip') as { install: (name: string) => Promise<void> };
    await micropip.install(packageName);
    emitMessage({
      type: 'PACKAGE_INSTALLED',
      payload: { packageName, version: 'latest' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Package install failed';
    emitMessage({
      type: 'ERROR',
      payload: { message, requestId: '' },
    });
  }
}

self.onmessage = async (
  event: MessageEvent<
    WorkerCommand | { type: 'HOST_RESPONSE'; requestId: string; result?: unknown; error?: string }
  >
) => {
  const msg = event.data;

  if (msg.type === 'HOST_RESPONSE') {
    const pending = pendingHost.get(msg.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingHost.delete(msg.requestId);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result);
    }
    return;
  }

  const command = msg as WorkerCommand;

  switch (command.type) {
    case 'INIT':
      await initializePyodide();
      break;

    case 'EXECUTE':
      currentRequestId = command.payload.requestId;
      await executePython(command.payload, command.payload.timeoutMs ?? 30_000);
      break;

    case 'INSTALL_PACKAGE':
      await installPackage(command.payload.packageName);
      break;

    case 'GET_STATUS':
      emitMessage({
        type: 'STATUS',
        payload: {
          state: isInitialized ? 'ready' : 'uninitialized',
          pyodideVersion: pyodide?.version,
          uptimeMs: Date.now() - startTime,
        },
      });
      break;

    case 'TERMINATE':
      pyodide = null;
      isInitialized = false;
      emitMessage({
        type: 'STATUS',
        payload: { state: 'terminated', uptimeMs: Date.now() - startTime },
      });
      self.close();
      break;

    default:
      break;
  }
};

emitMessage({
  type: 'STATUS',
  payload: { state: 'uninitialized', uptimeMs: 0 },
});
