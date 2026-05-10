import React, { useCallback, useEffect, useRef, useState } from 'react';

type KernelMode = 'python' | 'shell';

function extractFenced(text: string, lang: string): string | null {
  const esc = lang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('```' + esc + '\\s*\\n([\\s\\S]*?)```', 'i');
  const m = text.match(re);
  const body = m?.[1]?.trim();
  return body && body.length > 0 ? body : null;
}

function dispatchAppendCell(source: string, kernelMode: KernelMode): void {
  window.dispatchEvent(
    new CustomEvent('laika-notebook-append-cell', { detail: { source, kernelMode } })
  );
}

export default function LlmAssistantPanel({ variant = 'compact' }: { variant?: 'compact' | 'page' }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    const r = await window.electronAPI.llm.status();
    if (r.success && r.data) {
      setConfigured(r.data.configured);
      setEndpoint(r.data.endpoint);
      setModel(r.data.model);
    } else {
      setConfigured(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = async () => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    setError(null);
    setInput('');
    const nextMsgs = [...messages, { role: 'user' as const, content: trimmed }];
    setMessages(nextMsgs);
    setBusy(true);
    try {
      const r = await window.electronAPI.llm.chat({
        messages: nextMsgs.map((m) => ({ role: m.role, content: m.content })),
      });
      if (!r.success || !r.data) {
        setError(r.error ?? '请求失败');
        return;
      }
      setMessages((prev) => [...prev, { role: 'assistant', content: r.data!.content }]);
    } finally {
      setBusy(false);
    }
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  const appendPythonFromLast = () => {
    if (!lastAssistant) return;
    const code = extractFenced(lastAssistant.content, 'python');
    dispatchAppendCell(code ?? lastAssistant.content, 'python');
  };

  const appendShellFromLast = () => {
    if (!lastAssistant) return;
    const code =
      extractFenced(lastAssistant.content, 'bash') ??
      extractFenced(lastAssistant.content, 'shell') ??
      extractFenced(lastAssistant.content, 'sh');
    dispatchAppendCell(code ?? lastAssistant.content, 'shell');
  };

  const runHostShellFromLast = async () => {
    if (!lastAssistant) return;
    const script =
      extractFenced(lastAssistant.content, 'bash') ??
      extractFenced(lastAssistant.content, 'shell') ??
      extractFenced(lastAssistant.content, 'sh');
    const toRun = (script ?? lastAssistant.content).trim();
    if (!toRun) return;
    const ok = window.confirm(
      '将在宿主环境执行 Shell（cwd 为工作区根目录）。仅限你信任的来源。\n\n' +
        toRun.slice(0, 2000) +
        (toRun.length > 2000 ? '\n…（已截断）' : '')
    );
    if (!ok) return;
    const r = await window.electronAPI.shell.execApproved({ script: toRun, timeoutMs: 120_000 });
    const summary =
      r.success && r.data
        ? `[宿主 Shell] exit=${r.data.code}\n--- stdout ---\n${r.data.stdout}\n--- stderr ---\n${r.data.stderr}`
        : `[宿主 Shell 错误] ${r.error ?? 'unknown'}`;
    setMessages((prev) => [...prev, { role: 'assistant', content: summary }]);
  };

  const rootCls =
    variant === 'page'
      ? 'flex flex-col flex-1 min-h-0 min-w-0 max-w-[960px] w-full mx-auto px-8 py-6'
      : 'shrink-0 border-t border-white/[0.06] flex flex-col min-h-[280px] max-h-[420px] px-4 pt-4 pb-3';

  return (
    <div className={rootCls}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-2xs font-semibold uppercase tracking-wider text-zinc-500">
          模型助手（OpenRouter）
        </span>
        {configured === null ? (
          <span className="text-2xs text-zinc-600">…</span>
        ) : configured ? (
          <span className="text-2xs text-emerald-400/90">已配置密钥</span>
        ) : (
          <span className="text-2xs text-amber-400/90" title="主进程环境变量 OPENROUTER_API_KEY">
            未检测到密钥
          </span>
        )}
      </div>
      <p className="text-[10px] text-zinc-600 font-mono break-all mb-2 leading-snug">
        {model ? `${model}` : '—'}
        {endpoint ? ` · ${endpoint}` : ''}
      </p>

      <div
        ref={scrollRef}
        className={
          variant === 'page'
            ? 'flex-1 min-h-0 overflow-y-auto rounded-xl border border-white/[0.06] bg-black/25 px-3 py-3 space-y-2 mb-3'
            : 'flex-1 min-h-[120px] overflow-y-auto rounded-xl border border-white/[0.06] bg-black/25 px-2 py-2 space-y-2 mb-2'
        }
      >
        {messages.length === 0 ? (
          <p className="text-[11px] text-zinc-600 px-1">
            通过环境变量配置 <code className="text-violet-300/80">OPENROUTER_API_KEY</code>、
            <code className="text-violet-300/80">OPENROUTER_BASE_URL</code>、
            <code className="text-violet-300/80">OPENROUTER_MODEL</code>
            （如 deepseek/deepseek-chat）。回复中的代码块可插入笔记本或经确认后在宿主执行。
          </p>
        ) : null}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`rounded-lg px-2 py-1.5 text-[11px] whitespace-pre-wrap break-words ${
              m.role === 'user'
                ? 'bg-violet-950/35 text-zinc-200 border border-violet-500/20'
                : 'bg-zinc-900/50 text-zinc-300 border border-white/[0.05]'
            }`}
          >
            <span className="text-2xs font-semibold text-zinc-500 block mb-0.5">
              {m.role === 'user' ? '你' : '助手'}
            </span>
            {m.content}
          </div>
        ))}
        {busy ? <div className="text-2xs text-zinc-500 px-1 animate-pulse">正在请求…</div> : null}
      </div>

      {error ? (
        <div className="text-[11px] text-amber-300/90 mb-2 px-1">{error}</div>
      ) : null}

      <textarea
        className={
          variant === 'page'
            ? 'input w-full min-h-[88px] max-h-[220px] resize-y font-mono text-[12px] rounded-xl border-white/10 bg-[#0d0d11] mb-3'
            : 'input w-full min-h-[64px] max-h-[120px] resize-y font-mono text-[11px] rounded-xl border-white/10 bg-[#0d0d11] mb-2'
        }
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="向模型提问…（Enter 发送，Shift+Enter 换行）"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy || !input.trim()}
          className="btn-primary px-2.5 py-1.5 text-2xs rounded-lg disabled:opacity-40"
          onClick={() => void send()}
        >
          发送
        </button>
        <button
          type="button"
          disabled={!lastAssistant}
          className="btn-secondary px-2.5 py-1.5 text-2xs rounded-lg border-white/10 disabled:opacity-30"
          onClick={appendPythonFromLast}
          title="将最后一条助手回复中的 ```python 代码块（或全文）追加为 Python 单元"
        >
          插入 Python 单元
        </button>
        <button
          type="button"
          disabled={!lastAssistant}
          className="btn-secondary px-2.5 py-1.5 text-2xs rounded-lg border-white/10 disabled:opacity-30"
          onClick={appendShellFromLast}
          title="将 bash/shell 代码块或全文追加为 Shell 单元（Pyodide）"
        >
          插入 Shell 单元
        </button>
        <button
          type="button"
          disabled={!lastAssistant}
          className="btn-secondary px-2.5 py-1.5 text-2xs rounded-lg border-amber-500/25 text-amber-200/90 disabled:opacity-30"
          onClick={() => void runHostShellFromLast()}
          title="需确认：在宿主真正执行 bash（cwd=工作区）"
        >
          宿主执行 Shell…
        </button>
      </div>
    </div>
  );
}
