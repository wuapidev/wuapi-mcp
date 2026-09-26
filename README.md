# wuapi MCP server

[![npm version](https://img.shields.io/npm/v/@wuapidev/mcp.svg)](https://www.npmjs.com/package/@wuapidev/mcp)
[![CI](https://github.com/wuapidev/wuapi-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/wuapidev/wuapi-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@wuapidev/mcp.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server for [wuapi](https://wuapi.dev), the WhatsApp API for developers. It lets Claude, Cursor, VS Code and other MCP clients use your wuapi account: send messages, link numbers, read conversations, manage groups, webhooks, projects and invitations.

Every tool is a call to the [wuapi REST API](https://wuapi.dev/docs) with your own API key, through [`@wuapidev/sdk`](https://www.npmjs.com/package/@wuapidev/sdk). The API decides what the key may do, rate limits it (600 requests per minute per key) and logs each call in your dashboard, exactly as for any other client.

Docs: [wuapi.dev/docs/mcp](https://wuapi.dev/docs/mcp).

> **How it works.** wuapi links your own numbers as devices, the same way WhatsApp Web works. It does not use the WhatsApp Business Platform. WhatsApp can restrict numbers that behave like spam: send only to people who expect your messages.

## Two ways to connect

| | Local (stdio) | Hosted (Streamable HTTP) |
|---|---|---|
| Runs | on your machine: `npx -y @wuapidev/mcp` | at `https://wuapi.dev/api/mcp` |
| Key | `WUAPI_API_KEY` environment variable | `Authorization: Bearer wu_live_...` header |
| Needs | Node 20 or later | a client that sends custom headers |

Create an API key at [wuapi.dev/app/api-keys](https://wuapi.dev/app/api-keys). A project key limits the server to one project.

### Claude Code

```sh
# Local
claude mcp add wuapi --env WUAPI_API_KEY=wu_live_... -- npx -y @wuapidev/mcp

# Hosted
claude mcp add --transport http wuapi https://wuapi.dev/api/mcp --header "Authorization: Bearer $WUAPI_API_KEY"
```

### Claude Desktop

Settings > Developer > Edit Config, then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wuapi": {
      "command": "npx",
      "args": ["-y", "@wuapidev/mcp"],
      "env": { "WUAPI_API_KEY": "wu_live_..." }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "wuapi": {
      "command": "npx",
      "args": ["-y", "@wuapidev/mcp"],
      "env": { "WUAPI_API_KEY": "wu_live_..." }
    }
  }
}
```

Or the hosted server:

```json
{
  "mcpServers": {
    "wuapi": {
      "url": "https://wuapi.dev/api/mcp",
      "headers": { "Authorization": "Bearer wu_live_..." }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`. VS Code asks for the key once and stores it outside the file:

```json
{
  "inputs": [{ "type": "promptString", "id": "wuapi-key", "description": "wuapi API key", "password": true }],
  "servers": {
    "wuapi": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@wuapidev/mcp"],
      "env": { "WUAPI_API_KEY": "${input:wuapi-key}" }
    }
  }
}
```

For the hosted server use `"type": "http"`, `"url": "https://wuapi.dev/api/mcp"` and `"headers": { "Authorization": "Bearer ${input:wuapi-key}" }`.

### Other clients

Any client that starts a local command works with `npx -y @wuapidev/mcp` and `WUAPI_API_KEY` in its environment. Any client that connects to a remote server with a custom header works with the hosted endpoint. Clients that only connect to remote servers through OAuth, as some chat apps do, cannot use the hosted endpoint yet.

## Configuration

| Variable | |
|---|---|
| `WUAPI_API_KEY` | Required. Your API key, `wu_live_...`. |
| `WUAPI_PROJECT` | Act inside one project: its id or `ext:<externalId>`. Sent as `Wuapi-Project`. |
| `WUAPI_BASE_URL` | API base URL. Default `https://api.wuapi.dev`. Must be https (or http on localhost). |
| `WUAPI_MCP_READ_ONLY` | `true` registers only the tools that read. Same as the `--read-only` flag. |

The hosted endpoint takes the same options as headers: `Wuapi-Project: <id or ext:externalId>` and `Wuapi-Read-Only: true`.

## Tools

Tools that read are marked `readOnlyHint`. Tools that delete, revoke, cancel or leave are marked `destructiveHint` and take `confirm: true`, which the model has to set on purpose and your client shows you before the call.

| Area | Tools |
|---|---|
| Context | `get_current_key` |
| Accounts | `list_accounts`, `get_account`, `get_account_qr_code`, `create_account`, `request_pairing_code`, `reconnect_account`, `list_proxy_locations` |
| Messages | `send_text`, `send_media`, `send_location`, `send_contact`, `send_poll`, `reply_to_message`, `react_to_message`, `get_message`, `list_messages`, `edit_message`, `delete_message`, `cancel_message` |
| Chats | `mark_chat_read`, `send_read_receipts`, `archive_chat`, `pin_chat`, `mute_chat` |
| Contacts | `check_numbers`, `lookup_contacts` |
| Groups | `list_groups`, `get_group`, `create_group`, `add_group_participants`, `remove_group_participants`, `promote_group_participants`, `demote_group_participants`, `get_group_invite_link`, `reset_group_invite_link`, `leave_group` |
| Stories | `post_story` |
| Webhooks | `list_webhooks`, `create_webhook`, `update_webhook`, `delete_webhook` |
| Projects | `list_projects`, `get_project`, `create_project` |
| Invitations | `create_invitation`, `list_invitations`, `get_invitation`, `cancel_invitation` |
| Usage | `get_usage`, `get_usage_by_project` |

`get_account_qr_code` returns the QR code as an image your client can show. Projects, invitations and usage need an organization key.

Not exposed: listing chats, sending a test webhook event and reading request logs have no public API endpoint, so they are not tools. They are in the dashboard.

## Resources and prompts

Resources: `https://wuapi.dev/openapi.json` (the OpenAPI 3.1 spec), `https://wuapi.dev/llms-full.txt` (the docs as Markdown), `https://wuapi.dev/llms.txt` (their index) and `wuapi://webhook-events` (every event type).

Prompts: `send_message` (to, message), `setup_webhook` (url, events) and `invite_customer` (customer, externalId, email).

## Security

- The key stays where you put it: in the client's configuration or a header. The server never logs it, never returns it, and never includes it in an error.
- Tool results never contain secrets. A webhook endpoint's signing secret is returned by the API only once, when the endpoint is created; `create_webhook` drops it and tells you to reveal it in the dashboard instead. There is no tool that creates API keys.
- Scope the key: a project key reaches one project, and `WUAPI_MCP_READ_ONLY=true` removes every tool that writes.
- Media is fetched by the wuapi API, never by this server. The API refuses private and internal addresses.
- Every argument is validated against the tool's JSON schema before any request. A base URL that is not https is refused, so the key never travels in clear text.

## Use it as a library

```ts
import { Wuapi } from "@wuapidev/sdk";
import { createWuapiMcpServer } from "@wuapidev/mcp";
import { createWuapiMcpHttpHandler } from "@wuapidev/mcp/http";

// One server per client connection, acting as this key.
const server = createWuapiMcpServer({ client: new Wuapi({ apiKey: process.env.WUAPI_API_KEY }) });

// Or a stateless Streamable HTTP handler: (Request) => Promise<Response>,
// authenticated with each caller's own key as a bearer token.
const handle = createWuapiMcpHttpHandler();
```

## License

MIT
