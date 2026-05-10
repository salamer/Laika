import React from 'react';
import WorkspaceSettings from './WorkspaceSettings';
import BrowserSessionPanel from './BrowserSessionPanel';

type Props = {
  open: boolean;
  onClose: () => void;
  /** 工作区路径或写入标志等持久配置变更后主界面刷新横幅/树。 */
  onConfigChanged?: () => void;
};

export default function SettingsDrawer({ open, onClose, onConfigChanged }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px] border-0 cursor-default"
        aria-label="关闭设置"
        onClick={onClose}
      />
      <div className="relative h-full w-full max-w-md flex flex-col bg-[#0e0e14] border-l border-white/[0.08] shadow-2xl shadow-black/60 overflow-hidden">
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <span className="text-xs font-semibold text-zinc-200">应用设置</span>
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-2xs text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06]"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <WorkspaceSettings className="border-b border-white/[0.05]" onConfigChanged={onConfigChanged} />
          <BrowserSessionPanel hideTopBorder className="border-b-0" />
        </div>
      </div>
    </div>
  );
}
