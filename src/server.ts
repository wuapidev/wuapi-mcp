import { McpServer } from "@modelcontextprotocol/server";
import type { Wuapi } from "@wuapidev/sdk";
import { WuapiError } from "@wuapidev/sdk";
import { errorResult } from "./format.js";
import { PROMPTS } from "./prompts.js";
import { readResource, RESOURCES, type ResourceFetch } from "./resources.js";
import { TOOLS, type ToolDefinition } from "./tools.js";
import { DEFAULT_SITE_URL, SERVER_NAME, VERSION } from "./version.js";

export interface ToolCallEvent {
  tool: string;
  ok: boolean;
  /** The API's error code when the call failed (`unauthorized`, `rate_limited`, ...). */
  errorCode?: string;
  status?: number;
  ms: number;
}

export interface WuapiMcpServerOptions {
  /** The client every tool calls. Its API key and project scope decide what the tools can reach. */
  client: Wuapi;
  /** Register only tools that read (`readOnlyHint`). */
  readOnly?: boolean;
  /** Where the docs resources are read from. Defaults to https://wuapi.dev. */
  siteUrl?: string;
  /** fetch for the docs resources. Defaults to the global fetch. */
  fetch?: ResourceFetch;
  /** Called after every tool call, for logging. Receives no arguments or results. */
  onToolCall?: (event: ToolCallEvent) => void;
}

export const INSTRUCTIONS = [
  "wuapi links WhatsApp numbers as devices and exposes them through a REST API. These tools act as the API key this server was started with.",
  "Accounts are linked numbers; only accounts with status `ready` can send. Ids: contacts are E.164 with + or `lid:<digits>`, groups end in `@g.us`.",
  "Sends are queued and paced; check the outcome with get_message. Send only to people who expect the message, and never send the same message twice: reuse `idempotencyKey` when retrying.",
  "Tools marked destructive need `confirm: true`: set it only after the user asked for or approved that action.",
  "Some tools group related operations under an `action` argument (manage_channel, manage_labels, ...); their descriptions list the actions and the fields each one needs, and only the destructive actions need `confirm: true`.",
  "Projects, invitations, branding and usage need an organization key; a project key only reaches its own project.",
].join("\n");

/** The tools a server registers for these options. Read-only: the tools that read, and the reading actions of tools that mix both. */
export function toolsFor(options: Pick<WuapiMcpServerOptions, "readOnly">): ToolDefinition[] {
  if (!options.readOnly) return TOOLS;
  return TOOLS.flatMap((t) => (t.annotations.readOnlyHint ? [t] : t.readOnlyVariant ? [t.readOnlyVariant] : []));
}

/** An MCP server exposing wuapi's API as tools, resources and prompts. Create one per client (and per HTTP request). */
export function createWuapiMcpServer(options: WuapiMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: "wuapi", version: VERSION, websiteUrl: "https://wuapi.dev/docs/mcp" },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );
  const { client } = options;
  const siteUrl = (options.siteUrl ?? DEFAULT_SITE_URL).replace(/\/+$/, "");
  const fetchImpl: ResourceFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  for (const def of toolsFor(options)) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: { title: def.title, ...def.annotations } },
      async (args: unknown) => {
        const started = Date.now();
        try {
          const result = await def.run(client, args as never);
          options.onToolCall?.({ tool: def.name, ok: !result.isError, ms: Date.now() - started });
          return result as never;
        } catch (err) {
          options.onToolCall?.({
            tool: def.name,
            ok: false,
            ms: Date.now() - started,
            ...(err instanceof WuapiError ? { errorCode: err.code, status: err.status } : { errorCode: "internal_error" }),
          });
          return errorResult(err) as never;
        }
      },
    );
  }

  for (const res of RESOURCES) {
    server.registerResource(res.name, res.uri, { title: res.title, description: res.description, mimeType: res.mimeType }, async () => ({
      contents: [{ uri: res.uri, mimeType: res.mimeType, text: await readResource(res, siteUrl, fetchImpl) }],
    }));
  }

  for (const p of PROMPTS) {
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.argsSchema }, (args: unknown) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: p.text(args as never) } }],
    }));
  }

  return server;
}
