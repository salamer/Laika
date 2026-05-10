/**
 * 嵌入式「登录」BrowserWindow：`persist:laika-browser-session` 与 automation 共用，
 * TLS 仅用 Chromium 默认校验；证书失败时不默认展示半截窗口（见 {@link loadLoginUrl}）。
 */
import { BrowserWindow } from 'electron';
import { allowBrowserNavUrl } from './network';
import {
  BROWSER_SESSION_PARTITION,
  EMBEDDED_BROWSER_USER_AGENT,
  refreshBrowserSessionMeta,
} from './browserSession';
import { auditLog, scoped, errorFields } from './logging';

const slog = scoped('browser.login');

let loginWindow: BrowserWindow | null = null;

function assertLoginUrl(url: string): void {
  if (!url?.trim()) throw new Error('URL is required');
  if (!allowBrowserNavUrl(url)) {
    throw new Error(
      'URL not allowed. Use https:// public sites or http(s)://localhost / 127.0.0.1 for local login.'
    );
  }
}

function runAfterLoad(url: string): void {
  void refreshBrowserSessionMeta(url.trim()).catch(() => {
    /* ignore */
  });
}

/** Chromium default TLS only — cert/name/date problems surface here (we never bypass verify). */
function isLikelyCertificateLayerFailure(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return (
    /ERR_CERT/i.test(m) ||
    /ERR_SSL/i.test(m) ||
    /\( *-201 *\)/.test(m) ||
    /net_error -201/.test(m)
  );
}

type LoadOpts = {
  /** First navigation in a newly created window: on failure destroy it (user never sees an “open” broken window). */
  createdNewWindow: boolean;
};

/**
 * Load `url`; TLS uses Chromium built-in verification for this partition (no custom trust / no ignore flags).
 */
function loadLoginUrl(win: BrowserWindow, url: string, opts: LoadOpts): void {
  const u = url.trim();
  slog.debug({ url: u }, 'loadURL beginning');
  void win
    .loadURL(u, { userAgent: EMBEDDED_BROWSER_USER_AGENT })
    .then(() => {
      slog.info({ url: u }, 'loadURL succeeded');
      runAfterLoad(u);
      if (opts.createdNewWindow && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    })
    .catch((err: unknown) => {
      auditLog.error('BROWSER_LOGIN_LOAD_FAILED', {
        url: u,
        ...errorFields(err),
      });
      if (win.isDestroyed()) return;

      if (opts.createdNewWindow) {
        win.destroy();
        loginWindow = null;
        return;
      }

      if (isLikelyCertificateLayerFailure(err)) {
        win.close();
        loginWindow = null;
      }
    });
}

/**
 * Visible window for user sign-in; shares `persist:laika-browser-session` with Python hostAPI.browser.*
 */
export function openBrowserLoginWindow(parent: BrowserWindow | undefined, url: string): void {
  assertLoginUrl(url.trim());
  const u = url.trim();

  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    loadLoginUrl(loginWindow, u, { createdNewWindow: false });
    auditLog.info('BROWSER_LOGIN_REUSE', { url: u });
    return;
  }

  loginWindow = new BrowserWindow({
    parent: parent ?? undefined,
    width: 1100,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'Laika — Sign in',
    backgroundColor: '#0c0c0e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: BROWSER_SESSION_PARTITION,
    },
  });

  loginWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (allowBrowserNavUrl(target)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            partition: BROWSER_SESSION_PARTITION,
          },
        },
      };
    }
    auditLog.warn('BROWSER_LOGIN_POPUP_BLOCKED', { target });
    return { action: 'deny' };
  });

  loadLoginUrl(loginWindow, u, { createdNewWindow: true });

  loginWindow.on('closed', () => {
    loginWindow = null;
    void refreshBrowserSessionMeta();
  });

  auditLog.info('BROWSER_LOGIN_OPEN', { url: u });
}

export function closeBrowserLoginWindow(): void {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
  }
  loginWindow = null;
}

export function disposeBrowserLoginWindow(): void {
  closeBrowserLoginWindow();
}
