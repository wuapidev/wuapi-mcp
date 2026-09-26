import { WuapiError } from "@wuapidev/sdk";

// What tools hand back to the model: the API's own objects, made smaller and
// stripped of anything secret.
//
// - `null` and `undefined` fields are dropped, and so is `object` (the type
//   tag every resource carries): the tool name already says what came back.
// - Secrets never reach a tool result. The API returns a webhook endpoint's
//   signing secret (`secret`) and a new API key (`key`) exactly once, on the
//   response that created them; here those fields are removed wherever they
//   appear, and the result says where to get them instead. A model's context
//   is logged and shared in ways an API response is not.
// - Data URLs (the QR code PNG of an account, a few KB of base64) are replaced
//   with a short marker; `get_account_qr_code` returns the QR code as an image.

/** Fields that are never returned, at any depth. */
export const SECRET_FIELDS: ReadonlySet<string> = new Set(["secret", "key", "token"]);

const DATA_URL = /^data:[^,]{0,100},/;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A copy of `value` without nulls, type tags, secrets or data URLs. */
export function compact(value: unknown, depth = 0): Json | undefined {
  if (value === null || value === undefined) return undefined;
  if (depth > 12) return undefined;
  if (typeof value === "string") return DATA_URL.test(value) ? "[data URL omitted]" : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const out: Json[] = [];
    for (const item of value) {
      const c = compact(item, depth + 1);
      if (c !== undefined) out.push(c);
    }
    return out;
  }
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "object" || SECRET_FIELDS.has(k)) continue;
      const c = compact(v, depth + 1);
      if (c === undefined) continue;
      if (typeof c === "object" && c !== null && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out;
  }
  return undefined;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  [key: string]: unknown;
  content: ContentBlock[];
  structuredContent?: { [key: string]: unknown };
  isError?: boolean;
}

/** A successful result: the compacted data as structured content, and the same as JSON text for clients that only read text. */
export function ok(data: object, extra: ContentBlock[] = []): ToolResult {
  const structured = (compact(data) ?? {}) as { [key: string]: Json };
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }, ...extra],
    structuredContent: structured,
  };
}

/** One page of a list, as `{ items, nextCursor }`. */
export function page<T>(res: { items: T[]; nextCursor: string | null }, map: (item: T) => unknown = (x) => x): ToolResult {
  return ok({ items: res.items.map(map), nextCursor: res.nextCursor, hasMore: res.nextCursor !== null });
}

/** A tool failure the model can read and act on. */
export function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  const error = (compact({ code, message, ...extra }) ?? {}) as { [key: string]: Json };
  return {
    content: [{ type: "text", text: `${code}: ${message}` + (Object.keys(error).length > 2 ? `\n${JSON.stringify(error)}` : "") }],
    structuredContent: { error },
    isError: true,
  };
}

const MAX_DETAILS_CHARS = 2_000;

/** Any error thrown while running a tool, as an error result. Never includes the API key or stack traces. */
export function errorResult(err: unknown): ToolResult {
  if (err instanceof WuapiError) {
    let details = compact(err.details);
    if (details !== undefined && JSON.stringify(details).length > MAX_DETAILS_CHARS) details = undefined;
    return fail(err.code, err.message, {
      status: err.status || undefined,
      requestId: err.requestId,
      retryAfterSeconds: err.retryAfter,
      details,
      hint: hintFor(err),
    });
  }
  if (err instanceof ToolInputError) return fail("invalid_request", err.message);
  return fail("internal_error", "The tool failed unexpectedly. Try again; if it keeps failing, check the request in the wuapi dashboard Logs.");
}

/** A problem with the arguments that the schema cannot express. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

function hintFor(err: WuapiError): string | undefined {
  switch (err.code) {
    case "unauthorized":
      return "The API key is missing, malformed or revoked. Create a key in the wuapi dashboard under API keys.";
    case "forbidden":
      return "This key cannot reach that resource: a project key only reaches its own project, and some tools need an organization key.";
    case "account_not_ready":
      return "The account is not connected. Check it with get_account; link it with get_account_qr_code or request_pairing_code.";
    case "rate_limited":
      return "Wait retryAfterSeconds before calling again.";
    case "subscription_required":
    case "trial_ended":
      return "Start or renew the subscription under Billing in the wuapi dashboard.";
    default:
      return undefined;
  }
}
