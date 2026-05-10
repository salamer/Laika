/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `trace` | `debug` | `info` | `warn` | `error` — Pyodide worker / host 桥接日志阈值 */
  readonly VITE_LAIKA_BRIDGE_LOG_LEVEL?: string;
}
