import CodeMirror from '@uiw/react-codemirror';
import { LanguageSupport } from '@codemirror/language';
import { pythonLanguage } from '@codemirror/lang-python';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { useMemo, useRef } from 'react';

export interface PythonCellEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  readOnly?: boolean;
  placeholder?: string;
}

/** ~20px/行，随内容增高，上限避免单格占满屏 */
function editorHeightPx(source: string): number {
  const lines = Math.max(1, source.split('\n').length);
  return Math.min(520, Math.max(132, lines * 20 + 52));
}

export default function PythonCellEditor({
  value,
  onChange,
  onRun,
  readOnly = false,
  placeholder = '输入 Python… Shift+Enter 运行本单元',
}: PythonCellEditorProps) {
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const extensions = useMemo(
    () => [
      new LanguageSupport(pythonLanguage),
      Prec.highest(
        keymap.of([
          {
            key: 'Shift-Enter',
            run: () => {
              onRunRef.current();
              return true;
            },
          },
        ])
      ),
    ],
    []
  );

  const heightPx = editorHeightPx(value);

  return (
    <div className="python-cell-editor w-full min-h-[132px] bg-[#0d0d11]">
      <CodeMirror
        value={value}
        height={`${heightPx}px`}
        theme={vscodeDark}
        extensions={extensions}
        editable={!readOnly}
        placeholder={placeholder}
        onChange={onChange}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          foldGutter: false,
          dropCursor: false,
          allowMultipleSelections: false,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          completionKeymap: false,
        }}
        className="text-[13px] font-mono [&_.cm-editor]:outline-none [&_.cm-scroller]:font-mono"
      />
    </div>
  );
}
