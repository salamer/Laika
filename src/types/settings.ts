export interface AppSettings {
  workspaceRoot: string;
  /** Absolute path to laika-settings.json */
  configFilePath: string;
  /**
   * Playwright browser automation allowlist (hostname patterns).
   * `["*"]` = any https host that passes SSRF checks. See `laika-settings.json`.
   */
  browserAllowedHosts: string[];
}
