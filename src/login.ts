// The login `npx @wuapidev/cli login` stores (the `wuapi` CLI), read so the stdio
// server works without WUAPI_API_KEY in the client's config. The path logic is
// a copy of the CLI's src/paths.ts (packages/wuapi-cli): keep both the same.
// Read-only: this server never writes or migrates the file.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, posix, win32 } from "node:path";

type Env = Record<string, string | undefined>;

/** `%APPDATA%\wuapi` on Windows, `$XDG_CONFIG_HOME/wuapi` when set, else `~/.config/wuapi`. */
export function configDir(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return win32.join(appData || win32.join(home, "AppData", "Roaming"), "wuapi");
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return posix.join(xdg && isAbsolute(xdg) ? xdg : posix.join(home, ".config"), "wuapi");
}

export function credentialsPath(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const dir = configDir(env, platform, home);
  return platform === "win32" ? win32.join(dir, "credentials.json") : posix.join(dir, "credentials.json");
}

export interface StoredLogin {
  /** The profile's name; null for a version-1 file. */
  profile: string | null;
  apiKey: string;
  baseUrl?: string;
  projectId?: string;
}

interface StoredProfile {
  apiKey?: unknown;
  baseUrl?: unknown;
  project?: { id?: unknown } | null;
}

function fromProfile(name: string | null, p: StoredProfile | undefined): StoredLogin | null {
  if (!p || typeof p.apiKey !== "string") return null;
  return {
    profile: name,
    apiKey: p.apiKey,
    ...(typeof p.baseUrl === "string" ? { baseUrl: p.baseUrl } : {}),
    ...(typeof p.project?.id === "string" ? { projectId: p.project.id } : {}),
  };
}

export type StoredLoginResult = { ok: true; value: StoredLogin | null } | { ok: false; error: string };

/**
 * The profile WUAPI_PROFILE names, else the current one. Handles the CLI's
 * version-1 (one login) and version-2 (profiles) files. `null` when there is
 * no file or no usable profile.
 */
export function readStoredLogin(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): StoredLoginResult {
  let text: string;
  try {
    text = readFileSync(credentialsPath(env, platform, home), "utf8");
  } catch {
    return { ok: true, value: null };
  }
  let raw: { version?: unknown; current?: unknown; profiles?: Record<string, StoredProfile> } & StoredProfile;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${credentialsPath(env, platform, home)} is not valid JSON; run \`npx @wuapidev/cli login\` again.` };
  }
  const wanted = env.WUAPI_PROFILE?.trim() || undefined;
  if (raw.version === 2 && raw.profiles && typeof raw.profiles === "object") {
    if (wanted) {
      const hit = fromProfile(wanted, raw.profiles[wanted]);
      if (!hit) return { ok: false, error: `WUAPI_PROFILE names no stored profile (${Object.keys(raw.profiles).join(", ") || "none"}).` };
      return { ok: true, value: hit };
    }
    const current = typeof raw.current === "string" ? raw.current : undefined;
    return { ok: true, value: current ? fromProfile(current, raw.profiles[current]) : null };
  }
  if (raw.version === 1) {
    if (wanted) return { ok: false, error: "WUAPI_PROFILE is set but the stored login has no profiles; run `npx @wuapidev/cli login` again." };
    return { ok: true, value: fromProfile(null, raw) };
  }
  return { ok: true, value: null };
}
