/**
 * Electron main 入口：生命周期、默认 session CSP、IPC、主窗口创建。
 * 日志在 `./logging`，应在 `app.ready` 后立即 `initMainLogging()`。
 */
import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import { registerAllIPCHandlers } from './ipc/registerAll';
import { initWorkspace } from './ipc/workspace';
import { initMainLogging, errorFields, logRecord } from './logging';
import { attachNetworkGuards } from './network';
import { loadSettings } from './configStore';
import { setWorkspaceRoot } from './workspaceContext';
import { getMainBundledDirs } from './paths';
import { disposeBrowserRuntime } from './browserRuntime';
import { registerPreviewPrivilegedSchemes, registerPreviewProtocolHandler } from './previewProtocol';

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const bundled = getMainBundledDirs();
const preloadPath = bundled.preload;

process.on('uncaughtException', (err) => {
  logRecord(
    'fatal',
    { audit: true, event: 'PROCESS_UNCAUGHT_EXCEPTION', ...errorFields(err) },
    'uncaughtException'
  );
});

process.on('unhandledRejection', (reason) => {
  logRecord(
    'error',
    { audit: true, event: 'PROCESS_UNHANDLED_REJECTION', ...errorFields(reason) },
    'unhandledRejection'
  );
});

if (process.platform === 'win32') {
  /** 与 package.json build.appId 一致；影响任务栏跳转列表、通知等。 */
  app.setAppUserModelId('com.laika.desktop');
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

registerPreviewPrivilegedSchemes();

function contentSecurityPolicy(): string {
  const isDev = Boolean(VITE_DEV_SERVER_URL);
  const scriptSrc = isDev
    ? ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'blob:', 'https:', 'http:']
    : ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'blob:', 'https:', 'http:'];

  const connect = ["'self'", 'https:', 'http:', 'ws:', 'wss:', 'laika-preview:'];
  if (VITE_DEV_SERVER_URL) {
    try {
      const dev = new URL(VITE_DEV_SERVER_URL);
      connect.push(`${dev.protocol}//${dev.host}`);
    } catch {
      /* ignore */
    }
  }

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: laika-preview:",
    "font-src 'self' data: https:",
    "media-src 'self' data: blob: https: laika-preview:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob: laika-preview:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
}

let mainWindow: BrowserWindow | null = null;

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow(): Promise<void> {
  /** 开发直连 Vite：窗口先显示，避免 ready-to-show 偶尔不触发时一直隐藏。 */
  const isDev = Boolean(VITE_DEV_SERVER_URL);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 840,
    minHeight: 520,
    title: 'Laika',
    backgroundColor: '#0c0c0e',
    show: isDev,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      disableBlinkFeatures: 'Auxclick',
      enableBlinkFeatures: undefined,
    },
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devOk = Boolean(VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL));
    const fileOk = url.startsWith('file://');
    if (!devOk && !fileOk) event.preventDefault();
  });

  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(join(bundled.rendererDistDir, 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('second-instance', () => {
  focusMainWindow();
});

app.whenReady().then(async () => {
  const settings = loadSettings();
  setWorkspaceRoot(settings.workspaceRoot);

  const csp = contentSecurityPolicy();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  initMainLogging();
  initWorkspace(settings.workspaceRoot);
  attachNetworkGuards(session.defaultSession);
  registerPreviewProtocolHandler();
  registerAllIPCHandlers(() => mainWindow);

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('before-quit', () => {
  disposeBrowserRuntime();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
