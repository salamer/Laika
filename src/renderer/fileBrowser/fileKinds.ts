/** 浏览器内只读预览分类（不涉及写入）。 */

export type FilePreviewKind =
  | 'folder'
  | 'text'
  | 'json'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'docx'
  | 'excel'
  | 'pptx'
  | 'unsupported';

const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
]);

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv']);

const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);

const TEXT_EXT = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'log',
  'env',
  'ini',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonl',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'swift',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'sql',
  'graphql',
  'vue',
  'svelte',
  'properties',
]);

export function classifyFile(fileName: string, isDirectory: boolean): FilePreviewKind {
  if (isDirectory) return 'folder';
  const ix = fileName.lastIndexOf('.');
  const ext = ix >= 0 ? fileName.slice(ix + 1).toLowerCase() : '';

  if (ext === 'json' || ext === 'jsonl') return 'json';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'xlsx' || ext === 'xls') return 'excel';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'unsupported';
}

export function guessMimeForStream(fileName: string): string | undefined {
  const ix = fileName.lastIndexOf('.');
  const ext = ix >= 0 ? fileName.slice(ix + 1).toLowerCase() : '';

  const m: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    avif: 'image/avif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    m4v: 'video/x-m4v',
    ogv: 'video/ogg',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    aac: 'audio/aac',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return m[ext];
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
