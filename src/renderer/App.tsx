import React, { useCallback, useState } from 'react';
import Notebook from './components/Notebook';
import LlmAssistantPanel from './components/LlmAssistantPanel';
import FileBrowserPanel from './components/FileBrowserPanel';
import WorkspaceRibbon from './components/WorkspaceRibbon';
import SettingsDrawer from './components/SettingsDrawer';
import { PreviewChrome, FilePreviewArea, type FileBrowserSelection } from './components/FileBrowserPanel';

type RightTab = 'notebook' | 'llm' | 'preview';

const rightTabs: { id: RightTab; label: string; hint: string }[] = [
  { id: 'notebook', label: 'Notebook', hint: 'Pyodide Python · 虚拟 Shell（工作区相对路径）' },
  { id: 'llm', label: '模型问答', hint: 'OpenRouter' },
  { id: 'preview', label: '文件预览', hint: '只读预览' },
];

export default function App() {
  const [rightTab, setRightTab] = useState<RightTab>('notebook');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [ribbonKey, setRibbonKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const bumpRibbon = useCallback(() => {
    setRibbonKey((k) => k + 1);
  }, []);

  const onTreeSelectionChange = useCallback((sel: FileBrowserSelection | null) => {
    if (sel && !sel.isDirectory) {
      setPreviewPath(sel.path);
      setRightTab('preview');
      return;
    }
    if (sel?.isDirectory) {
      setPreviewPath(null);
    }
  }, []);

  return (
    <div className="flex flex-col h-screen text-zinc-100 font-sans antialiased bg-[#0c0c0e]">
      <header className="shrink-0 border-b border-white/[0.06] px-4 py-2 flex flex-wrap items-center gap-3 bg-[#12121a]/95 backdrop-blur-md">
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-sm font-semibold tracking-tight text-zinc-100">Laika</span>
          <span className="hidden sm:inline text-2xs text-zinc-600 font-mono">工作区 · Notebook</span>
        </div>
        <span className="text-2xs text-zinc-600 flex-1 text-center sm:text-left min-w-[120px]">
          左侧文件夹 = 代码侧可读工作区 · 右上角设置可改持久路径与浏览器会话
        </span>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className="rounded-xl px-3 py-2 text-2xs font-medium border border-white/10 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-800/70"
            onClick={() => setSettingsOpen(true)}
          >
            设置
          </button>
        </div>
      </header>

      <main className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <div className="w-[min(100%,360px)] shrink-0 min-w-[240px] max-w-[440px] border-r border-white/[0.06] flex flex-col min-h-0">
          <FileBrowserPanel
            layout="leftRail"
            configSyncToken={ribbonKey}
            onWorkspaceSynced={bumpRibbon}
            onSelectionChange={onTreeSelectionChange}
          />
        </div>

        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          <WorkspaceRibbon refreshToken={ribbonKey} />

          <nav className="shrink-0 flex gap-1 p-2 border-b border-white/[0.05] bg-[#101014]/90">
            {rightTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                title={t.hint}
                onClick={() => setRightTab(t.id)}
                className={`min-w-[80px] px-3 py-2 rounded-lg text-2xs sm:text-xs font-medium transition-colors ${
                  rightTab === t.id
                    ? 'bg-violet-600/40 text-violet-100 border border-violet-400/35 shadow-inner'
                    : 'text-zinc-500 hover:text-zinc-200 border border-transparent'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden bg-gradient-to-b from-[#0f0f12] to-[#121218]">
            {rightTab === 'notebook' ? <Notebook /> : null}
            {rightTab === 'llm' ? (
              <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
                <LlmAssistantPanel variant="page" />
              </div>
            ) : null}
            {rightTab === 'preview' ? (
              <div className="flex flex-1 flex-col min-h-0 min-w-0">
                <PreviewChrome
                  selection={previewPath ? { path: previewPath, isDirectory: false } : null}
                  previewFilePath={previewPath}
                />
                <FilePreviewArea absPath={previewPath} />
              </div>
            ) : null}
          </div>
        </div>
      </main>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onConfigChanged={bumpRibbon}
      />
    </div>
  );
}
