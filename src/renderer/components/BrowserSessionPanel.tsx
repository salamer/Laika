import React, { useCallback, useEffect, useState } from 'react';

type SessionInfo = {
  partition: string;
  storageRoot: string;
  cookieCount: number;
  lastOpenedLoginUrl?: string;
  updatedAt: number;
};

export default function BrowserSessionPanel({
  className = '',
  hideTopBorder = false,
}: {
  className?: string;
  hideTopBorder?: boolean;
}) {
  const [url, setUrl] = useState('https://');
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshInfo = useCallback(async () => {
    const r = await window.electronAPI.browser.getSessionInfo();
    if (r.success && r.data) setInfo(r.data);
  }, []);

  useEffect(() => {
    void refreshInfo();
  }, [refreshInfo]);

  const openLogin = async () => {
    setBusy(true);
    setHint(null);
    try {
      const r = await window.electronAPI.browser.openLogin({ url: url.trim() });
      if (!r.success) {
        setHint(r.error ?? '无法打开');
        return;
      }
      setHint('已打开登录窗口。登录完成后可关闭窗口；Cookie 会保留并与 Python 自动化共用。');
      await refreshInfo();
    } finally {
      setBusy(false);
    }
  };

  const closeWin = async () => {
    await window.electronAPI.browser.closeLogin();
    setHint('已关闭登录窗口。');
  };

  const clearAll = async () => {
    if (!window.confirm('确定清除嵌入式浏览器的 Cookie 与站点数据？登录状态将丢失。')) return;
    setBusy(true);
    try {
      const r = await window.electronAPI.browser.clearSession();
      if (!r.success) {
        setHint(r.error ?? '清除失败');
        return;
      }
      setHint('已清除会话存储。');
      await refreshInfo();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`flex flex-col gap-2 px-4 py-3 shrink-0 ${hideTopBorder ? '' : 'border-t border-white/[0.06]'} ${className}`}
    >
      <div className="text-2xs font-semibold uppercase tracking-wider text-zinc-500">浏览器会话</div>
      <p className="text-[10px] text-zinc-500 leading-relaxed">
        在此打开网页完成登录；Cookie / LocalStorage 持久化在应用数据中，与侧栏 Python 的{' '}
        <code className="text-violet-300/80">hostAPI.browser.*</code> 共用同一 Chromium 配置（标准 HTTPS
        校验）。
      </p>
      <input
        type="url"
        className="input font-mono text-[11px] rounded-xl border-white/10 bg-[#0d0d11]"
        placeholder="https://…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        spellCheck={false}
      />
      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          disabled={busy}
          className="btn-primary flex-1 min-w-[80px] px-2 py-1.5 text-2xs rounded-xl"
          onClick={() => void openLogin()}
        >
          打开登录页
        </button>
        <button
          type="button"
          disabled={busy}
          className="btn-secondary px-2 py-1.5 text-2xs rounded-xl border-white/10"
          onClick={() => void closeWin()}
        >
          关窗口
        </button>
        <button
          type="button"
          disabled={busy}
          className="btn-secondary px-2 py-1.5 text-2xs rounded-xl border-amber-500/30 text-amber-200/90"
          onClick={() => void clearAll()}
        >
          清除会话
        </button>
      </div>
      {info ? (
        <div className="text-[10px] text-zinc-500 font-mono space-y-0.5 break-all">
          <div>
            Cookie 数：<span className="text-zinc-400">{info.cookieCount}</span>
          </div>
          {info.lastOpenedLoginUrl ? (
            <div title={info.lastOpenedLoginUrl}>
              最近：<span className="text-zinc-400">{info.lastOpenedLoginUrl}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {hint ? (
        <p
          className={`text-[10px] rounded-lg px-2 py-1.5 ${
            hint.startsWith('已')
              ? 'text-emerald-300/90 bg-emerald-500/10 border border-emerald-500/20'
              : 'text-amber-200/90 bg-amber-500/10 border border-amber-500/20'
          }`}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
