export interface AppSettings {
  workspaceRoot: string;
  /** 是否允许写入工作区（Python/hostAPI、目录创建、浏览器截图写入等）；读与列表始终允许。 */
  workspaceWriteEnabled: boolean;
  /** Absolute path to laika-settings.json */
  configFilePath: string;
  /**
   * Playwright browser automation allowlist (hostname patterns).
   * `["*"]` = any https host that passes SSRF checks. See `laika-settings.json`.
   */
  browserAllowedHosts: string[];
  /** 主进程是否检测到 OPENROUTER_API_KEY（不在 JSON 中存密钥）。 */
  llmConfigured: boolean;
  /** 展示用：OpenRouter Chat Completions 完整 URL（无密钥）。 */
  llmChatEndpoint: string;
  /** 展示用：当前模型 slug。 */
  llmModel: string;
}
