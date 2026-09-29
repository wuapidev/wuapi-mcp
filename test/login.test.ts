import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { configDir, credentialsPath, readStoredLogin } from "../src/login.js";
import { KEY } from "./helpers.js";

const KEY2 = "wu_live_qrstuvwxyzabcdef5678";

function home(file?: unknown): Record<string, string> {
  const cfg = mkdtempSync(join(tmpdir(), "wuapi-mcp-login-"));
  const env = { XDG_CONFIG_HOME: cfg };
  if (file !== undefined) {
    mkdirSync(join(cfg, "wuapi"), { recursive: true });
    writeFileSync(join(cfg, "wuapi", "credentials.json"), typeof file === "string" ? file : JSON.stringify(file));
  }
  return env;
}

const v2 = {
  version: 2,
  current: "acme",
  profiles: {
    acme: { apiKey: KEY, organization: { id: "org_1", name: "Acme" }, project: null, createdAt: "" },
    "acme/shop": { apiKey: KEY2, baseUrl: "http://localhost:3210", organization: { id: "org_1", name: "Acme" }, project: { id: "prj_1", name: "Shop" }, createdAt: "" },
  },
};

describe("the CLI's stored login", () => {
  it("resolves the same paths as the wuapi CLI", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe("/x/wuapi");
    expect(configDir({}, "linux", "/home/u")).toBe("/home/u/.config/wuapi");
    expect(credentialsPath({ APPDATA: "C:\\A" }, "win32", "C:\\U")).toBe("C:\\A\\wuapi\\credentials.json");
  });

  it("reads the current profile, or the one WUAPI_PROFILE names, from a version-2 file", () => {
    const env = home(v2);
    expect(readStoredLogin(env)).toEqual({ ok: true, value: { profile: "acme", apiKey: KEY } });
    expect(readStoredLogin({ ...env, WUAPI_PROFILE: "acme/shop" })).toEqual({
      ok: true,
      value: { profile: "acme/shop", apiKey: KEY2, baseUrl: "http://localhost:3210", projectId: "prj_1" },
    });
    const missing = readStoredLogin({ ...env, WUAPI_PROFILE: "nope" });
    expect(missing.ok).toBe(false);
  });

  it("reads a version-1 file, and nothing when there is no file", () => {
    const env = home({ version: 1, apiKey: KEY, organization: { id: "o", name: "O" }, project: { id: "prj_9", name: "P" }, createdAt: "" });
    expect(readStoredLogin(env)).toEqual({ ok: true, value: { profile: null, apiKey: KEY, projectId: "prj_9" } });
    expect(readStoredLogin(home())).toEqual({ ok: true, value: null });
    expect(readStoredLogin(home("{not json")).ok).toBe(false);
  });

  it("parseConfig falls back to it; the environment wins", () => {
    const env = home(v2);
    const load = (e: Record<string, string | undefined>) => () => readStoredLogin(e);
    expect(parseConfig(env, [], load(env))).toEqual({ ok: true, value: { apiKey: KEY, readOnly: false } });
    const shop = { ...env, WUAPI_PROFILE: "acme/shop" };
    expect(parseConfig(shop, [], load(shop))).toEqual({ ok: true, value: { apiKey: KEY2, baseUrl: "http://localhost:3210", project: "prj_1", readOnly: false } });
    const override = { ...shop, WUAPI_PROJECT: "ext:c_1", WUAPI_BASE_URL: "https://api.wuapi.dev" };
    expect(parseConfig(override, [], load(override))).toMatchObject({ ok: true, value: { apiKey: KEY2, project: "ext:c_1", baseUrl: "https://api.wuapi.dev" } });
    const withEnvKey = { ...env, WUAPI_API_KEY: KEY2 };
    expect(parseConfig(withEnvKey, [], load(withEnvKey))).toEqual({ ok: true, value: { apiKey: KEY2, readOnly: false } });
    const none = home();
    const r = parseConfig(none, [], load(none));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("npx wuapi login");
  });
});
