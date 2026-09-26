import { describe, expect, it } from "vitest";
import { isSafeBaseUrl, parseConfig } from "../src/config.js";
import { compact } from "../src/format.js";
import { KEY } from "./helpers.js";

describe("stdio config", () => {
  it("needs a well-formed WUAPI_API_KEY and never echoes it", () => {
    const missing = parseConfig({});
    expect(missing.ok).toBe(false);
    const bad = parseConfig({ WUAPI_API_KEY: "sk_live_something_else_entirely" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).not.toContain("sk_live_");
    expect(parseConfig({ WUAPI_API_KEY: KEY })).toEqual({ ok: true, value: { apiKey: KEY, readOnly: false } });
  });

  it("reads the project, base URL and read-only mode", () => {
    const r = parseConfig({ WUAPI_API_KEY: KEY, WUAPI_PROJECT: "ext:c_1", WUAPI_BASE_URL: "http://localhost:3210", WUAPI_MCP_READ_ONLY: "true" });
    expect(r).toEqual({ ok: true, value: { apiKey: KEY, project: "ext:c_1", baseUrl: "http://localhost:3210", readOnly: true } });
    expect(parseConfig({ WUAPI_API_KEY: KEY }, ["--read-only"])).toMatchObject({ ok: true, value: { readOnly: true } });
  });

  it("refuses a base URL that would send the key in clear text", () => {
    expect(isSafeBaseUrl("https://api.wuapi.dev")).toBe(true);
    expect(isSafeBaseUrl("http://localhost:3000")).toBe(true);
    expect(isSafeBaseUrl("http://api.example.com")).toBe(false);
    expect(isSafeBaseUrl("https://user:pass@api.example.com")).toBe(false);
    expect(isSafeBaseUrl("ftp://x")).toBe(false);
    expect(parseConfig({ WUAPI_API_KEY: KEY, WUAPI_BASE_URL: "http://evil.example" }).ok).toBe(false);
  });
});

describe("compact", () => {
  it("drops nulls, type tags, secrets and data URLs", () => {
    expect(
      compact({ object: "x", a: null, b: 1, secret: "whsec_1", nested: { key: "wu_live_1", token: "t", ok: true, img: "data:image/png;base64,AAAA" }, list: [null, 2] }),
    ).toEqual({ b: 1, nested: { ok: true, img: "[data URL omitted]" }, list: [2] });
  });
});
