import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { auditLog } from '../logging';

export function initWorkspace(workspacePath: string): void {
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
    auditLog.info('WORKSPACE_CREATED', { path: workspacePath });
  }

  for (const dir of ['data', 'outputs', 'temp', 'packages']) {
    const fullPath = join(workspacePath, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }
}
