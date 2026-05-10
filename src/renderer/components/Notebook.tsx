import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePyodideWorker } from '../hooks/usePyodideWorker';
import PythonCellEditor from './PythonCellEditor';

type OutChunk =
  | { kind: 'stdout'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'result'; text: string }
  | { kind: 'error'; text: string };

interface Cell {
  id: string;
  source: string;
  outputs: OutChunk[];
  runState: 'idle' | 'running' | 'done' | 'error';
  executionCount: number | null;
  lastDurationMs: number | null;
}

function newId(): string {
  return crypto.randomUUID();
}

function emptyCell(): Cell {
  return {
    id: newId(),
    source: '',
    outputs: [],
    runState: 'idle',
    executionCount: null,
    lastDurationMs: null,
  };
}

type KernelMode = 'python' | 'shell';

export default function Notebook() {
  const [cells, setCells] = useState<Cell[]>(() => [emptyCell()]);
  const [initError, setInitError] = useState<string | null>(null);
  const [kernelMode, setKernelMode] = useState<KernelMode>('python');
  const initRef = useRef(false);
  const cellsRef = useRef(cells);
  const execSeqRef = useRef(0);

  const { status, execute, restart, initialize } = usePyodideWorker();

  useEffect(() => {
    const onAppend = (ev: Event) => {
      const ce = ev as CustomEvent<{ source?: string; kernelMode?: KernelMode }>;
      const source = typeof ce.detail?.source === 'string' ? ce.detail.source : '';
      const mode = ce.detail?.kernelMode;
      if (mode === 'python' || mode === 'shell') {
        setKernelMode(mode);
      }
      const cell = emptyCell();
      cell.source = source;
      setCells((prev) => [...prev, cell]);
    };
    window.addEventListener('laika-notebook-append-cell', onAppend);
    return () => window.removeEventListener('laika-notebook-append-cell', onAppend);
  }, []);

  useEffect(() => {
    cellsRef.current = cells;
  }, [cells]);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    initialize().catch((e) => setInitError(e instanceof Error ? e.message : String(e)));
  }, [initialize]);

  const appendChunk = useCallback((cellId: string, chunk: OutChunk) => {
    setCells((prev) =>
      prev.map((c) => (c.id === cellId ? { ...c, outputs: [...c.outputs, chunk] } : c))
    );
  }, []);

  const runCell = useCallback(
    async (cellId: string) => {
      if (status.state !== 'ready') return;
      const cell = cellsRef.current.find((c) => c.id === cellId);
      if (!cell) return;

      const code = cell.source.trimEnd();
      if (!code) {
        setCells((prev) =>
          prev.map((c) =>
            c.id === cellId
              ? { ...c, outputs: [{ kind: 'stderr', text: '(空单元，无可执行代码)' }], runState: 'done' }
              : c
          )
        );
        return;
      }

      execSeqRef.current += 1;
      const nextCount = execSeqRef.current;

      setCells((prev) =>
        prev.map((c) =>
          c.id === cellId
            ? {
                ...c,
                outputs: [],
                runState: 'running',
                executionCount: nextCount,
                lastDurationMs: null,
              }
            : c
        )
      );

      const onStream = (stream: 'stdout' | 'stderr', text: string) => {
        appendChunk(cellId, { kind: stream, text });
      };

      try {
        const result = await execute(code, {
          onStream,
          timeoutMs: 120_000,
          mode: kernelMode === 'shell' ? 'shell' : 'python',
        });
        setCells((prev) =>
          prev.map((c) => {
            if (c.id !== cellId) return c;
            const out = [...c.outputs];
            if (result.result !== null && result.result !== undefined) {
              const s =
                typeof result.result === 'string'
                  ? result.result
                  : JSON.stringify(result.result, null, 2);
              out.push({
                kind: 'result',
                text: kernelMode === 'shell' ? `退出码 ${s}` : s,
              });
            }
            return {
              ...c,
              outputs: out,
              runState: 'done',
              lastDurationMs: result.executionTimeMs,
            };
          })
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendChunk(cellId, { kind: 'error', text: msg });
        setCells((prev) =>
          prev.map((c) => (c.id === cellId ? { ...c, runState: 'error' } : c))
        );
      }
    },
    [status.state, kernelMode, execute, appendChunk]
  );

  const runAll = useCallback(async () => {
    const snapshot = cellsRef.current;
    for (const c of snapshot) {
      if (c.source.trim()) {
        await runCell(c.id);
      }
    }
  }, [runCell]);

  const addCell = useCallback((afterId?: string) => {
    const cell = emptyCell();
    setCells((prev) => {
      if (!afterId) return [...prev, cell];
      const i = prev.findIndex((c) => c.id === afterId);
      if (i < 0) return [...prev, cell];
      const next = [...prev];
      next.splice(i + 1, 0, cell);
      return next;
    });
  }, []);

  const removeCell = useCallback((id: string) => {
    setCells((prev) => (prev.length <= 1 ? prev : prev.filter((c) => c.id !== id)));
  }, []);

  const updateSource = useCallback((id: string, source: string) => {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, source } : c)));
  }, []);

  const handleRestart = useCallback(async () => {
    setInitError(null);
    try {
      execSeqRef.current = 0;
      await restart();
    } catch (e) {
      setInitError(e instanceof Error ? e.message : String(e));
    }
  }, [restart]);

  const handleResetShellSession = useCallback(async () => {
    await execute('', { mode: 'shell', resetShellSession: true });
  }, [execute]);

  const canRunCell = status.state === 'ready';
  const anyRunning = cells.some((c) => c.runState === 'running');

  const kernelLabel =
    kernelMode === 'shell'
      ? 'Shell（bashlex + Pyodide）'
      : status.state === 'ready'
        ? '内核就绪'
        : status.state === 'initializing'
          ? '正在加载 Pyodide…'
          : status.state === 'busy'
            ? '运行中…'
            : status.state === 'error'
              ? '内核错误'
              : status.state === 'terminated'
                ? '已停止'
                : status.state === 'uninitialized'
                  ? '未启动'
                  : status.state;

  const statusClass = anyRunning
    ? 'bg-amber-400 animate-pulse'
    : canRunCell
      ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
      : 'bg-zinc-500';

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-gradient-to-b from-[#0f0f12] to-[#121218]">
      <div className="shrink-0 px-5 py-3 border-b border-white/[0.06] flex flex-wrap items-center gap-3 bg-[#12121a]/90 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${statusClass}`} />
          <span className="text-xs font-medium text-zinc-300">{kernelLabel}</span>
          {status.pyodideVersion ? (
            <span className="text-2xs text-zinc-600 font-mono">{status.pyodideVersion}</span>
          ) : null}
        </div>
        <div className="flex rounded-lg border border-white/[0.08] p-0.5 bg-[#0d0d11]/80">
          <button
            type="button"
            className={`rounded-md px-2.5 py-1 text-2xs font-medium transition-colors ${
              kernelMode === 'python'
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
            onClick={() => setKernelMode('python')}
          >
            Python
          </button>
          <button
            type="button"
            className={`rounded-md px-2.5 py-1 text-2xs font-medium transition-colors ${
              kernelMode === 'shell'
                ? 'bg-sky-700/80 text-sky-100'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
            onClick={() => setKernelMode('shell')}
          >
            Shell
          </button>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          disabled={kernelMode !== 'shell' || !canRunCell}
          className="rounded-lg px-3 py-1.5 text-xs font-medium bg-sky-600/15 text-sky-200 border border-sky-500/25 hover:bg-sky-600/25 disabled:opacity-25 disabled:pointer-events-none transition-colors"
          title="清除 Shell 会话中的 cd / export 等状态"
          onClick={() => void handleResetShellSession()}
        >
          重置 Shell 会话
        </button>
        <button
          type="button"
          disabled={!canRunCell}
          className="rounded-lg px-3 py-1.5 text-xs font-medium bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-600/30 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          onClick={() => addCell()}
        >
          + 代码单元
        </button>
        <button
          type="button"
          disabled={!canRunCell}
          className="rounded-lg px-3 py-1.5 text-xs font-medium bg-violet-600/20 text-violet-200 border border-violet-500/25 hover:bg-violet-600/30 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          onClick={() => void runAll()}
        >
          全部运行
        </button>
        <button
          type="button"
          disabled={status.state === 'initializing'}
          className="rounded-lg px-3 py-1.5 text-xs font-medium bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700/80 disabled:opacity-40 transition-colors"
          onClick={() => void handleRestart()}
        >
          重启内核
        </button>
      </div>

      {initError ? (
        <div className="mx-5 mt-3 rounded-lg border border-red-500/30 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          初始化失败：{initError}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {cells.map((cell, idx) => (
          <article
            key={cell.id}
            className="group rounded-2xl border border-white/[0.08] bg-[#15151c]/90 shadow-lg shadow-black/20 overflow-hidden ring-1 ring-white/[0.02]"
          >
            <div className="flex items-center gap-2 px-3 py-2 bg-[#1a1a24] border-b border-white/[0.05]">
              <button
                type="button"
                disabled={!canRunCell || cell.runState === 'running'}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-35 transition-colors"
                title="运行此单元 (Shift+Enter)"
                onClick={() => void runCell(cell.id)}
              >
                <span className="text-xs" aria-hidden>
                  ▶
                </span>
              </button>
              <span className="text-2xs font-mono text-zinc-500">
                [{idx + 1}]
                {cell.executionCount != null ? (
                  <span className="text-zinc-400"> · In [{cell.executionCount}]</span>
                ) : null}
                {cell.lastDurationMs != null ? (
                  <span className="text-zinc-600"> · {cell.lastDurationMs}ms</span>
                ) : null}
              </span>
              {cell.runState === 'running' ? (
                <span className="text-2xs text-amber-400/90 animate-pulse">执行中…</span>
              ) : null}
              <div className="flex-1" />
              <button
                type="button"
                className="text-2xs text-zinc-500 hover:text-zinc-300 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => addCell(cell.id)}
              >
                下方插入
              </button>
              <button
                type="button"
                disabled={cells.length <= 1}
                className="text-2xs text-zinc-500 hover:text-red-400/90 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-20"
                onClick={() => removeCell(cell.id)}
              >
                删除
              </button>
            </div>
            <PythonCellEditor
              value={cell.source}
              onChange={(v) => updateSource(cell.id, v)}
              onRun={() => void runCell(cell.id)}
              readOnly={!canRunCell || cell.runState === 'running'}
              placeholder={
                kernelMode === 'shell'
                  ? '输入 Shell/Bash…（bashlex [idank/bashlex] 解析，见 help）。Shift+Enter 运行'
                  : '输入 Python… Shift+Enter 运行本单元'
              }
            />
            {cell.outputs.length > 0 ? (
              <div className="border-t border-white/[0.06] bg-[#0a0a0d] px-4 py-3 space-y-1.5">
                <div className="text-2xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                  输出
                </div>
                {cell.outputs.map((o, i) => (
                  <pre
                    key={i}
                    className={`font-mono text-[12px] whitespace-pre-wrap break-words rounded-md px-2 py-1.5 border-l-2 ${
                      o.kind === 'stderr' || o.kind === 'error'
                        ? 'border-red-400/70 bg-red-950/25 text-red-200/95'
                        : o.kind === 'result'
                          ? 'border-violet-400/50 bg-violet-950/20 text-violet-100/90'
                          : 'border-emerald-500/40 bg-emerald-950/10 text-zinc-200'
                    }`}
                  >
                    {o.text}
                  </pre>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
