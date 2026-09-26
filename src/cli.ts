#!/usr/bin/env node
// The stdio server: `npx -y @wuapidev/mcp`, started by an MCP client (Claude
// Desktop, Claude Code, Cursor, VS Code, ...) as a child process.
//
// Environment:
//   WUAPI_API_KEY        required. An organization or project key (wu_live_...).
//   WUAPI_PROJECT        optional. Act inside one project: its id or ext:<externalId>.
//   WUAPI_BASE_URL       optional. Defaults to https://api.wuapi.dev.
//   WUAPI_MCP_READ_ONLY  optional. `true` registers only the tools that read.
//
// stdout carries the protocol; every message for humans goes to stderr, and
// none of them ever contains the key.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Wuapi } from "@wuapidev/sdk";
import { parseConfig } from "./config.js";
import { createWuapiMcpServer, toolsFor } from "./server.js";
import { VERSION } from "./version.js";

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      `wuapi MCP server ${VERSION}`,
      "",
      "Usage: WUAPI_API_KEY=wu_live_... npx -y @wuapidev/mcp [--read-only]",
      "",
      "  WUAPI_API_KEY        your wuapi API key (required)",
      "  WUAPI_PROJECT        act inside one project: its id or ext:<externalId>",
      "  WUAPI_BASE_URL       API base URL (default https://api.wuapi.dev)",
      "  WUAPI_MCP_READ_ONLY  true: only the tools that read",
      "",
      "Docs: https://wuapi.dev/docs/mcp",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const config = parseConfig(process.env, args);
if (!config.ok) {
  process.stderr.write(`wuapi-mcp: ${config.error}\n`);
  process.exit(1);
}
const { apiKey, baseUrl, project, readOnly } = config.value;

serveStdio(
  () =>
    createWuapiMcpServer({
      client: new Wuapi({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...(project ? { project } : {}) }),
      readOnly,
    }),
  { onerror: (err) => process.stderr.write(`wuapi-mcp: ${err.message}\n`) },
);

process.stderr.write(
  `wuapi-mcp ${VERSION} on stdio: ${toolsFor({ readOnly }).length} tools${readOnly ? " (read-only)" : ""}${project ? `, project ${project}` : ""}\n`,
);
