/**
 * Pyodide Worker ↔ 渲染进程 host 桥接的**分级日志**（浏览器 DevTools）。
 * 与主进程 `src/main/logging` 风格对齐；阈值见 `VITE_LAIKA_BRIDGE_LOG_LEVEL`。
 */

export type BridgeLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<BridgeLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

function thresholdFromEnv(): BridgeLogLevel {
  const raw = import.meta.env?.VITE_LAIKA_BRIDGE_LOG_LEVEL?.toLowerCase() as BridgeLogLevel | undefined;
  if (raw && raw in LEVEL_ORDER) return raw;
  return import.meta.env?.DEV ? 'debug' : 'info';
}

function shouldEmit(level: BridgeLogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[thresholdFromEnv()];
}

/** 脱敏：只记路径/长度/URL 摘要，不记文件正文或 Base64 内容。 */
export function summarizeHostArgs(method: string, args: unknown[]): Record<string, unknown> {
  switch (method) {
    case 'readFile':
    case 'readFileBase64':
    case 'statFile':
    case 'mkdir':
    case 'deleteFile':
      return { path: args[0], recursive: method === 'deleteFile' ? args[1] : undefined };
    case 'writeFile':
      return { path: args[0], utf8Chars: String(args[1] ?? '').length };
    case 'writeFileBase64':
      return { path: args[0], base64Chars: String(args[1] ?? '').length };
    case 'listFiles':
      return { path: args[0] ?? '.' };
    case 'workspaceInfo':
      return {};
    case 'workspaceResolvePath':
      return { virtualPath: args[0] };
    case 'httpRequest': {
      try {
        const raw = args[0];
        const o = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
        const url = String(o?.url ?? '');
        return {
          httpMethod: String(o?.method ?? 'GET'),
          url: url.length > 256 ? `${url.slice(0, 256)}…` : url,
        };
      } catch {
        return { parseError: true };
      }
    }
    case 'browserGetHtml':
    case 'browserScreenshot':
    case 'browserEvaluate': {
      try {
        const o = JSON.parse(String(args[0] ?? '{}')) as { url?: string };
        const url = String(o?.url ?? '');
        return {
          url: url.length > 200 ? `${url.slice(0, 200)}…` : url,
        };
      } catch {
        return { parseError: true };
      }
    }
    case 'browserOpenLogin': {
      try {
        const o = JSON.parse(String(args[0] ?? '{}')) as { url?: string };
        const url = String(o?.url ?? '');
        return { url: url.length > 200 ? `${url.slice(0, 200)}…` : url };
      } catch {
        return { parseError: true };
      }
    }
    default:
      return { argsCount: args.length };
  }
}

/** Worker 一侧：宿主返回后的可安全摘要（不涉及正文）。 */
export function summarizeHostResult(method: string, result: unknown): Record<string, unknown> {
  switch (method) {
    case 'readFile':
      return typeof result === 'string' ? { utf8Chars: result.length } : { kind: typeof result };
    case 'readFileBase64':
      return typeof result === 'string'
        ? { base64Chars: result.length, approxBytes: Math.floor((result.length * 3) / 4) }
        : { kind: typeof result };
    case 'listFiles':
      return Array.isArray(result) ? { entryCount: result.length } : { kind: typeof result };
    case 'statFile':
      return typeof result === 'string' ? { jsonChars: result.length } : {};
    case 'httpRequest':
      return typeof result === 'string' ? { jsonChars: result.length } : {};
    case 'workspaceInfo':
    case 'workspaceResolvePath':
      return typeof result === 'string' ? { jsonChars: result.length } : {};
    case 'browserGetHtml':
      return typeof result === 'string' ? { htmlChars: result.length } : {};
    case 'browserScreenshot':
    case 'browserEvaluate':
      return typeof result === 'string' ? { payloadChars: result.length } : {};
    default:
      return {};
  }
}

export function createBridgeLogger(component: string) {
  const prefix = `[Laika/${component}]`;

  const emit = (level: BridgeLogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (!shouldEmit(level)) return;
    const extra =
      fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
    const line = `${prefix} [${level.toUpperCase()}] ${msg}${extra}`;
    switch (level) {
      case 'error':
        console.error(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      default:
        console.log(line);
    }
  };

  return {
    trace: (msg: string, fields?: Record<string, unknown>) => emit('trace', msg, fields),
    debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
  };
}
