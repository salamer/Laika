import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import { registerAllIPCHandlers } from './ipc/registerAll';
import { initWorkspace } from './ipc/workspace';
import { initAuditLog } from './security/audit';
import { attachNetworkGuards } from './network';
import { loadSettings } from './configStore';
import { setWorkspaceRoot } from './workspaceContext';

process.env.DIST_ELECTRON = join(__dirname);
process.env.DIST = join(process.env.DIST_ELECTRON, '../dist');
process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? join(process.env.DIST_ELECTRON, '../public')
  : process.env.DIST;

const preloadPath = join(__dirname, '../preload/index.js');
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

function contentSecurityPolicy(): string {
  const isDev = Boolean(VITE_DEV_SERVER_URL);
  const scriptSrc = isDev
    ? ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'blob:', 'https:', 'http:']
    : ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'blob:', 'https:', 'http:'];

  const connect = ["'self'", 'https:', 'http:', 'ws:', 'wss:'];
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
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
}

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  /** 开发直连 Vite：窗口先显示，避免 ready-to-show 偶尔不触发时一直隐藏。 */
  const isDev = Boolean(VITE_DEV_SERVER_URL);

  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
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
    await mainWindow.loadFile(join(process.env.DIST!, 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

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

  initAuditLog();
  initWorkspace(settings.workspaceRoot);
  attachNetworkGuards(session.defaultSession);
  registerAllIPCHandlers();

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
