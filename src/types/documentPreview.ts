export type DocumentPreviewResult =
  | {
      kind: 'xlsx-html';
      sheets: { name: string; html: string }[];
    }
  | { kind: 'pptx-text'; text: string; slideCount: number }
  | { kind: 'error'; message: string };
