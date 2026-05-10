import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../types/ipc';
import { auditLog, errorFields } from '../logging';
import {
  llmConfiguredFromEnv,
  openRouterApiKey,
  openRouterAppTitle,
  openRouterEndpoint,
  openRouterHttpReferer,
  openRouterModel,
} from '../llm/env';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface LlmChatMessage {
  role: ChatRole;
  content: string;
}

/** 会话级系统提示前缀（可被用户消息替代）。 */
export const DEFAULT_LA_SYSTEM = `你在 Laika 桌面应用中协助用户编写与运行代码。
用户使用 Pyodide 笔记本执行 Python / 简化 Shell。
回答使用 Markdown；需要可执行的代码时用带语言标注的 fenced 代码块：
- \`\`\`python ... \`\`\` 建议在笔记本中运行的 Python；
- \`\`\`bash ... \`\`\` 表示 Shell；真实宿主执行需用户另行确认；
保持简洁；涉及危险命令时请提醒用户在受控环境中操作。`;

const MAX_MESSAGES = 30;
const MAX_CONTENT_CHARS_PER_MSG = 32_000;
const DEFAULT_MAX_TOKENS = Number(process.env.OPENROUTER_MAX_TOKENS) || 4096;

interface OpenRouterChatResponse {
  choices?: { message?: { role?: string; content?: string } }[];
  error?: { message?: string };
}

/**
 * OpenRouter-compatible chat（DeepSeek）；Bearer 仅从主进程进程环境读取。
 */
export function registerLlmHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.LLM_CHAT,
    async (
      _evt,
      payload: {
        messages: LlmChatMessage[];
        systemPrompt?: string;
        temperature?: number;
        maxTokens?: number;
        requestId: string;
      }
    ): Promise<{
      success: boolean;
      data?: { content: string; model: string; rawStatus: number };
      error?: string;
      requestId: string;
    }> => {
      const requestId = payload.requestId;
      const apiKey = openRouterApiKey();
      if (!apiKey) {
        auditLog.warn('LLM_SKIPPED_NO_KEY');
        return {
          success: false,
          error:
            '未配置 OPENROUTER_API_KEY（主进程环境变量）。启动前需在 shell/profile 导出后再运行 Electron。',
          requestId,
        };
      }

      const url = openRouterEndpoint();
      const model = openRouterModel();
      const trimmed = [...payload.messages]
        .filter((m) => m && typeof m.content === 'string')
        .slice(-MAX_MESSAGES)
        .map((m) => ({
          role: m.role,
          content: m.content.slice(0, MAX_CONTENT_CHARS_PER_MSG),
        }));

      if (trimmed.length === 0) {
        return { success: false, error: 'No messages provided', requestId };
      }

      const systemText = payload.systemPrompt?.trim() || DEFAULT_LA_SYSTEM;
      const bodyMessages: LlmChatMessage[] = [{ role: 'system', content: systemText }, ...trimmed];

      const temperature =
        typeof payload.temperature === 'number' &&
        payload.temperature >= 0 &&
        payload.temperature <= 2
          ? payload.temperature
          : 0.25;

      const maxTokens =
        typeof payload.maxTokens === 'number' &&
        payload.maxTokens >= 64 &&
        payload.maxTokens <= 32_768
          ? payload.maxTokens
          : DEFAULT_MAX_TOKENS;

      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };

      const ref = openRouterHttpReferer();
      if (ref) headers['Referer'] = ref;

      const title = openRouterAppTitle();
      if (title) headers['X-Title'] = title;

      auditLog.info('LLM_CHAT_REQUEST', {
        model,
        endpoint: url,
        messageCount: bodyMessages.length,
        temperature,
        maxTokens,
      });

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: bodyMessages,
            temperature,
            max_tokens: maxTokens,
          }),
        });

        const rawText = await resp.text();
        let parsed: OpenRouterChatResponse | null = null;
        try {
          parsed = JSON.parse(rawText) as OpenRouterChatResponse;
        } catch {
          parsed = null;
        }

        if (!resp.ok) {
          const errMsg =
            parsed?.error?.message || rawText.slice(0, 500) || `HTTP ${resp.status}`;
          auditLog.error('LLM_CHAT_HTTP_ERROR', { status: resp.status, snippet: errMsg.slice(0, 200) });
          return {
            success: false,
            error: `${resp.status}: ${errMsg}`,
            requestId,
          };
        }

        const content = parsed?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          auditLog.error('LLM_CHAT_BAD_SHAPE', {
            snippet: rawText.slice(0, 300),
          });
          return {
            success: false,
            error: 'Invalid response shape from OpenRouter',
            requestId,
          };
        }

        auditLog.info('LLM_CHAT_OK', {
          model,
          chars: content.length,
        });

        return {
          success: true,
          data: { content, model, rawStatus: resp.status },
          requestId,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        auditLog.error('LLM_CHAT_FETCH_ERROR', { message, ...errorFields(e) });
        return { success: false, error: message, requestId };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.LLM_STATUS,
    async (_e, payload: { requestId: string }) => ({
      success: true,
      data: {
        configured: llmConfiguredFromEnv(),
        endpoint: openRouterEndpoint(),
        model: openRouterModel(),
      },
      requestId: payload.requestId,
    })
  );
}
