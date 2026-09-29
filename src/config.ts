// The stdio server's configuration, from the environment and flags, falling
// back to the login the `wuapi` CLI stored (`npx wuapi login`). Pure given
// `loadLogin`, so it is tested without starting a process or touching disk.

import type { StoredLoginResult } from "./login.js";

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

/**
 * WUAPI_API_KEY, else the CLI's stored login (the profile WUAPI_PROFILE names,
 * or the current one; `loadLogin` reads it). With a stored login, its base URL
 * and project apply unless WUAPI_BASE_URL / WUAPI_PROJECT override them.
 */
export function parseConfig(
  env: Record<string, string | undefined>,
  args: string[] = [],
  loadLogin: () => StoredLoginResult = () => ({ ok: true, value: null }),
): ConfigResult {
  let apiKey = env.WUAPI_API_KEY?.trim();
  let stored: { baseUrl?: string; projectId?: string } | undefined;
  let source = "WUAPI_API_KEY";
  if (!apiKey) {
    const login = loadLogin();
    if (!login.ok) return { ok: false, error: login.error };
    if (login.value) {
      apiKey = login.value.apiKey;
      stored = login.value;
      source = login.value.profile ? `the stored login (profile ${login.value.profile})` : "the stored login";
    }
  }
  if (!apiKey) {
    return {
      ok: false,
      error: "no API key: run `npx wuapi login`, or set WUAPI_API_KEY to your wuapi API key (create one at https://wuapi.dev/app/api-keys).",
    };
  }
  if (!/^wu_(live|test)_[A-Za-z0-9]{16,128}$/.test(apiKey)) {
    return { ok: false, error: `${source === "WUAPI_API_KEY" ? "WUAPI_API_KEY" : `The key in ${source}`} does not look like a wuapi API key (wu_live_...).` };
  }
  const baseUrl = env.WUAPI_BASE_URL?.trim() || stored?.baseUrl || undefined;
  if (baseUrl && !isSafeBaseUrl(baseUrl)) {
    return { ok: false, error: "WUAPI_BASE_URL must be an https URL (or http://localhost for development)." };
  }
  const project = env.WUAPI_PROJECT?.trim() || stored?.projectId || undefined;
  if (project && !/^[A-Za-z0-9._:@-]{1,200}$/.test(project)) {
    return { ok: false, error: "WUAPI_PROJECT must be a project id or ext:<externalId>." };
  }
  const readOnly = args.includes("--read-only") || TRUE.has((env.WUAPI_MCP_READ_ONLY ?? "").trim().toLowerCase());
  return { ok: true, value: { apiKey, ...(baseUrl ? { baseUrl } : {}), ...(project ? { project } : {}), readOnly } };
}
