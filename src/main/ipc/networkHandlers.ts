import { ipcMain } from 'electron';
import { auditLog, errorFields } from '../logging';
import { allowProxiedHttpRequest } from '../network';
import { IPC_CHANNELS } from '../../types/ipc';

const MAX_BODY = 5 * 1024 * 1024;
const MAX_RESPONSE = 10 * 1024 * 1024;

export function registerNetworkHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.NETWORK_REQUEST,
    async (
      _event,
      payload: {
        method: string;
        url: string;
        headers?: Record<string, string>;
        body?: string;
        requestId: string;
      }
    ) => {
      try {
        if (!allowProxiedHttpRequest(payload.url)) {
          auditLog.warn('NETWORK_BLOCKED_LOCAL', { url: payload.url, via: 'ipc' });
          return {
            success: false,
            error: 'URL must be public internet (localhost / private networks are blocked).',
            requestId: payload.requestId,
          };
        }

        if (payload.body && Buffer.byteLength(payload.body, 'utf-8') > MAX_BODY) {
          return { success: false, error: 'Request body too large (max 5MB)', requestId: payload.requestId };
        }

        const fetchOptions: RequestInit = {
          method: payload.method,
          headers: { ...payload.headers },
        };
        if (payload.body && payload.method !== 'GET' && payload.method !== 'HEAD') {
          fetchOptions.body = payload.body;
        }

        const response = await fetch(payload.url, fetchOptions);
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });
        const responseBody = await response.text();
        if (Buffer.byteLength(responseBody, 'utf-8') > MAX_RESPONSE) {
          return { success: false, error: 'Response too large (max 10MB)', requestId: payload.requestId };
        }

        return {
          success: true,
          data: {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: responseBody,
            requestId: payload.requestId,
          },
          requestId: payload.requestId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown network error';
        auditLog.error('NETWORK_ERROR', { url: payload.url, message, ...errorFields(error) });
        return { success: false, error: message, requestId: payload.requestId };
      }
    }
  );
}
