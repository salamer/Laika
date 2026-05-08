import { app } from 'electron';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

/** Shape read/written in `laika-settings.json` (only workspace root is persisted). */
export interface PersistedConfig {
  workspaceRoot: string;
}

const FILE_NAME = 'laika-settings.json';

export function defaultWorkspacePath(): string {
  return resolve(app.getPath('home'), 'AppWorkspace');
}

export function settingsFilePath(): string {
  return join(app.getPath('userData'), FILE_NAME);
}

export function loadSettings(): PersistedConfig {
  const fp = settingsFilePath();
  if (!existsSync(fp)) {
    return { workspaceRoot: defaultWorkspacePath() };
  }
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<PersistedConfig>;
    if (typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.trim().length > 0) {
      return { workspaceRoot: resolve(raw.workspaceRoot.trim()) };
    }
  } catch {
    /* use default */
  }
  return { workspaceRoot: defaultWorkspacePath() };
}

export function saveSettings(settings: PersistedConfig): void {
  const root = app.getPath('userData');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    settingsFilePath(),
    JSON.stringify({ workspaceRoot: settings.workspaceRoot }, null, 2),
    'utf-8'
  );
}
