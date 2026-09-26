import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWuapiMcpServer } from "../src/server.js";
import { TOOLS } from "../src/tools.js";
import { asWuapi, message, mockClient } from "./helpers.js";

// A real MCP client talking to the server over an in-memory transport: what
// Claude Desktop or Cursor see, minus the process boundary.

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function connect(options: Partial<Parameters<typeof createWuapiMcpServer>[0]> = {}) {
  const client = mockClient();
  const onToolCall = vi.fn();
  const server = createWuapiMcpServer({ client: asWuapi(client), onToolCall, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "test-client", version: "1.0.0" });
  await mcp.connect(clientTransport);
  open.push(async () => {
    await mcp.close();
    await server.close();
  });
  return { mcp, client, onToolCall };
}

describe("MCP server over an in-memory transport", () => {
  it("lists every tool with its JSON schema and annotations", async () => {
    const { mcp } = await connect();
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    const send = tools.find((t) => t.name === "send_text")!;
    expect(send.inputSchema.type).toBe("object");
    expect(send.inputSchema.required).toEqual(expect.arrayContaining(["accountId", "to", "text"]));
    expect(send.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    const del = tools.find((t) => t.name === "delete_message")!;
    expect(del.annotations).toMatchObject({ destructiveHint: true });
    expect(del.inputSchema.required).toContain("confirm");
    const get = tools.find((t) => t.name === "get_message")!;
    expect(get.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("registers only reading tools in read-only mode", async () => {
    const { mcp } = await connect({ readOnly: true });
    const { tools } = await mcp.listTools();
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.find((t) => t.name === "send_text")).toBeUndefined();
  });

  it("calls a tool and returns structured content", async () => {
    const { mcp, client, onToolCall } = await connect();
    client.messages.send!.mockResolvedValue(message());
    const res = await mcp.callTool({ name: "send_text", arguments: { accountId: "acc_1", to: "+584241112233", text: "hi" } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ message: { id: "msg_1", status: "queued" } });
    expect(client.messages.send).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "send_text", ok: true }));
  });

  it("rejects invalid arguments without calling the API", async () => {
    const { mcp, client } = await connect();
    const res = await mcp.callTool({ name: "delete_message", arguments: { messageId: "m" } });
    expect(res.isError).toBe(true);
    expect(client.messages.delete).not.toHaveBeenCalled();
  });

  it("serves the resources and prompts", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"openapi":"3.1.0"}', { status: 200 }));
    const { mcp } = await connect({ fetch: fetchImpl, siteUrl: "https://example.test" });
    const { resources } = await mcp.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(["https://wuapi.dev/openapi.json", "https://wuapi.dev/llms-full.txt", "wuapi://webhook-events"]),
    );
    const events = await mcp.readResource({ uri: "wuapi://webhook-events" });
    expect(JSON.parse((events.contents[0] as { text: string }).text).events).toContain("message.received");
    const spec = await mcp.readResource({ uri: "https://wuapi.dev/openapi.json" });
    expect((spec.contents[0] as { text: string }).text).toContain("3.1.0");
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/openapi.json", expect.anything());

    const { prompts } = await mcp.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["invite_customer", "send_message", "setup_webhook"]);
    const p = await mcp.getPrompt({ name: "send_message", arguments: { to: "+584241112233", message: "Hello" } });
    expect((p.messages[0]!.content as { text: string }).text).toContain("send_text");
  });
});
