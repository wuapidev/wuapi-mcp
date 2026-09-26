// The stdio server's configuration, from the environment and flags. Pure, so
// it is tested without starting a process.

export interface StdioConfig {
  apiKey: string;
  baseUrl?: string;
  project?: string;
  readOnly: boolean;
}

export type ConfigResult = { ok: true; value: StdioConfig } | { ok: false; error: string };

const TRUE = new Set(["1", "true", "yes", "on"]);

/** Plain https, or http on this machine only: the key must never travel in clear text. */
export function isSafeBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

export function parseConfig(env: Record<string, string | undefined>, args: string[] = []): ConfigResult {
  const apiKey = env.WUAPI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "set WUAPI_API_KEY to your wuapi API key (create one at https://wuapi.dev/app/api-keys)." };
  }
  if (!/^wu_(live|test)_[A-Za-z0-9]{16,128}$/.test(apiKey)) {
    return { ok: false, error: "WUAPI_API_KEY does not look like a wuapi API key (wu_live_...)." };
  }
  const baseUrl = env.WUAPI_BASE_URL?.trim() || undefined;
  if (baseUrl && !isSafeBaseUrl(baseUrl)) {
    return { ok: false, error: "WUAPI_BASE_URL must be an https URL (or http://localhost for development)." };
  }
  const project = env.WUAPI_PROJECT?.trim() || undefined;
  if (project && !/^[A-Za-z0-9._:@-]{1,200}$/.test(project)) {
    return { ok: false, error: "WUAPI_PROJECT must be a project id or ext:<externalId>." };
  }
  const readOnly = args.includes("--read-only") || TRUE.has((env.WUAPI_MCP_READ_ONLY ?? "").trim().toLowerCase());
  return { ok: true, value: { apiKey, ...(baseUrl ? { baseUrl } : {}), ...(project ? { project } : {}), readOnly } };
}
