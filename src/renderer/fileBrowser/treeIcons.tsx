import type { LucideIcon } from 'lucide-react';
import {
  Braces,
  ChevronDown,
  ChevronRight,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FolderClosed,
  FolderOpen,
  Music,
  Presentation,
  ScrollText,
  Table2,
  Video,
} from 'lucide-react';
import React from 'react';
import { classifyFile } from './fileKinds';

function Ico(props: {
  Icon: LucideIcon;
  className?: string;
}) {
  return <props.Icon strokeWidth={1.75} size={15} className={`shrink-0 ${props.className ?? 'text-zinc-500'}`} />;
}

export function TreeExpandIcon(props: { expanded: boolean }) {
  return props.expanded ? (
    <ChevronDown size={14} strokeWidth={1.75} className="shrink-0 text-zinc-600" />
  ) : (
    <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 text-zinc-600" />
  );
}

export function FolderTreeIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <FolderOpen strokeWidth={1.75} size={15} className="shrink-0 text-[#dcb67a]" />
  ) : (
    <FolderClosed strokeWidth={1.75} size={15} className="shrink-0 text-[#dcb67a]" />
  );
}

export function FileTreeIcon(props: { name: string }) {
  const kind = classifyFile(props.name, false);
  switch (kind) {
    case 'json':
      return <Ico Icon={Braces} className="text-sky-400/85" />;
    case 'image':
      return <Ico Icon={FileImage} className="text-emerald-400/85" />;
    case 'video':
      return <Ico Icon={Video} />;
    case 'audio':
      return <Ico Icon={Music} />;
    case 'pdf':
      return <Ico Icon={FileType} className="text-red-400/80" />;
    case 'docx':
      return <Ico Icon={ScrollText} className="text-blue-400/85" />;
    case 'excel':
      return <Ico Icon={Table2} className="text-emerald-400/85" />;
    case 'pptx':
      return <Ico Icon={Presentation} className="text-orange-400/85" />;
    case 'text': {
      const n = props.name.toLowerCase();
      if (/\.(?:py|rb|rs|go|java|tsx?|jsx?|mjs|cjs|vue|swift|php|sql)$/.test(n)) {
        return <Ico Icon={FileCode} className="text-violet-400/85" />;
      }
      return <Ico Icon={FileText} className="text-zinc-400" />;
    }
    default: {
      const n = props.name.toLowerCase();
      if (n.endsWith('.zip') || n.endsWith('.tar') || n.endsWith('.gz') || n.endsWith('.rar')) {
        return <Ico Icon={FileArchive} className="text-amber-500/85" />;
      }
      if (/\.(?:xlsx?|csv)$/i.test(n)) {
        return <Ico Icon={FileSpreadsheet} />;
      }
      return <Ico Icon={File} className="text-zinc-500" />;
    }
  }
}
