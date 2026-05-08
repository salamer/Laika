import { app } from 'electron';
import { join } from 'path';
import { appendFileSync, mkdirSync, existsSync } from 'fs';

/**
 * 审计日志 — 记录所有安全相关操作
 *
 * 记录内容：
 * - 文件读写操作
 * - 网络请求（允许/拒绝）
 * - 权限变更
 * - Python 代码执行
 * - 错误和异常
 */

export type AuditLevel = 'info' | 'warn' | 'error' | 'critical';

export interface AuditEntry {
  level: AuditLevel;
  event: string;
  data: Record<string, unknown>;
  timestamp: number;
  sessionId: string;
}

class AuditLog {
  private logPath: string;
  private sessionId: string;

  constructor() {
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.logPath = '';
  }

  init(): void {
    const userDataPath = app.getPath('userData');
    const logsDir = join(userDataPath, 'logs');
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    this.logPath = join(logsDir, `audit-${this.sessionId}.jsonl`);
    this.info('AUDIT_INIT', { message: 'Audit log initialized' });
  }

  private write(entry: AuditEntry): void {
    const line = JSON.stringify(entry) + '\n';
    // In production, use async writes or a proper logger
    try {
      if (this.logPath) {
        appendFileSync(this.logPath, line, 'utf-8');
      }
      // Also output to console in development
      const prefix = `[${entry.level.toUpperCase()}] [${entry.event}]`;
      if (entry.level === 'error' || entry.level === 'critical') {
        console.error(prefix, entry.data);
      } else if (entry.level === 'warn') {
        console.warn(prefix, entry.data);
      } else {
        console.log(prefix, entry.data);
      }
    } catch {
      console.error('Failed to write audit log');
    }
  }

  info(event: string, data: Record<string, unknown>): void {
    this.write({ level: 'info', event, data, timestamp: Date.now(), sessionId: this.sessionId });
  }

  warn(event: string, data: Record<string, unknown>): void {
    this.write({ level: 'warn', event, data, timestamp: Date.now(), sessionId: this.sessionId });
  }

  error(event: string, data: Record<string, unknown>): void {
    this.write({ level: 'error', event, data, timestamp: Date.now(), sessionId: this.sessionId });
  }

  critical(event: string, data: Record<string, unknown>): void {
    this.write({ level: 'critical', event, data, timestamp: Date.now(), sessionId: this.sessionId });
  }
}

export const auditLog = new AuditLog();

export function initAuditLog(): void {
  auditLog.init();
}