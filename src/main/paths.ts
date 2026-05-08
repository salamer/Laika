import { join } from 'node:path';

/** Resolved from `dist-electron/main` at runtime — stable in dev and packaged (asar). */
export function getMainBundledDirs(): {
  preload: string;
  rendererDistDir: string;
} {
  const mainDir = __dirname;
  return {
    preload: join(mainDir, '../preload/index.js'),
    rendererDistDir: join(mainDir, '../dist'),
  };
}
