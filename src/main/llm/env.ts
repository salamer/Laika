/**
 * OpenRouter / DeepSeek 配置（仅从环境变量读取，不把 API Key 暴露给渲染进程）。
 */

export function openRouterEndpoint(): string {
  const raw = (process.env.OPENROUTER_BASE_URL || '').replace(/\/$/, '');
  const base = raw || 'https://openrouter.ai/api/v1';
  return `${base}/chat/completions`;
}

export function openRouterApiKey(): string | undefined {
  const k = process.env.OPENROUTER_API_KEY?.trim();
  return k || undefined;
}

/** OpenRouter slug，例如 deepseek/deepseek-chat */
export function openRouterModel(): string {
  return (process.env.OPENROUTER_MODEL || '').trim() || 'deepseek/deepseek-chat';
}

export function openRouterHttpReferer(): string | undefined {
  const r = process.env.OPENROUTER_HTTP_REFERER?.trim();
  return r || undefined;
}

export function openRouterAppTitle(): string | undefined {
  const t = process.env.OPENROUTER_APP_TITLE?.trim();
  return t || undefined;
}

export function llmConfiguredFromEnv(): boolean {
  return Boolean(openRouterApiKey());
}
