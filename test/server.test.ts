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
    const channel = tools.find((t) => t.name === "manage_channel")!;
    expect((channel.inputSchema.properties as { action: { enum: string[] } }).action.enum).toEqual(["list", "get", "preview_invite", "list_messages"]);
    expect(tools.find((t) => t.name === "unlink_account")).toBeUndefined();
  });

  it("publishes action tools as plain objects and runs the chosen action", async () => {
    const { mcp, client } = await connect();
    const { tools } = await mcp.listTools();
    const channel = tools.find((t) => t.name === "manage_channel")!;
    expect(channel.inputSchema.type).toBe("object");
    expect(channel.inputSchema).not.toHaveProperty("oneOf");
    expect(channel.inputSchema.required).toEqual(["action"]);
    const res = await mcp.callTool({ name: "manage_channel", arguments: { action: "follow", accountId: "acc_1", channelId: "c@newsletter" } });
    expect(res.isError).toBeFalsy();
    expect(client.channels.follow).toHaveBeenCalledWith("acc_1", "c@newsletter");
    const missing = await mcp.callTool({ name: "manage_channel", arguments: { action: "follow", accountId: "acc_1" } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("needs `channelId`");
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
    expect(prompts.map((p) => p.name).sort()).toEqual(["invite_customer", "send_message", "setup_webhook", "use_streams"]);
    const p = await mcp.getPrompt({ name: "send_message", arguments: { to: "+584241112233", message: "Hello" } });
    expect((p.messages[0]!.content as { text: string }).text).toContain("send_text");
  });

  it("serves the Streams prompt: when to choose it over Webhooks, and the rules a stream client must follow", async () => {
    const { mcp } = await connect();
    const { prompts } = await mcp.listPrompts();
    const streams = prompts.find((p) => p.name === "use_streams")!;
    expect(streams.title).toBe("Use Streams");

    const plain = await mcp.getPrompt({ name: "use_streams", arguments: {} });
    const text = (plain.messages[0]!.content as { text: string }).text;
    // the choice: Webhooks for a server with a public https endpoint, Streams otherwise, REST for history
    expect(text).toContain("Webhooks");
    expect(text).toContain("public https endpoint");
    expect(text).toContain("setup_webhook");
    // the SDK helper first, in the two languages that have it
    expect(text).toContain("wuapi.events.stream(");
    expect(text).toContain("client.events().stream(");
    expect(text).toContain("@wuapidev/sdk");
    expect(text.indexOf("wuapi.events.stream(")).toBeLessThan(text.indexOf("Read the response as text/event-stream"));
    // the wire contract
    expect(text).toContain("https://stream.wuapi.dev/v1/events/stream");
    expect(text).toContain("Authorization");
    expect(text).toContain("Last-Event-ID");
    expect(text).toContain("`reset`");
    expect(text).toContain("evt_");
    // a browser's EventSource cannot send the header
    expect(text).toContain("EventSource");
    expect(text).toContain("your backend");
    // never poll for events
    expect(text).toMatch(/never poll/i);
    // the way to watch it work
    expect(text).toContain("npx @wuapidev/cli events stream");
  });

  it("puts the project and the language of the code into the Streams prompt when given", async () => {
    const { mcp } = await connect();
    const withArgs = await mcp.getPrompt({ name: "use_streams", arguments: { project: "proj_northwind", language: "Python" } });
    const text = (withArgs.messages[0]!.content as { text: string }).text;
    expect(text).toContain("Python");
    expect(text).toContain("Wuapi-Project: proj_northwind");
    const without = await mcp.getPrompt({ name: "use_streams", arguments: {} });
    expect((without.messages[0]!.content as { text: string }).text).not.toContain("Wuapi-Project: proj_");
  });
});
