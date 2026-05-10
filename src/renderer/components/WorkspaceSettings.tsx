import React, { useEffect, useState } from 'react';

export default function WorkspaceSettings({
  className = '',
  onConfigChanged,
}: {
  className?: string;
  onConfigChanged?: () => void;
}) {
  const [pathDraft, setPathDraft] = useState('');
  const [effective, setEffective] = useState('');
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [configFilePath, setConfigFilePath] = useState('');
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    void window.electronAPI.config.get().then((r) => {
      setPathDraft(r.data.workspaceRoot);
      setEffective(r.data.workspaceRoot);
      setWriteEnabled(r.data.workspaceWriteEnabled);
      setConfigFilePath(r.data.configFilePath);
    });
  }, []);

  const reloadFromMain = (): void => {
    void window.electronAPI.config.get().then((r) => {
      setPathDraft(r.data.workspaceRoot);
      setEffective(r.data.workspaceRoot);
      setWriteEnabled(r.data.workspaceWriteEnabled);
    });
  };

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
      setWriteEnabled(r.data.workspaceWriteEnabled);
      setHint(
        '已保存。Notebook 与工作区宿主 Shell 的当前目录将与该路径对齐；写入需单独开启横幅或下方开关。'
      );
      onConfigChanged?.();
    } else {
      setHint(r.error ?? '保存失败');
    }
  };

  const setWriteFlag = async (next: boolean) => {
    const r = await window.electronAPI.config.setWorkspaceWriteEnabled(next);
    if (r.success) {
      setWriteEnabled(r.data.workspaceWriteEnabled);
      onConfigChanged?.();
      setHint(
        next
          ? '已允许对工作区写入（Python / 宿主文件 IPC / 浏览器截图落盘）。'
          : '已切换为仅读写入模式；仍可读取与预览。'
      );
    }
  };

  return (
    <div
      className={`flex flex-col shrink-0 px-4 py-4 text-[12px] space-y-3 text-zinc-300 ${className}`}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-2xs font-semibold uppercase tracking-wider text-zinc-500">工作区</span>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-zinc-400 font-medium text-xs">当前工作目录（宿主 + Pyodide 相对路径根）</span>
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
        。偏好保存在{' '}
        <code className="text-violet-300/90 bg-white/[0.06] px-1 rounded">laika-settings.json</code>
        {configFilePath ? (
          <>
            ：<code className="text-zinc-400 break-all">{configFilePath}</code>
          </>
        ) : null}
        。
      </p>
      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          className="mt-1 rounded border-white/20 bg-zinc-900 text-violet-500 focus:ring-violet-400/40 shrink-0"
          checked={writeEnabled}
          onChange={(e) => void setWriteFlag(e.target.checked)}
        />
        <span className="text-[11px] leading-snug">
          <span className="font-medium text-zinc-200">允许写入工作区</span>
          <span className="block text-zinc-500 mt-0.5">
            关闭时仅可读、列表与预览；与主界面横幅开关相同步（任一处勾选即持久化）。
          </span>
        </span>
      </label>
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
            保存路径
          </button>
          <button
            type="button"
            title="重新从配置文件加载"
            className="btn-secondary px-3 py-2 text-xs rounded-xl border-white/10 shrink-0"
            onClick={() => {
              reloadFromMain();
              setHint(null);
            }}
          >
            重置
          </button>
        </div>
      </div>
      {hint ? (
        <p
          className={`text-[11px] rounded-lg px-2 py-1.5 ${
            hint.includes('保存') ||
            hint.includes('允许') ||
            hint.includes('已切换')
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
