import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import PdfJsCanvasViewer from './PdfJsCanvasViewer';
import type { FileInfo } from '../../types/ipc';
import type { DocumentPreviewResult } from '../../types/documentPreview';
import { classifyFile, guessMimeForStream, type FilePreviewKind } from '../fileBrowser/fileKinds';
import { FileTreeIcon, FolderTreeIcon, TreeExpandIcon } from '../fileBrowser/treeIcons';

function fileName(abs: string): string {
  const m = abs.split(/[/\\]/).filter(Boolean);
  return m[m.length - 1] ?? abs;
}

function sortEntries(list: FileInfo[]): FileInfo[] {
  return [...list].sort(
    (a, b) =>
      Number(b.isDirectory) - Number(a.isDirectory) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}

export type FileBrowserSelection = { path: string; isDirectory: boolean };

type Selection = FileBrowserSelection;

export function PreviewChrome({
  selection,
  previewFilePath,
}: {
  selection: Selection | null;
  previewFilePath: string | null;
}) {
  const target = previewFilePath ?? selection?.path ?? null;
  const isFolder = previewFilePath ? false : Boolean(selection?.isDirectory);

  const reveal = async () => {
    if (!target) return;
    await window.electronAPI.fileViewer.revealPathInSystem({
      targetPath: target,
      isDirectory: previewFilePath ? false : (selection?.isDirectory ?? false),
    });
  };

  const onCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!target) return;
    void window.electronAPI.fileViewer.popupPathMenu({
      targetPath: target,
      isDirectory: isFolder,
    });
  };

  const copyPath = () => {
    if (!target) return;
    void navigator.clipboard.writeText(target).catch(() => {});
  };

  return (
    <div
      className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 border-b border-white/[0.06] bg-amber-950/25 text-[11px] text-amber-100/95"
      onContextMenu={(e) => {
        if (target) onCtx(e);
      }}
    >
      <span className="flex-1 min-w-[160px] leading-snug">
        <strong className="text-amber-200">只读预览</strong>
        ：不在应用内改写文件。
        {target ? (
          <>
            {' '}
            需要完整排版或编辑时，
            <button
              type="button"
              className="text-sky-300 hover:underline underline-offset-2"
              onClick={() => void reveal()}
            >
              在文件夹中显示
            </button>
            {' · '}
            <button type="button" className="text-zinc-400 hover:underline underline-offset-2" onClick={copyPath}>
              复制路径
            </button>
          </>
        ) : (
          <span className="text-zinc-500"> 请选择树中的条目。</span>
        )}
      </span>
      {previewFilePath ? (
        <span className="text-2xs text-zinc-500 font-mono truncate max-w-[50%]" title={previewFilePath}>
          {previewFilePath}
        </span>
      ) : null}
    </div>
  );
}

