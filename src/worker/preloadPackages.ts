/**
 * 与 `pyodideWorker.ts` 中的 PYODIDE_VERSION 对齐；仅填入 Pyodide 已构建的包名。
 * 列表见官方文档： https://pyodide.org/en/stable/usage/packages-in-pyodide.html
 *
 * 使用 `pyodide.loadPackage` 从 CDN 拉取预编译 WASM wheel（会解析依赖，如 pandas 会带上 numpy）。
 * 包越多首次启动越慢；可删去不需要的条目。
 */
export const PRELOAD_PYODIDE_PACKAGES: readonly string[] = [
  'numpy',
  'pandas',
  'scikit-learn',
];

/**
 * 不在官方构建里的包可在此用 micropip 安装（需可访问 PyPI / 兼容 Pyodide；纯 Python 包成功率更高）。
 * `beautifulsoup4` 用于解析 HTML（与内核里注入的 `laika_http_get` 配合爬取公网页面）。
 */
export const PRELOAD_PYPI_PACKAGES: readonly string[] = ['beautifulsoup4', 'bashlex'];
