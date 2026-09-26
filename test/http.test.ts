import { describe, expect, it, vi } from "vitest";
import { createWuapiMcpHttpHandler, type McpRequestLog } from "../src/http.js";
import { KEY, message } from "./helpers.js";

// The remote server end to end: a fake wuapi REST API behind `fetch`, the
// handler in front, JSON-RPC requests as an MCP client sends them.

const URL_ = "https://wuapi.dev/api/mcp";

function api(routes: Record<string, (init: RequestInit) => Response>) {
  return vi.fn(async (input: string, init: RequestInit) => {
    const path = new URL(input).pathname;
    const route = routes[`${init.method} ${path}`];
    if (!route) return new Response(JSON.stringify({ code: "not_found", message: "no route" }), { status: 404 });
    return route(init);
  });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const me = () =>
  json({
    object: "auth_context",
    organization: { object: "organization", id: "org_1", name: "Acme" },
    apiKey: { object: "api_key", id: "key_1", name: "Prod", projectId: null, keyPrefix: "wu_live_0123", last4: "cdef", createdAt: "x", lastUsedAt: null, revokedAt: null },
    project: null,
  });

function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...headers },
    body: JSON.stringify(body),
  });
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

async function readRpc(res: Response): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
  const text = await res.text();
  if (text.startsWith("{")) return JSON.parse(text);
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(data!.slice(6));
}

describe("remote MCP endpoint auth", () => {
  it("answers 401 without a key, and never calls the API", async () => {
    const fetchImpl = api({});
    const handle = createWuapiMcpHttpHandler({ fetch: fetchImpl });
    const res = await handle(rpc(initialize));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers 401 for a malformed key or another scheme", async () => {
    const handle = createWuapiMcpHttpHandler({ fetch: api({}) });
    expect((await handle(rpc(initialize, { Authorization: "Bearer nope" }))).status).toBe(401);
    expect((await handle(rpc(initialize, { Authorization: `Basic ${KEY}` }))).status).toBe(401);
  });

  it("answers 401 when the API does not know the key", async () => {
    const fetchImpl = api({ "GET /v1/me": () => json({ code: "unauthorized", message: "Missing or invalid API key." }, 401) });
    const handle = createWuapiMcpHttpHandler({ fetch: fetchImpl });
    const res = await handle(rpc(initialize, { Authorization: `Bearer ${KEY}` }));
    expect(res.status).toBe(401);
  });

  it("refuses a malformed Wuapi-Project header", async () => {
    const handle = createWuapiMcpHttpHandler({ fetch: api({}) });
    const res = await handle(rpc(initialize, { Authorization: `Bearer ${KEY}`, "Wuapi-Project": "bad value!" }));
    expect(res.status).toBe(400);
  });

  it("initializes with a valid key", async () => {
    const handle = createWuapiMcpHttpHandler({ fetch: api({ "GET /v1/me": me }) });
    const res = await handle(rpc(initialize, { Authorization: `Bearer ${KEY}` }));
    expect(res.status).toBe(200);
    const body = await readRpc(res);
    expect((body.result as { serverInfo: { name: string } }).serverInfo.name).toBe("wuapi");
  });
});

describe("remote MCP endpoint tools", () => {
  it("lists tools, and only reading tools with Wuapi-Read-Only", async () => {
    const handle = createWuapiMcpHttpHandler({ fetch: api({}) });
    const all = await readRpc(await handle(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { Authorization: `Bearer ${KEY}` })));
    const ro = await readRpc(await handle(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { Authorization: `Bearer ${KEY}`, "Wuapi-Read-Only": "true" })));
    const names = (r: typeof all) => (r.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names(all)).toContain("send_text");
    expect(names(ro)).not.toContain("send_text");
    expect(names(ro)).toContain("list_messages");
  });

  it("calls the REST API with the caller's key and project, and logs no secrets", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = api({
      "POST /v1/messages": (init) => {
        seen.push(init.headers as Record<string, string>);
        return json(message(), 202);
      },
    });
    const logs: McpRequestLog[] = [];
    const handle = createWuapiMcpHttpHandler({ fetch: fetchImpl, onRequest: (l) => logs.push(l) });
    const res = await handle(
      rpc(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_text", arguments: { accountId: "acc_1", to: "+584241112233", text: "hi" } } },
        { Authorization: `Bearer ${KEY}`, "Wuapi-Project": "ext:customer_1" },
      ),
    );
    expect(res.status).toBe(200);
    // Logged once the tool call finished, before anyone reads the body.
    expect(logs[0]?.tools).toEqual([expect.objectContaining({ tool: "send_text", ok: true })]);
    const body = await readRpc(res);
    expect((body.result as { structuredContent: { message: { id: string } } }).structuredContent.message.id).toBe("msg_1");
    expect(seen[0]!.Authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!["Wuapi-Project"]).toBe("ext:customer_1");

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 200, methods: ["tools/call"], project: true, tools: [expect.objectContaining({ tool: "send_text", ok: true })] });
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain("hi\"");
  });

  it("returns API errors as tool errors", async () => {
    const fetchImpl = api({ "GET /v1/messages/m_1": () => json({ code: "forbidden", message: "The key cannot reach this." }, 403) });
    const logs: McpRequestLog[] = [];
    const handle = createWuapiMcpHttpHandler({ fetch: fetchImpl, onRequest: (l) => logs.push(l) });
    const body = await readRpc(
      await handle(rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_message", arguments: { messageId: "m_1" } } }, { Authorization: `Bearer ${KEY}` })),
    );
    expect((body.result as { isError: boolean }).isError).toBe(true);
    expect(logs[0]!.tools[0]).toMatchObject({ tool: "get_message", ok: false, errorCode: "forbidden", status: 403 });
  });

  it("refuses bodies over the limit", async () => {
    const handle = createWuapiMcpHttpHandler({ fetch: api({}) });
    const big = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "send_text", arguments: { text: "x".repeat(1_100_000) } } };
    const res = await handle(rpc(big, { Authorization: `Bearer ${KEY}` }));
    expect(res.status).toBe(413);
  });
});
