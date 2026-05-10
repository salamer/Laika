/**
 * 与 `pyodideWorker.ts` 中的 PYODIDE_VERSION 对齐；仅填入 Pyodide 已构建的包名。
 * 列表见：https://pyodide.org/en/stable/usage/packages-in-pyodide.html
 */
export const PRELOAD_PYODIDE_PACKAGES: readonly string[] = [
  'numpy',
  'pandas',
  'scikit-learn',
  'lxml',
  'Pillow',
  'xlrd',
  'beautifulsoup4',
];

/**
 * 文档/表格：`io.BytesIO(await laika_fs.read_bytes(...))` + 下列库自行处理。
 */
export const PRELOAD_PYPI_PACKAGES: readonly string[] = [
  'bashlex',
  'pypdf',
  'openpyxl',
  'python-docx',
  'python-pptx',
];
