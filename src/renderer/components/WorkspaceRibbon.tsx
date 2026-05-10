import React, { useEffect, useState } from 'react';

type Props = {
  /** 主进程配置更新后递增，以重新拉取工作区与写入标志。 */
  refreshToken?: number;
};

export default function WorkspaceRibbon({ refreshToken = 0 }: Props) {
  const [root, setRoot] = useState('');
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.electronAPI.config.get().then((r) => {
      setRoot(r.data.workspaceRoot);
      setWriteEnabled(r.data.workspaceWriteEnabled);
    });
  }, [refreshToken]);

  const onToggle = async (next: boolean) => {
    setBusy(true);
    try {
      const r = await window.electronAPI.config.setWorkspaceWriteEnabled(next);
      if (r.success) setWriteEnabled(r.data.workspaceWriteEnabled);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 border-b border-white/[0.06] bg-[#13131a]/95 text-[12px] leading-snug text-zinc-200">
      <div className="flex flex-col gap-1 min-w-[220px] flex-1">
        <span className="text-2xs font-semibold uppercase tracking-wider text-zinc-500">工作区 · 权限</span>
        <p className="text-emerald-300/90 font-medium">已授予文件夹读取</p>
        <p className="text-2xs text-zinc-500">
          左侧打开文件夹后，Notebook 中 Python / Shell 与工作区路径一致；相对路径均相对此目录。
        </p>
        {root ? (
          <p className="text-[11px] text-zinc-400 font-mono break-all" title={root}>
            {root}
          </p>
        ) : (
          <p className="text-2xs text-amber-200/80">请先在左侧栏选择工作区文件夹。</p>
        )}
      </div>
      <label className="flex items-center gap-2.5 cursor-pointer select-none shrink-0 pt-5 sm:pt-0">
        <input
          type="checkbox"
          className="rounded border-white/20 bg-zinc-900 text-violet-500 focus:ring-violet-400/40"
          checked={writeEnabled}
          disabled={busy || !root}
          onChange={(e) => void onToggle(e.target.checked)}
        />
        <span className="text-[12px] text-zinc-300">
          <span className="font-medium text-zinc-100">允许写入此工作区</span>
          <span className="block text-2xs text-zinc-500 mt-0.5 max-w-[280px]">
            开启后 Python <code className="text-violet-300/90">writeFile</code>、创建目录、浏览器截图落盘等才可写；关闭后仅读与列表。
          </span>
        </span>
      </label>
    </div>
  );
}
