import { createMcpHandler } from "@modelcontextprotocol/server";
import { Wuapi, WuapiError, type FetchLike } from "@wuapidev/sdk";
import { createWuapiMcpServer, type ToolCallEvent } from "./server.js";

// The remote MCP server: Streamable HTTP, stateless, one fresh server per
// request, authenticated with the caller's own wuapi API key as a bearer
// token (`Authorization: Bearer wu_live_...`).
//
// This layer checks that a key is present and well formed, then builds a
// client with it. It never decides what the key may do: every tool calls the
// REST API with that key, and the API authorizes (organization or project
// scope), rate limits and logs each call as it does for any other client.
//
// The key is never logged, echoed or put in a tool result. `onRequest` gets
// the JSON-RPC methods and tool names of the request, never arguments.

export const MAX_BODY_BYTES = 1_000_000;

/** `wu_live_` and the random part. Checked before anything else runs. */
const API_KEY = /^wu_(live|test)_[A-Za-z0-9]{16,128}$/;
/** A project id or `ext:<externalId>`, as `Wuapi-Project` takes it. */
const PROJECT = /^[A-Za-z0-9._:@-]{1,200}$/;

export const PROJECT_HEADER = "wuapi-project";
export const READ_ONLY_HEADER = "wuapi-read-only";

export interface McpRequestLog {
  status: number;
  ms: number;
  /** JSON-RPC methods in the request body (`initialize`, `tools/list`, `tools/call`). */
  methods: string[];
  /** Tools called, with their outcome. */
  tools: ToolCallEvent[];
  /** Why the request was refused before reaching MCP (`missing_key`, `invalid_key`, ...). */
  rejected?: string;
  project?: boolean;
  readOnly?: boolean;
  userAgent?: string;
}

export interface WuapiMcpHttpOptions {
  /** The REST API. Defaults to https://api.wuapi.dev. */
  baseUrl?: string;
  /** Where the docs resources are read from. Defaults to https://wuapi.dev. */
  siteUrl?: string;
  /** fetch for API calls and resources (tests). */
  fetch?: FetchLike;
  /** Per-attempt timeout of each API call. Default 25 s. */
  timeoutMs?: number;
  /** Retries of each API call after the first attempt. Default 1. */
  maxRetries?: number;
  /** Called once per request, after the response is ready. For logging. */
  onRequest?: (log: McpRequestLog) => void;
}

export type WuapiMcpHttpHandler = (request: Request) => Promise<Response>;

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

/** The bearer token of the request, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}

function rpcMethods(body: unknown): string[] {
  const msgs = Array.isArray(body) ? body : [body];
  const out: string[] = [];
  for (const m of msgs) {
    const method = (m as { method?: unknown } | null)?.method;
    if (typeof method === "string" && method.length <= 100) out.push(method);
  }
  return out.slice(0, 20);
}

/** The HTTP status `GET /v1/me` answers for this key, or 0 when the API could not be asked. */
async function keyStatus(token: string, project: string | undefined, options: WuapiMcpHttpOptions): Promise<number> {
  try {
    const client = new Wuapi({
      apiKey: token,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(project ? { project } : {}),
      timeoutMs: 10_000,
      maxRetries: 0,
    });
    await client.me();
    return 200;
  } catch (err) {
    return err instanceof WuapiError ? err.status : 0;
  }
}

const CHALLENGE ='Bearer realm="wuapi", error="invalid_token", error_description="Send your wuapi API key as Authorization: Bearer wu_live_..."';