export function FilePreviewArea({ absPath }: { absPath: string | null }) {
  const kind: FilePreviewKind | null = useMemo(() => {
    if (!absPath) return null;
    return classifyFile(fileName(absPath), false);
  }, [absPath]);

  const docBodyRef = useRef<HTMLDivElement>(null);
  const docStyleRef = useRef<HTMLDivElement>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [textContent, setTextContent] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [docPreview, setDocPreview] = useState<DocumentPreviewResult | null>(null);
  const [sheetTab, setSheetTab] = useState(0);

  useEffect(() => {
    const b = docBodyRef.current;
    const s = docStyleRef.current;
    if (b) b.innerHTML = '';
    if (s) s.innerHTML = '';
  }, [absPath]);

  useEffect(() => {
    setTextContent(null);
    setMediaUrl(null);
    setPdfBytes(null);
    setDocPreview(null);
    setSheetTab(0);
    setErr(null);
    if (!absPath || !kind || kind === 'folder' || kind === 'unsupported') {
      setBusy(false);
      return;
    }

    let dead = false;

    const run = async () => {
      setBusy(true);
      setErr(null);
      try {
        if (kind === 'docx') {
          const mime =
            guessMimeForStream(fileName(absPath)) ||
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          const tok = await window.electronAPI.fileViewer.registerPreviewUrl({
            absolutePath: absPath,
            mimeType: mime,
          });
          if (dead) return;
          if (!tok.success || !tok.data?.url) {
            setErr(tok.error ?? '无法注册预览');
            return;
          }
          const resp = await fetch(tok.data.url);
          if (!resp.ok) {
            setErr(`读取文档失败 (${resp.status})`);
            return;
          }
          const blob = await resp.blob();
          if (dead) return;
          /** 等一帧让 docx 容器（见下方 render）挂上 ref，避免 busy 时提前 return 导致 ref 未挂载 */
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          const bodyEl = docBodyRef.current;
          const styleEl = docStyleRef.current;
          if (!bodyEl || !styleEl) {
            await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
          }
          const body2 = docBodyRef.current;
          const style2 = docStyleRef.current;
          if (!body2 || !style2) {
            setErr('预览容器不可用（请重试或切换文件）');
            return;
          }
          body2.innerHTML = '';
          style2.innerHTML = '';
          await renderAsync(blob, body2, style2, {
            className: 'laika-docx-docx',
            inWrapper: true,
            breakPages: true,
            ignoreFonts: false,
          });
          return;
        }

        if (kind === 'pdf') {
          const mime = guessMimeForStream(fileName(absPath)) || 'application/pdf';
          const r = await window.electronAPI.fileViewer.registerPreviewUrl({
            absolutePath: absPath,
            mimeType: mime,
          });
          if (dead) return;
          if (!r.success || !r.data?.url) {
            setErr(r.error ?? '无法注册预览链接');
            return;
          }
          const resp = await fetch(r.data.url);
          if (!resp.ok) {
            setErr(`读取 PDF 失败 (${resp.status})`);
            return;
          }
          const buf = await resp.arrayBuffer();
          if (dead) return;
          setPdfBytes(buf);
          return;
        }

        if (kind === 'image' || kind === 'video' || kind === 'audio') {
          const mime =
            guessMimeForStream(fileName(absPath)) || 'application/octet-stream';
          const r = await window.electronAPI.fileViewer.registerPreviewUrl({
            absolutePath: absPath,
            mimeType: mime,
          });
          if (dead) return;
          if (!r.success || !r.data?.url) setErr(r.error ?? '无法注册预览链接');
          else setMediaUrl(r.data.url);
          return;
        }

        if (kind === 'excel' || kind === 'pptx') {
          const r = await window.electronAPI.fileViewer.previewDocument({
            absolutePath: absPath,
          });
          if (dead) return;
          if (!r.success || !r.data?.preview) {
            setErr(r.error ?? '无法解析文档');
            return;
          }
          setDocPreview(r.data.preview);
          return;
        }

        if (kind === 'text' || kind === 'json') {
          const r = await window.electronAPI.fileViewer.readTextAbsolute({
            absolutePath: absPath,
          });
          if (dead) return;
          if (!r.success || r.data?.content === undefined) {
            setErr(r.error ?? '无法读取文本');
            return;
          }
          let txt = r.data.content;
          if (kind === 'json') {
            try {
              txt = JSON.stringify(JSON.parse(txt), null, 2);
            } catch {
              /* 保持原文 */
            }
          }
          setTextContent(txt);
        }
      } catch (e) {
        if (!dead) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!dead) setBusy(false);
      }
    };
    void run();
    return () => {
      dead = true;
    };
  }, [absPath, kind]);

  if (!absPath) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-500 p-8 text-center leading-relaxed max-w-lg mx-auto">
        左侧栏中选文件后即可在此预览。双击文件夹旁箭头展开/折叠。
      </div>
    );
  }

  if (kind === 'unsupported') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-amber-200/90">无法在此预览此类型文件</p>
        <p className="text-2xs text-zinc-500 font-mono break-all max-w-full">{absPath}</p>
        <p className="text-xs text-zinc-500">
          可尝试<strong className="text-zinc-400">右键</strong> → 使用系统默认应用打开。
        </p>
      </div>
    );
  }

  if (kind === 'folder') return null;

  /** DOCX：必须先挂载 ref 容器再 async 渲染，不能把 busy 写在它前面 */
  if (kind === 'docx') {
    return (
      <div className="relative flex flex-1 flex-col min-h-0 overflow-hidden px-4 py-3 gap-3 bg-[#0d0d10]">
        {(busy || err) && (
          <div className="absolute inset-4 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-[#0d0d10]/93 border border-white/[0.08] backdrop-blur-sm">
            {busy ? (
              <span className="text-sm text-zinc-400 animate-pulse">渲染 Word 预览…</span>
            ) : null}
            {err && !busy ? (
              <p className="text-sm text-amber-200/95 px-6 text-center max-w-md">{err}</p>
            ) : null}
          </div>
        )}
        <div ref={docStyleRef} className="shrink-0" />
        <div
          ref={docBodyRef}
          className="laika-docx flex-1 min-h-0 overflow-auto rounded-xl border border-white/[0.08] bg-zinc-100 text-zinc-900 px-4 py-6 shadow-inner [&_table]:border-collapse [&_table]:mx-auto [&_p]:leading-relaxed min-h-[200px]"
        />
      </div>
    );
  }

  /** PDF：PDF.js 画布渲染（避免 Electron 内嵌 Chromium 对 blob 插件呈灰屏） */
  if (kind === 'pdf') {
    return (
      <div className="relative flex flex-1 min-h-0 flex-col bg-zinc-950/95 min-h-[400px]">
        {(busy || err) && (
          <div className="absolute inset-4 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-zinc-950/94 border border-white/[0.08]">
            {busy ? <span className="text-sm text-zinc-400 animate-pulse">加载 PDF…</span> : null}
            {err && !busy ? <p className="text-sm text-amber-200/95 px-6 text-center">{err}</p> : null}
          </div>
        )}
        {!busy && !err && pdfBytes ? <PdfJsCanvasViewer data={pdfBytes} /> : null}
      </div>
    );
  }

  if (busy) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-500 animate-pulse">
        渲染预览…
      </div>
    );
  }

  if (err) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-amber-200/95">{err}</div>
    );
  }

  if (kind === 'image' && mediaUrl) {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center p-6 overflow-auto bg-black/35">
        <img alt="" src={mediaUrl} className="max-w-full max-h-full object-contain shadow-xl rounded-xl" />
      </div>
    );
  }

  if (kind === 'video' && mediaUrl) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center p-6 bg-black/40">
        <video src={mediaUrl} controls className="max-w-full max-h-[min(70vh,760px)] rounded-xl shadow-xl" />
      </div>
    );
  }

  if (kind === 'audio' && mediaUrl) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-12 bg-black/28">
        <p className="text-xs text-zinc-400">{fileName(absPath)}</p>
        <audio src={mediaUrl} controls className="w-full max-w-lg" />
      </div>
    );
  }

  if (kind === 'text' || kind === 'json') {
    return (
      <pre className="flex-1 min-h-0 overflow-auto text-[11px] font-mono text-zinc-200 whitespace-pre-wrap break-words p-6 bg-black/38 rounded-xl border border-white/[0.06] mx-4 my-4">
        {textContent ?? ''}
      </pre>
    );
  }

  if ((kind === 'excel' || kind === 'pptx') && docPreview) {
    if (docPreview.kind === 'error') {
      return (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-amber-200/95">
          {docPreview.message}
        </div>
      );
    }

    if (docPreview.kind === 'pptx-text') {
      return (
        <pre className="flex-1 min-h-0 overflow-auto mx-4 my-4 p-5 text-[12px] font-mono text-zinc-200 whitespace-pre-wrap bg-black/38 rounded-xl border border-white/[0.06]">
          {docPreview.slideCount ? `幻灯片 ${docPreview.slideCount} 张 · 以下为提取文本（非像素级预览）\n\n` : ''}
          {docPreview.text || '（无可提取文本）'}
        </pre>
      );
    }

    if (docPreview.kind === 'xlsx-html') {
      const sheets = docPreview.sheets;
      const ix = Math.min(sheetTab, Math.max(0, sheets.length - 1));
      const sheet = sheets[ix];
      return (
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden px-3 py-3 gap-2">
          <div className="flex flex-wrap gap-1 shrink-0">
            {sheets.map((s, i) => (
              <button
                key={`${s.name}-${i}`}
                type="button"
                className={`px-2.5 py-1 rounded-lg text-2xs font-medium border transition-colors ${
                  i === ix
                    ? 'bg-emerald-600/30 text-emerald-100 border-emerald-400/35'
                    : 'bg-transparent text-zinc-500 border-white/10 hover:text-zinc-300'
                }`}
                onClick={() => setSheetTab(i)}
              >
                {s.name || `工作表 ${i + 1}`}
              </button>
            ))}
          </div>
          <div className="laika-xlsx-html flex-1 min-h-0 overflow-auto rounded-xl border border-white/[0.09] bg-zinc-100 text-zinc-900 p-2 text-[11px] leading-tight [&_table]:border-collapse [&_td]:border [&_td]:border-zinc-300 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-zinc-400 [&_th]:bg-zinc-200 [&_th]:font-semibold [&_th]:px-2 [&_th]:py-1">
            {sheet?.html ? (
              <span dangerouslySetInnerHTML={{ __html: sheet.html }} />
            ) : (
              <span className="text-zinc-500">空表</span>
            )}
          </div>
          <p className="text-2xs text-zinc-600 shrink-0">由 SheetJS 生成 HTML（只读预览）。</p>
        </div>
      );
    }
  }

  return <div className="flex flex-1 items-center justify-center text-zinc-600 text-sm">无法显示预览。</div>;
}

