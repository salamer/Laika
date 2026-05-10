import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { basename } from 'node:path';
import type { DocumentPreviewResult } from '../types/documentPreview';

const MAX_OFFICE_BYTES = 45 * 1024 * 1024;

function safeName(n: string): string {
  return basename(n);
}

export async function previewOfficeBuffer(
  fileName: string,
  buf: Buffer
): Promise<DocumentPreviewResult> {
  if (buf.length > MAX_OFFICE_BYTES) {
    return {
      kind: 'error',
      message: `文件过大（>${MAX_OFFICE_BYTES} 字节），无法在此预览。`,
    };
  }

  const lower = fileName.toLowerCase();
  try {
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
      const sheets: { name: string; html: string }[] = [];
      const baseId = safeName(fileName || 'book').replace(/[^a-z0-9_-]/gi, '_');
      let i = 0;
      for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        if (!ws) continue;
        i += 1;
        const id = `${baseId}_sh_${i}`;
        /** SheetJS：输出带样式的 HTML 表格，更接近 Excel 展示 */
        const html = XLSX.utils.sheet_to_html(ws, { id, editable: false });
        sheets.push({ name: safeName(name || 'sheet'), html });
      }
      if (sheets.length === 0) {
        return { kind: 'error', message: '无法读取工作簿。' };
      }
      return { kind: 'xlsx-html', sheets };
    }

    if (lower.endsWith('.pptx')) {
      const zip = await JSZip.loadAsync(buf);
      const names = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
        .sort((a, b) => {
          const na = parseInt(/\d+/.exec(a)?.[0] ?? '0', 10);
          const nb = parseInt(/\d+/.exec(b)?.[0] ?? '0', 10);
          return na - nb;
        });

      const parts: string[] = [];
      let si = 0;
      for (const n of names) {
        si += 1;
        const f = zip.file(n);
        if (!f) continue;
        const xml = await f.async('text');
        const chunks: string[] = [];
        const re = /<a:t>([\s\S]*?)<\/a:t>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(xml)) !== null) {
          const t = m[1]?.replace(/\s+/g, ' ').trim();
          if (t) chunks.push(t);
        }
        const body = chunks.join(' ').trim();
        parts.push(`— 幻灯片 ${si} —\n${body || '（无文本）'}`);
      }

      return {
        kind: 'pptx-text',
        text: parts.join('\n\n'),
        slideCount: names.length,
      };
    }

    return { kind: 'error', message: '不支持的 Office 格式（请用预览中的 Word 或其它）' };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { kind: 'error', message: `解析失败：${message}` };
  }
}
