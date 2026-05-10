/**
 * 向后兼容：`auditLog` / `initAuditLog` 实现已迁至 `logging/index.ts`。
 * 新代码请：`import { auditLog, initMainLogging, scoped, errorFields } from '../logging'`
 */

export type { AuditLevel, LogLevel, ScopedLogger } from '../logging';

export {
  auditLog,
  initMainLogging,
  initAuditLog,
  scoped,
  logRecord,
  errorFields,
  emit,
} from '../logging';