export type FileBrowserPanelProps = {
  /** `full`：树与预览同框；`leftRail`：仅树与工具条（预览由父组件承担）。 */
  layout?: 'full' | 'leftRail';
  /** 递增时重新从磁盘配置拉取工作区路径并与树对齐（例如在「设置」中修改路径）。 */
  configSyncToken?: number;
  onSelectionChange?: (sel: FileBrowserSelection | null) => void;
  /** 在工作区路径已写入主进程配置后触发（刷新横幅等）。 */
  onWorkspaceSynced?: () => void;
};

export default function FileBrowserPanel({
  layout = 'full',
  configSyncToken = 0,
  onSelectionChange,
  onWorkspaceSynced,
}: FileBrowserPanelProps) {
  const onWorkspaceSyncedRef = useRef(onWorkspaceSynced);
  onWorkspaceSyncedRef.current = onWorkspaceSynced;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  const treeRootRef = useRef('');
  const [treeRoot, setTreeRoot] = useState('');
  const [childMap, setChildMap] = useState<Record<string, FileInfo[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    treeRootRef.current = treeRoot;
  }, [treeRoot]);

  const previewPath = selection && !selection.isDirectory ? selection.path : null;

  useEffect(() => {
    onSelectionChangeRef.current?.(selection);
  }, [selection]);

  const loadChildren = useCallback(async (dir: string) => {
    const d = dir.trim();
    if (!d) return;
    setLoadingDirs((prev) => new Set(prev).add(d));
    try {
      const r = await window.electronAPI.fileViewer.listAbsolute({ absolutePath: d });
      if (!r.success || !r.data) {
        return;
      }
      const { entries } = r.data;
      setChildMap((m) => ({ ...m, [d]: sortEntries(entries) }));
    } finally {
      setLoadingDirs((prev) => {
        const n = new Set(prev);
        n.delete(d);
        return n;
      });
    }
  }, []);

  const setRootAndExpand = useCallback(
    async (abs: string, opts?: { skipWorkspacePersist?: boolean }) => {
      const t = abs.trim();
      if (!t) return;
      if (!opts?.skipWorkspacePersist) {
        const r = await window.electronAPI.config.setWorkspaceRoot(t);
        if (!r.success) return;
        onWorkspaceSyncedRef.current?.();
      }
      setTreeRoot(t);
      setChildMap({});
      setExpanded({ [t]: true });
      setSelection(null);
      await loadChildren(t);
    },
    [loadChildren]
  );

  const toggleExpand = useCallback(
    (dirPath: string) => {
      setExpanded((ex) => {
        const next = !ex[dirPath];
        return { ...ex, [dirPath]: next };
      });
      void loadChildren(dirPath);
    },
    [loadChildren]
  );

  const pickRoot = useCallback(async () => {
    const r = await window.electronAPI.fileViewer.pickAbsoluteFolder();
    if (!r.success) return;
    await setRootAndExpand(r.path);
  }, [setRootAndExpand]);

  useEffect(() => {
    let dead = false;
    void (async () => {
      const r = await window.electronAPI.config.get();
      const root = r.data.workspaceRoot?.trim();
      if (!root || dead) return;
      await setRootAndExpand(root, { skipWorkspacePersist: true });
    })();
    return () => {
      dead = true;
    };
    // bootstrap from persisted workspace only on first mount
    // eslint-disable-next-line react-hooks/exhaustive-deps -- avoid re-sync loops
  }, []);

  useEffect(() => {
    if (!configSyncToken) return;
    void (async () => {
      const r = await window.electronAPI.config.get();
      const root = r.data.workspaceRoot?.trim();
      if (!root || root === treeRootRef.current) return;
      await setRootAndExpand(root, { skipWorkspacePersist: true });
    })();
  }, [configSyncToken, setRootAndExpand]);

  const openCtx = useCallback((e: React.MouseEvent, path: string, isDirectory: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    void window.electronAPI.fileViewer.popupPathMenu({ targetPath: path, isDirectory });
  }, []);

  const renderChildren = useCallback(
    (dirPath: string, depth: number): React.ReactNode => {
      if (!expanded[dirPath]) return null;
      const busy = loadingDirs.has(dirPath);
      const list = childMap[dirPath];
      if (busy && !list) {
        return (
          <div className="pl-2 py-2 text-2xs text-zinc-500 font-mono" style={{ paddingLeft: 14 + depth * 14 }}>
            加载中…
          </div>
        );
      }
      if (!list) return null;

      const nodes = list.map((ent) => {
        const indent = 6 + depth * 14;

        if (ent.isDirectory) {
          const isEx = !!expanded[ent.path];
          return (
            <div key={ent.path}>
              <div
                role="treeitem"
                aria-expanded={isEx}
                className={`group flex items-center gap-1 pr-2 py-[3px] rounded-md cursor-default select-none ${
                  selection?.path === ent.path ? 'bg-violet-500/15 ring-1 ring-inset ring-violet-500/20' : 'hover:bg-white/[0.04]'
                }`}
                style={{ paddingLeft: indent }}
                onClick={() =>
                  setSelection({
                    path: ent.path,
                    isDirectory: true,
                  })
                }
                onContextMenu={(ev) => openCtx(ev, ent.path, true)}
              >
                <button
                  type="button"
                  className="p-0.5 rounded shrink-0 text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
                  aria-label={isEx ? '折叠' : '展开'}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    toggleExpand(ent.path);
                  }}
                >
                  <TreeExpandIcon expanded={isEx} />
                </button>
                <FolderTreeIcon expanded={isEx} />
                <span className="text-[11px] font-normal text-zinc-200 truncate min-w-0">{ent.name}</span>
              </div>
              {renderChildren(ent.path, depth + 1)}
            </div>
          );
        }

        return (
          <button
            key={ent.path}
            type="button"
            role="treeitem"
            className={`w-full flex items-center gap-1.5 pr-2 py-[3px] rounded-md text-left hover:bg-white/[0.05] border-0 bg-transparent cursor-default select-none min-w-0 ${
              selection?.path === ent.path ? 'bg-violet-500/15 ring-1 ring-inset ring-violet-500/20' : ''
            }`}
            style={{ paddingLeft: indent }}
            title={ent.path}
            onClick={() =>
              setSelection({
                path: ent.path,
                isDirectory: false,
              })
            }
            onContextMenu={(ev) => openCtx(ev, ent.path, false)}
          >
            <span className="inline-block w-[14px] shrink-0" aria-hidden />
            <span className="shrink-0 flex items-center">
              <FileTreeIcon name={ent.name} />
            </span>
            <span className="text-[11px] font-normal text-zinc-300 truncate min-w-0">{ent.name}</span>
          </button>
        );
      });

      return <div role="group">{nodes}</div>;
    },
    [childMap, expanded, loadingDirs, selection, toggleExpand, openCtx]
  );

  const refreshTreeFixed = useCallback(async () => {
    if (!treeRoot) return;
    const dirs = [treeRoot, ...Object.keys(expanded).filter((k) => k !== treeRoot && expanded[k])];
    const uniq = [...new Set(dirs)];
    setChildMap((m) => {
      const n = { ...m };
      for (const _ of uniq) delete n[_];
      return n;
    });
    uniq.sort((a, b) => a.length - b.length);
    for (const d of uniq) {
      /** eslint-disable-next-line no-await-in-loop */
      await loadChildren(d);
    }
  }, [treeRoot, expanded, loadChildren]);

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-gradient-to-b from-[#101014] to-[#09090d] text-zinc-100">
      <div className="shrink-0 border-b border-white/[0.06] px-3 py-2 flex flex-wrap gap-2 items-center bg-[#12121c]/92">
        <button
          type="button"
          className="btn-primary px-3 py-2 text-xs rounded-xl shrink-0"
          title="将作为当前工作区：Notebook/Python 与工作区宿主 Shell 以此为根目录读写"
          onClick={() => void pickRoot()}
        >
          打开工作区文件夹…
        </button>
        <button
          type="button"
          disabled={!treeRoot}
          className="btn-secondary px-3 py-2 text-xs rounded-xl border-white/10 shrink-0"
          onClick={() => void refreshTreeFixed()}
        >
          刷新
        </button>
        <button
          type="button"
          disabled={!treeRoot}
          className="btn-secondary px-3 py-2 text-xs rounded-xl border-white/10 shrink-0"
          onClick={() => {
            if (!treeRoot) return;
            setExpanded({ [treeRoot]: true });
            setChildMap({});
            void loadChildren(treeRoot);
          }}
        >
          展开根目录
        </button>
        <div className="flex-1 min-w-[200px] text-2xs text-zinc-500 font-mono truncate" title={treeRoot}>
          {treeRoot ? <>工作区：`{treeRoot}`</> : <>尚未打开工作区 — 请选择文件夹与 Python/Shell 对齐</>}
        </div>
      </div>

      <div className="flex flex-1 min-h-0 min-w-0">
        <aside
          className={
            layout === 'leftRail'
              ? 'flex flex-1 min-h-0 min-w-0 w-full flex-col bg-[#0b0c10]'
              : 'w-[min(40%,440px)] min-w-[260px] border-r border-white/[0.06] flex flex-col bg-[#0b0c10]'
          }
        >
          <div className="shrink-0 px-2 py-1.5 text-2xs font-semibold text-zinc-500 uppercase tracking-wider border-b border-white/[0.05]">
            资源管理器（树）
          </div>
          {!treeRoot ? (
            <p className="p-5 text-[11px] text-zinc-500 leading-relaxed">
              选择<strong className="text-zinc-400">工作区文件夹</strong>
              ：应用即获得该路径的<strong className="text-zinc-400">读取</strong>权限；需在右侧横幅中单独开启
              <strong className="text-zinc-400">写入</strong>后方可 `open()` / `writeFile` /
              Notebook Shell 改写文件。右键可在外部打开。
            </p>
          ) : (
            <div role="tree" aria-label="文件树" className="flex-1 overflow-y-auto py-2 scrollbar-thin">
              <div
                role="treeitem"
                aria-expanded={!!expanded[treeRoot]}
                className={`flex w-[calc(100%-8px)] items-center gap-1.5 py-2 px-2 rounded-lg hover:bg-white/[0.03] cursor-default select-none mx-2 ${
                  selection?.path === treeRoot ? 'ring-1 ring-inset ring-violet-400/35 bg-violet-500/12' : ''
                }`}
                onClick={() => setSelection({ path: treeRoot, isDirectory: true })}
                onContextMenu={(ev) => openCtx(ev, treeRoot, true)}
              >
                <button
                  type="button"
                  className="p-0.5 rounded shrink-0 hover:bg-white/10 text-zinc-500"
                  aria-label={expanded[treeRoot] ? '折叠根' : '展开根'}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    toggleExpand(treeRoot);
                  }}
                >
                  <TreeExpandIcon expanded={!!expanded[treeRoot]} />
                </button>
                <FolderTreeIcon expanded={!!expanded[treeRoot]} />
                <span className="text-[12px] text-zinc-200 font-medium truncate">{fileName(treeRoot)}</span>
                <span className="text-2xs text-zinc-600 ml-auto tabular-nums shrink-0">
                  {loadingDirs.has(treeRoot)
                    ? '…'
                    : childMap[treeRoot]
                      ? childMap[treeRoot].length
                      : 0}
                  项
                </span>
              </div>
              {renderChildren(treeRoot, 0)}
            </div>
          )}
        </aside>

        {layout === 'full' ? (
          <section className="flex flex-1 min-w-0 flex-col bg-[#0a0a0f]">
            <PreviewChrome selection={selection} previewFilePath={previewPath} />
            <FilePreviewArea absPath={previewPath} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
