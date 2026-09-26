import { WEBHOOK_EVENT_TYPES } from "@wuapidev/sdk";

// Reference material an MCP client can attach to the conversation. The
// documents are fetched from the public site when read (fixed URLs only, so a
// resource read can never be pointed somewhere else); the event list ships
// with the package.

export interface ResourceDefinition {
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  /** Path on the site (fetched), or `null` for content built here. */
  sitePath: string | null;
}

export const EVENTS_URI = "wuapi://webhook-events";

export const RESOURCES: ResourceDefinition[] = [
  {
    name: "openapi",
    uri: "https://wuapi.dev/openapi.json",
    title: "wuapi OpenAPI 3.1 spec",
    description: "Every endpoint of the wuapi REST API with its parameters, bodies, responses and error codes.",
    mimeType: "application/json",
    sitePath: "/openapi.json",
  },
  {
    name: "docs",
    uri: "https://wuapi.dev/llms-full.txt",
    title: "wuapi documentation (Markdown)",
    description: "The complete wuapi docs as one Markdown file: conventions, every endpoint, webhook events and signature verification.",
    mimeType: "text/markdown",
    sitePath: "/llms-full.txt",
  },
  {
    name: "docs-index",
    uri: "https://wuapi.dev/llms.txt",
    title: "wuapi docs index",
    description: "A short index of the wuapi docs with links to each section.",
    mimeType: "text/markdown",
    sitePath: "/llms.txt",
  },
  {
    name: "webhook-events",
    uri: EVENTS_URI,
    title: "wuapi webhook event types",
    description: "Every event type a webhook endpoint can subscribe to.",
    mimeType: "application/json",
    sitePath: null,
  },
];

const MAX_RESOURCE_BYTES = 5_000_000;

/** The fetch the resources use: the global one, or one injected for tests. */
export type ResourceFetch = (input: string, init: RequestInit) => Promise<Response>;

/** The text of a resource. `siteUrl` replaces `https://wuapi.dev` (for local development). */
export async function readResource(resource: ResourceDefinition, siteUrl: string, fetchImpl: ResourceFetch): Promise<string> {
  if (resource.sitePath === null) {
    return JSON.stringify({ events: WEBHOOK_EVENT_TYPES.filter((e) => e !== "webhook.test") }, null, 2);
  }
  const res = await fetchImpl(`${siteUrl}${resource.sitePath}`, { headers: { Accept: resource.mimeType }, redirect: "error" });
  if (!res.ok) throw new Error(`Could not load ${resource.uri}: HTTP ${res.status}.`);
  const text = await res.text();
  if (text.length > MAX_RESOURCE_BYTES) throw new Error(`${resource.uri} is larger than expected.`);
  return text;
}
