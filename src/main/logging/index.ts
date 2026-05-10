/**
 * Laika **main process** unified logging (stderr + `userData/logs/*.ndjson`).
 *
 * - **Levels**: `trace` … `fatal`（与常见结构化日志惯例一致）。
 * - **阈值**：环境变量 `LAIKA_LOG_LEVEL`；开发（存在 `VITE_DEV_SERVER_URL`）默认 `debug`，否则 `info`。
 * - **审计**：`auditLog.*` 带 `audit: true`，**不参与**阈值过滤（安全相关条目始终写入）。
 * - **作用域**：`scoped('ipc')` 等用于把 `scope` 字段打进每条结构化日志。
 *
 * 渲染进程不适用本模块。
 */

import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Legacy audit channel levels（`critical` → 结构化里的 `fatal`） */
export type AuditLevel = 'info' | 'warn' | 'error' | 'critical';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** `unknown` / `catch` → 稳定可序列化字段（勿直接 JSON.stringify(Error)）。 */
export function errorFields(reason: unknown): Record<string, string | undefined> {
  if (reason instanceof Error) {
    return { errMessage: reason.message, errName: reason.name, errStack: reason.stack };
  }
  return { errMessage: String(reason) };
}

function resolveThreshold(): LogLevel {
  const raw = (process.env.LAIKA_LOG_LEVEL || '').toLowerCase() as LogLevel;
  if (raw in LEVEL_ORDER) return raw;
  if (process.env.VITE_DEV_SERVER_URL) return 'debug';
  return 'info';
}

let sessionId = '';
/** NDJSON 文件路径；在 `initMainLogging()` 完成前为空，此时仅控制台输出。 */
let logFilePath = '';
let threshold: LogLevel = resolveThreshold();

const scopeCache = new Map<string, ScopedLogger>();

function shouldEmit(level: LogLevel, audit: boolean): boolean {
  if (audit) return true;
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}

function safeSerialize(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data);
  } catch {
    return JSON.stringify(String(data));
  }
}

/** 写入 NDJSON（若已配置路径）并在 stderr 打一版人类可读行。 */
function writeLine(record: Record<string, unknown>): void {
  const line = `${safeSerialize(record)}\n`;
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, line, 'utf-8');
    } catch {
      console.error('[laika/logging] ndjson append failed');
    }
  }

  const level = String(record.level ?? 'info').toUpperCase();
  const scope = typeof record.scope === 'string' ? ` ${record.scope}` : '';
  const head = typeof record.msg === 'string' ? record.msg : typeof record.event === 'string' ? record.event : '';
  const omit = new Set(['time', 'level', 'msg', 'event', 'scope', 'audit']);
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!omit.has(k)) payload[k] = v;
  }
  const extra = Object.keys(payload).length > 0 ? ` ${safeSerialize(payload)}` : '';
  const text = `[${level}]${scope} ${head}${extra}`.trim();

  switch (record.level) {
    case 'error':
    case 'fatal':
      console.error(text);
      break;
    case 'warn':
      console.warn(text);
      break;
    default:
      console.log(text);
  }
}

export function emit(
  level: LogLevel,
  fields: Record<string, unknown>,
  message?: string
): void {
  const audit = fields.audit === true;
  if (!shouldEmit(level, audit)) return;

  writeLine({
    time: new Date().toISOString(),
    level,
    ...fields,
    ...(message !== undefined ? { msg: message } : {}),
  });
}

/**
 * 在 `app.ready` 之后调用：创建会话日志文件、`scoped()` 缓存会清空。
 */
export function initMainLogging(): void {
  threshold = resolveThreshold();
  scopeCache.clear();
  sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  try {
    const logsDir = join(app.getPath('userData'), 'logs');
    mkdirSync(logsDir, { recursive: true });
    logFilePath = join(logsDir, `laika-${sessionId}.ndjson`);
  } catch {
    logFilePath = '';
  }

  emit(
    'info',
    {
      audit: true,
      event: 'LOGGING_INIT',
      sessionId,
      ...(logFilePath ? { ndjsonPath: logFilePath } : {}),
      threshold,
    },
    'main logging initialized'
  );
}

export interface ScopedLogger {
  trace(fields: Record<string, unknown>, message?: string): void;
  debug(fields: Record<string, unknown>, message?: string): void;
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
  fatal(fields: Record<string, unknown>, message?: string): void;
}

function makeScoped(scope: string): ScopedLogger {
  const b =
    (level: LogLevel) =>
    (fields: Record<string, unknown>, message?: string): void => {
      emit(level, { scope, ...fields }, message);
    };
  return {
    trace: b('trace'),
    debug: b('debug'),
    info: b('info'),
    warn: b('warn'),
    error: b('error'),
    fatal: b('fatal'),
  };
}

/** 带子 logger（按名称缓存）；`initMainLogging` 会清空缓存以对齐新会话根。 */
export function scoped(scope: string): ScopedLogger {
  let s = scopeCache.get(scope);
  if (!s) {
    s = makeScoped(scope);
    scopeCache.set(scope, s);
  }
  return s;
}

/** 直接写一条结构化日志（一般优先用 `scoped` / `auditLog`）。 */
export function logRecord(level: LogLevel, fields: Record<string, unknown>, message?: string): void {
  emit(level, fields, message);
}

/**
 * 与安全/权限相关的审计通道（磁盘 + 控制台，**不按**阈值丢弃 info）。
 * `event` 建议稳定大写 snake_case，便于检索。
 */
export const auditLog = {
  info(event: string, data: Record<string, unknown> = {}): void {
    emit('info', { audit: true, event, ...data }, event);
  },
  warn(event: string, data: Record<string, unknown> = {}): void {
    emit('warn', { audit: true, event, ...data }, event);
  },
  error(event: string, data: Record<string, unknown> = {}): void {
    emit('error', { audit: true, event, ...data }, event);
  },
  critical(event: string, data: Record<string, unknown> = {}): void {
    emit('fatal', { audit: true, event, ...data }, event);
  },
};

/** @deprecated 与 {@link initMainLogging} 相同，仅为旧导入保留别名 */
export const initAuditLog = initMainLogging;
