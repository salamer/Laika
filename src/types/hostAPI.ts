/** Contract mirrored by `globalThis.hostAPI` in the Pyodide worker (Python: `from js import hostAPI`). */

export interface HostFileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: number;
}

export interface HostHttpRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HostHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}
