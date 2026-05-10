import { app } from 'electron';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

/** Persisted fields in `laika-settings.json`. */
export interface PersistedConfig {
  workspaceRoot: string;
  /** 宿主 file IPC / Python `hostAPI.writeFile` / 浏览器截图落地等写入是否允许（读始终允许）。 */
  workspaceWriteEnabled: boolean;
}

const FILE_NAME = 'laika-settings.json';

/** 默认工作区：用户「文档」下的子目录，避免占满家目录且与 macOS / Windows 习惯一致。 */
export function defaultWorkspacePath(): string {
  return resolve(app.getPath('documents'), 'Laika');
}

export function settingsFilePath(): string {
  return join(app.getPath('userData'), FILE_NAME);
}

function defaults(): PersistedConfig {
  return {
    workspaceRoot: defaultWorkspacePath(),
    workspaceWriteEnabled: false,
  };
}

export function loadSettings(): PersistedConfig {
  const fp = settingsFilePath();
  const base = defaults();
  if (!existsSync(fp)) {
    return base;
  }
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<PersistedConfig>;
    const ws =
      typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.trim().length > 0
        ? resolve(raw.workspaceRoot.trim())
        : base.workspaceRoot;
    const we =
      typeof raw.workspaceWriteEnabled === 'boolean'
        ? raw.workspaceWriteEnabled
        : base.workspaceWriteEnabled;
    return {
      workspaceRoot: ws,
      workspaceWriteEnabled: we,
    };
  } catch {
    return base;
  }
}

export function saveSettings(settings: PersistedConfig): void {
  const root = app.getPath('userData');
  mkdirSync(root, { recursive: true });
  writeFileSync(settingsFilePath(), JSON.stringify(settings, null, 2), 'utf-8');
}

/** Merge into existing file. */
export function updateSettings(patch: Partial<PersistedConfig>): PersistedConfig {
  const cur = loadSettings();
  const next: PersistedConfig = {
    workspaceRoot: patch.workspaceRoot !== undefined ? patch.workspaceRoot : cur.workspaceRoot,
    workspaceWriteEnabled:
      patch.workspaceWriteEnabled !== undefined ? patch.workspaceWriteEnabled : cur.workspaceWriteEnabled,
  };
  saveSettings(next);
  return next;
}

export function isWorkspaceWriteEnabled(): boolean {
  return Boolean(loadSettings().workspaceWriteEnabled);
}