export function createWuapiMcpHttpHandler(options: WuapiMcpHttpOptions = {}): WuapiMcpHttpHandler {
  // One handler; each request gets its own server and client, built from that
  // request's key (passed through `authInfo`, never shared between requests).
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const extra = (authInfo?.extra ?? {}) as { project?: string; readOnly?: boolean; onToolCall?: (e: ToolCallEvent) => void };
      const client = new Wuapi({
        apiKey: authInfo?.token ?? "",
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(extra.project ? { project: extra.project } : {}),
        timeoutMs: options.timeoutMs ?? 25_000,
        maxRetries: options.maxRetries ?? 1,
      });
      return createWuapiMcpServer({
        client,
        readOnly: Boolean(extra.readOnly),
        ...(options.siteUrl ? { siteUrl: options.siteUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(extra.onToolCall ? { onToolCall: extra.onToolCall } : {}),
      });
    },
    { legacy: "stateless", responseMode: "json", maxRequestBodySize: MAX_BODY_BYTES },
  );

  return async function handle(request: Request): Promise<Response> {
    const started = Date.now();
    const tools: ToolCallEvent[] = [];
    let methods: string[] = [];
    const userAgent = request.headers.get("user-agent")?.slice(0, 200) ?? undefined;
    const done = (response: Response, extra: Partial<McpRequestLog> = {}): Response => {
      try {
        options.onRequest?.({ status: response.status, ms: Date.now() - started, methods, tools, ...(userAgent ? { userAgent } : {}), ...extra });
      } catch {
        // Logging never changes the response.
      }
      return response;
    };

    const token = bearerToken(request);
    if (!token) return done(jsonRpcError(401, "Missing API key. Send your wuapi API key as Authorization: Bearer wu_live_...", { "WWW-Authenticate": 'Bearer realm="wuapi"' }), { rejected: "missing_key" });
    if (!API_KEY.test(token)) return done(jsonRpcError(401, "Malformed API key. wuapi keys start with wu_live_.", { "WWW-Authenticate": CHALLENGE }), { rejected: "invalid_key" });

    const projectHeader = request.headers.get(PROJECT_HEADER)?.trim();
    if (projectHeader && !PROJECT.test(projectHeader)) return done(jsonRpcError(400, "Invalid Wuapi-Project header: a project id or ext:<externalId>."), { rejected: "invalid_project" });
    const readOnlyHeader = request.headers.get(READ_ONLY_HEADER)?.trim().toLowerCase();
    const readOnly = readOnlyHeader === "true" || readOnlyHeader === "1";

    // Read the body here (bounded) to know the methods for the log, and hand
    // the parsed value to the MCP handler.
    let parsedBody: unknown;
    if (request.method === "POST") {
      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > MAX_BODY_BYTES) return done(jsonRpcError(413, "Request body too large."), { rejected: "too_large" });
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return done(jsonRpcError(413, "Request body too large."), { rejected: "too_large" });
      try {
        parsedBody = JSON.parse(text);
      } catch {
        return done(new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }), { status: 400, headers: { "Content-Type": "application/json" } }), { rejected: "parse_error" });
      }
      methods = rpcMethods(parsedBody);
    }

    // When a client connects, check the key once with the API (GET /v1/me),
    // so a revoked or mistyped key fails the connection with 401 instead of
    // every tool call later. Other failures (network, 5xx) do not block.
    if (methods.includes("initialize") || methods.includes("server/discover")) {
      const status = await keyStatus(token, projectHeader, options);
      if (status === 401) return done(jsonRpcError(401, "Invalid API key: it is unknown or revoked. Create a key in the wuapi dashboard under API keys.", { "WWW-Authenticate": CHALLENGE }), { rejected: "unauthorized" });
      if (status === 403 || status === 404) return done(jsonRpcError(403, "This key cannot use the project in Wuapi-Project."), { rejected: "forbidden_project" });
    }

    const forward = new Request(request.url, { method: request.method, headers: request.headers });
    const response = await handler.fetch(forward, {
      authInfo: {
        token,
        clientId: "wuapi-api-key",
        scopes: [],
        extra: { project: projectHeader || undefined, readOnly, onToolCall: (e: ToolCallEvent) => tools.push(e) },
      },
      ...(parsedBody !== undefined ? { parsedBody } : {}),
    });
    // The body is produced while it is read (tool calls run then). Stateless
    // exchanges end with their result, so read it here: the log then has the
    // outcome of every tool call and the real duration.
    const body = await response.arrayBuffer();
    const buffered = new Response(body.byteLength ? body : null, { status: response.status, statusText: response.statusText, headers: response.headers });
    return done(buffered, { project: Boolean(projectHeader), readOnly });
  };
}
