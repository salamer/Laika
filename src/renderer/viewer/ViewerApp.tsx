import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileInfo } from '../../types/ipc';

function initialRootFromUrl(): string {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get('root')?.trim() || '';
  } catch {
    return '';
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export default function ViewerApp() {
  const [manualPathDraft, setManualPathDraft] = useState('');
  const [cwd, setCwd] = useState<string>(() => initialRootFromUrl());
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [previewName, setPreviewName] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const pathSep = cwd.includes('\\') ? '\\' : '/';

  const breadcrumbDisplay = useMemo(() => {
    if (!cwd) return '';
    return cwd.split(/[/\\]/).filter(Boolean).join(`${pathSep} `);
  }, [cwd, pathSep]);

  const refresh = useCallback(async (absPath: string) => {
    const trimmed = absPath.trim();
    if (!trimmed) {
      setError('请输入绝对路径或通过「选文件夹」打开。');
      setEntries([]);
      setParent(null);
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const res = await window.electronAPI.fileViewer.listAbsolute({ absolutePath: trimmed });
      if (!res.success || !res.data) {
        setError(res.error ?? '列出目录失败');
        setEntries([]);
        setParent(null);
        setCwd('');
        return;
      }

      const d = res.data as {
        cwd: string;
        parent: string | null;
        entries: FileInfo[];
      };
      setCwd(d.cwd);
      setManualPathDraft(d.cwd);
      setParent(d.parent);
      setEntries(Array.isArray(d.entries) ? d.entries : []);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const init = initialRootFromUrl().trim();
    if (init) void refresh(init);
  }, [refresh]);

  useEffect(() => {
    return window.electronAPI.fileViewer.onRootSynced((nextAbs) => {
      setManualPathDraft(nextAbs);
      setPreviewName(null);
      setPreviewText(null);
      setPreviewError(null);
      void refresh(nextAbs);
    });
  }, [refresh]);

  const openDirectory = async (abs: string) => {
    await refresh(abs);
  };

  const openEntry = async (e: FileInfo) => {
    if (e.isDirectory) {
      await refresh(e.path);
      return;
    }
    await previewFile(e.path, e.name);
  };

  const previewFile = async (absPath: string, displayName?: string) => {
    setPreviewBusy(true);
    setPreviewError(null);
    setPreviewText(null);
    setPreviewName(displayName ?? absPath.split(/[/\\]/).pop() ?? absPath);

    try {
      const res = await window.electronAPI.fileViewer.readTextAbsolute({
        absolutePath: absPath,
      });
      if (!res.success || !res.data) {
        setPreviewError(res.error ?? '无法预览');
      } else {
        const td = res.data as { content: string };
        setPreviewText(td.content ?? '');
      }
    } finally {
      setPreviewBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gradient-to-b from-[#101014] to-[#08080d]">
      <header className="shrink-0 border-b border-white/[0.08] px-4 py-2 flex flex-col gap-2 bg-[#101014]/90">
        <div className="text-xs font-semibold text-zinc-200">本地文件浏览器</div>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            className="flex-1 min-w-[240px] input font-mono text-[11px] rounded-xl border-white/12 bg-black/35"
            value={manualPathDraft}
            onChange={(e) => setManualPathDraft(e.target.value)}
            spellCheck={false}
            placeholder="/绝对路径到文件夹/"
          />
          <button
            type="button"
            disabled={busy}
            className="btn-primary px-3 py-1.5 text-2xs rounded-xl"
            onClick={() => void refresh(manualPathDraft)}
          >
            {busy ? '…' : '打开'}
          </button>
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-2xs rounded-xl border-white/15"
            onClick={() => void window.electronAPI.fileViewer.pickFolderAndOpen()}
          >
            选文件夹…
          </button>
        </div>
        {breadcrumbDisplay ? (
          <div className="text-2xs text-zinc-500 font-mono truncate" title={cwd}>
            {cwd}
          </div>
        ) : null}
      </header>

      {error ? (
        <div className="shrink-0 mx-3 mt-2 rounded-lg bg-amber-500/15 text-amber-100 border border-amber-500/30 px-3 py-2 text-2xs">
          {error}
        </div>
      ) : null}

      <div className="flex flex-1 min-h-0 min-w-0">
        <aside className="w-[42%] min-w-[260px] border-r border-white/[0.06] flex flex-col bg-[#0c0d10]/98">
          {parent ? (
            <button
              type="button"
              className="text-left px-3 py-2 text-2xs text-sky-300 border-b border-white/[0.04] hover:bg-white/[0.04]"
              onClick={() => void openDirectory(parent)}
            >
              ⬆ 上级目录
            </button>
          ) : null}
          <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
            {entries.map((e) => (
              <button
                key={e.path}
                type="button"
                onClick={() => void openEntry(e)}
                className="w-full text-left px-3 py-2 text-[11px] font-mono text-zinc-300 hover:bg-violet-500/10 hover:text-zinc-100 flex items-center gap-2"
              >
                <span className="text-violet-300/75 shrink-0">{e.isDirectory ? '📂' : '📄'}</span>
                <span className="truncate flex-1">{e.name}</span>
                {!e.isDirectory ? (
                  <span className="text-2xs text-zinc-600 shrink-0">{formatSize(e.size)}</span>
                ) : null}
              </button>
            ))}
          </div>
        </aside>

        <section className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="shrink-0 border-b border-white/[0.05] px-3 py-1.5 text-2xs text-zinc-500">
            {previewName ? <>预览：`{previewName}`</> : <>选择左侧文本文件预览（≤512KB）</>}
          </div>

          <div className="flex-1 overflow-auto p-3">
            {previewBusy ? (
              <div className="text-xs text-zinc-500 animate-pulse">读取中…</div>
            ) : previewError ? (
              <pre className="text-xs text-amber-200/95 whitespace-pre-wrap">{previewError}</pre>
            ) : previewText != null ? (
              <pre className="text-[11px] font-mono text-zinc-200 whitespace-pre-wrap break-words leading-relaxed bg-black/35 rounded-xl p-3 border border-white/[0.05]">
                {previewText}
              </pre>
            ) : (
              <p className="text-2xs text-zinc-600">
                点击左侧：目录将进入；单个文本文件在此处打开预览。
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
