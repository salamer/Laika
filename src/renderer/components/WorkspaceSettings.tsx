import React, { useEffect, useState } from 'react';

export default function WorkspaceSettings() {
  const [pathDraft, setPathDraft] = useState('');
  const [effective, setEffective] = useState('');
  const [configFilePath, setConfigFilePath] = useState('');
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    void window.electronAPI.config.get().then((r) => {
      setPathDraft(r.data.workspaceRoot);
      setEffective(r.data.workspaceRoot);
      setConfigFilePath(r.data.configFilePath);
    });
  }, []);

  const pick = async () => {
    const r = await window.electronAPI.config.pickWorkspaceFolder();
    if (r.success && 'path' in r) {
      setPathDraft(r.path);
      setHint(null);
    }
  };

  const save = async () => {
    const r = await window.electronAPI.config.setWorkspaceRoot(pathDraft.trim());
    if (r.success) {
      setEffective(r.data.workspaceRoot);
      setPathDraft(r.data.workspaceRoot);
      setHint('已保存。下方 Python 通过 hostAPI 读写的相对路径均相对于此目录。');
    } else {
      setHint(r.error ?? '保存失败');
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto px-4 py-4 text-[12px] space-y-3 text-zinc-300">
      <div className="flex flex-col gap-1.5">
        <span className="text-2xs font-semibold uppercase tracking-wider text-zinc-500">工作区</span>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-zinc-400 font-medium text-xs">Python 可读写目录</span>
        </div>
        <span
          className="text-zinc-500 font-mono text-[10px] break-all leading-snug"
          title={effective}
        >
          {effective || '—'}
        </span>
      </div>
      <p className="text-zinc-500 text-[11px] leading-relaxed">
        使用 <code className="text-violet-300/90 bg-white/[0.06] px-1 rounded">from js import hostAPI</code>
        ，相对路径如{' '}
        <code className="text-violet-300/90 bg-white/[0.06] px-1 rounded">data/foo.txt</code>
        。配置保存在 <code className="text-violet-300/90 bg-white/[0.06] px-1 rounded">laika-settings.json</code>
        {configFilePath ? (
          <>
            ：<code className="text-zinc-400 break-all">{configFilePath}</code>
          </>
        ) : null}
        。
      </p>
      <div className="flex flex-col gap-2">
        <input
          type="text"
          className="input flex-1 font-mono text-[11px] min-w-0 rounded-xl border-white/10 bg-[#0d0d11]"
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          spellCheck={false}
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary flex-1 px-3 py-2 text-xs rounded-xl border-white/10"
            onClick={() => void pick()}
          >
            浏览…
          </button>
          <button
            type="button"
            className="btn-primary flex-1 px-3 py-2 text-xs rounded-xl"
            onClick={() => void save()}
          >
            保存
          </button>
        </div>
      </div>
      {hint ? (
        <p
          className={`text-[11px] rounded-lg px-2 py-1.5 ${
            hint.startsWith('已保存')
              ? 'text-emerald-300/95 bg-emerald-500/10 border border-emerald-500/20'
              : 'text-amber-200/95 bg-amber-500/10 border border-amber-500/20'
          }`}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
