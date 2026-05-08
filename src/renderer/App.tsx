import React from 'react';
import Notebook from './components/Notebook';
import WorkspaceSettings from './components/WorkspaceSettings';

export default function App() {
  return (
    <div className="flex flex-col h-screen text-zinc-100 font-sans antialiased">
      <header className="shrink-0 border-b border-white/[0.06] px-5 py-3 flex items-center justify-between bg-[#12121a]/95 backdrop-blur-md">
        <div>
          <h1 className="text-sm font-semibold tracking-tight text-zinc-100">Laika</h1>
          <p className="text-2xs text-zinc-500 mt-0.5">Python 会话 · Pyodide（WebAssembly）</p>
        </div>
        <span className="text-2xs text-zinc-600 font-mono">notebook</span>
      </header>
      <main className="flex flex-1 min-h-0 min-w-0">
        <Notebook />
        <aside className="w-80 shrink-0 border-l border-white/[0.06] bg-[#101014]/95 flex flex-col min-h-0 overflow-hidden">
          <WorkspaceSettings />
        </aside>
      </main>
    </div>
  );
}
