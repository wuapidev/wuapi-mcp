# wuapi MCP server

[![npm version](https://img.shields.io/npm/v/@wuapidev/mcp.svg)](https://www.npmjs.com/package/@wuapidev/mcp)
[![CI](https://github.com/wuapidev/wuapi-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/wuapidev/wuapi-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@wuapidev/mcp.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server for [wuapi](https://wuapi.dev), the WhatsApp API for developers. It lets Claude, Cursor, VS Code and other MCP clients use your wuapi account: send messages, link numbers, read conversations, manage groups, communities, channels, labels, profile and privacy, webhooks, projects and invitations.

Every tool is a call to the [wuapi REST API](https://wuapi.dev/docs) with your own API key, through [`@wuapidev/sdk`](https://www.npmjs.com/package/@wuapidev/sdk). The API decides what the key may do, rate limits it (600 requests per minute per key) and logs each call in your dashboard, exactly as for any other client.

Docs: [wuapi.dev/docs/mcp](https://wuapi.dev/docs/mcp).

> **How it works.** wuapi links your own numbers as devices, the same way WhatsApp Web works. It does not use the WhatsApp Business Platform. WhatsApp can restrict numbers that behave like spam: send only to people who expect your messages.

## Two ways to connect

| | Local (stdio) | Hosted (Streamable HTTP) |
|---|---|---|
| Runs | on your machine: `npx -y @wuapidev/mcp` | at `https://wuapi.dev/api/mcp` |
| Key | your `npx @wuapidev/cli login`, or the `WUAPI_API_KEY` environment variable | `Authorization: Bearer wu_live_...` header |
| Needs | Node 20 or later | a client that sends custom headers |

The quickest local setup uses the [wuapi CLI](https://www.npmjs.com/package/@wuapidev/cli): it logs you in from the browser, stores a key on your machine (`~/.config/wuapi/credentials.json`, readable only by you) and registers the server with your client, with no key in the client's config:

```sh
npx @wuapidev/cli login
npx @wuapidev/cli mcp add          # Claude Code, Cursor or VS Code
```

The local server uses `WUAPI_API_KEY` when the client sets it, and otherwise that stored login: the current profile, or the one `WUAPI_PROFILE` names (`npx @wuapidev/cli profiles` lists them). Or create an API key yourself at [wuapi.dev/app/api-keys](https://wuapi.dev/app/api-keys) and pass it as below. A project key limits the server to one project.

### Claude Code

```sh
# Local, with the key from `npx @wuapidev/cli login`
claude mcp add wuapi -- npx -y @wuapidev/mcp

# Local, with a key in the config
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

Any client that starts a local command works with `npx -y @wuapidev/mcp`, with `WUAPI_API_KEY` in its environment or after `npx @wuapidev/cli login`. Any client that connects to a remote server with a custom header works with the hosted endpoint. Clients that only connect to remote servers through OAuth, as some chat apps do, cannot use the hosted endpoint yet.

## Configuration

| Variable | |
|---|---|
| `WUAPI_API_KEY` | Your API key, `wu_live_...`. When unset, the key `npx @wuapidev/cli login` stored is used. |
| `WUAPI_PROFILE` | Which stored login to use (`npx @wuapidev/cli profiles`). Default: the current one. Its project and base URL apply unless the two variables below are set. |
| `WUAPI_PROJECT` | Act inside one project: its id or `ext:<externalId>`. Sent as `Wuapi-Project`. |
| `WUAPI_BASE_URL` | API base URL. Default `https://api.wuapi.dev`. Must be https (or http on localhost). |
| `WUAPI_MCP_READ_ONLY` | `true` registers only the tools that read. Same as the `--read-only` flag. |

The hosted endpoint takes the same options as headers: `Wuapi-Project: <id or ext:externalId>` and `Wuapi-Read-Only: true`.

## Tools

80 tools reach every operation of the REST API, except the two that return a secret and the two steps of an upload through an upload URL (see below). Tools that read are marked `readOnlyHint`. Tools that delete, revoke, reset, block or leave are marked `destructiveHint` and take `confirm: true`, which the model has to set on purpose and your client shows you before the call.

| Area | Tools |
|---|---|
| Context | `get_current_key` |
| Accounts | `list_accounts`, `get_account`, `get_account_qr_code`, `create_account`, `request_pairing_code`, `reconnect_account`, `list_proxy_locations`, `update_account`, `unlink_account`, `set_presence`, `set_disappearing_timer`, `reject_call` |
| Messages | `send_text`, `send_media`, `upload_file`, `send_location`, `send_contact`, `send_poll`, `reply_to_message`, `react_to_message`, `get_message`, `list_messages`, `edit_message`, `delete_message`, `cancel_message`, `vote_in_poll`, `forward_message`, `star_message` |
| Chats | `list_chats`, `get_chat`, `mark_chat_read`, `send_read_receipts`, `archive_chat`, `pin_chat`, `mute_chat`, `delete_chat`, `manage_labels` |
| Contacts | `list_contacts`, `get_contact`, `check_numbers`, `lookup_contacts`, `lookup_whatsapp_info`, `manage_block_list` |
| Profile | `manage_profile`, `manage_favorite_stickers`, `manage_privacy` |
| Groups | `list_groups`, `get_group`, `create_group`, `add_group_participants`, `remove_group_participants`, `promote_group_participants`, `demote_group_participants`, `get_group_invite_link`, `reset_group_invite_link`, `leave_group`, `manage_group_settings`, `manage_group_joins`, `manage_community` |
| Channels | `manage_channel` |
| Stories | `post_story`, `manage_stories` |
| Webhooks | `list_webhooks`, `get_webhook`, `create_webhook`, `update_webhook`, `delete_webhook` |
| Projects | `list_projects`, `get_project`, `create_project`, `manage_project` |
| Invitations | `create_invitation`, `list_invitations`, `get_invitation`, `cancel_invitation`, `resend_invitation`, `manage_branding` |
| Usage | `get_usage`, `get_usage_by_project` |

Resources with many small operations are one tool with an `action` argument, so the list stays short enough for a model to pick from. The tool's description lists its actions, and each field says which actions use it. Only the destructive actions (marked below) need `confirm: true`.

| Tool | Actions |
|---|---|
| `unlink_account` | `logout`\*, `delete`\* |
| `set_presence` | `online`, `offline`, `typing`, `recording`, `paused`, `subscribe` |
| `manage_labels` | `upsert`, `delete`\*, `label_chat`, `unlabel_chat`, `label_message`, `unlabel_message` |
| `lookup_whatsapp_info` | `contact_picture`, `business_profile`, `resolve_link`, `bots`, `sticker_pack`, `order` |
| `manage_block_list` | `list`, `block`\*, `unblock` |
| `manage_profile` | `update`, `set_picture`, `delete_picture`\*, `get_contact_link`, `reset_contact_link`\* |
| `manage_favorite_stickers` | `list`, `get_file`, `add`, `remove` |
| `manage_privacy` | `get`, `get_story_privacy`, `update` |
| `manage_group_settings` | `update`, `set_picture`, `delete_picture`\* |
| `manage_group_joins` | `preview_invite`, `join`, `list_requests`, `approve_requests`, `reject_requests` |
| `manage_community` | `create`, `list_groups`, `list_members`, `link_group`, `unlink_group` |
| `manage_channel` | `list`, `get`, `preview_invite`, `list_messages`, `create`, `follow`, `unfollow`, `mute`, `unmute`, `react`, `mark_viewed` |
| `manage_stories` | `list`, `list_own`, `get`, `viewers`, `view`, `react`, `reply`, `delete`\* |
| `manage_project` | `update`, `delete`\*, `list_keys`, `revoke_key`\* |
| `manage_branding` | `get`, `update` |

\* needs `confirm: true`.

To post to a channel, use `send_text` or `send_media` with `to` set to the channel id. In read-only mode a tool that mixes reads and writes keeps only its reading actions (`manage_channel` keeps `list`, `get`, `preview_invite` and `list_messages`).

`get_account_qr_code` returns the QR code as an image your client can show. Projects, invitations, branding and usage need an organization key.

Not exposed: creating a project API key and rotating a webhook endpoint's signing secret. Both return a secret exactly once, and tool results never carry secrets, so a tool would create a key or secret nobody could read (and a rotation would break your server's signature check at once). Do both in the dashboard or with the SDK. Also not exposed: completing and reading an upload. They belong to the upload-URL flow, where the file's raw bytes are posted to a URL, which a tool cannot do; `upload_file` takes the bytes in its one call and returns the upload ready to send. Sending a test webhook event and reading request logs have no public API endpoint; they are in the dashboard.

`src/operations.ts` maps every API operation to the tools that call it; a test keeps it equal to the OpenAPI spec.

## Resources and prompts

Resources: `https://wuapi.dev/openapi.json` (the OpenAPI 3.1 spec), `https://wuapi.dev/llms-full.txt` (the docs as Markdown), `https://wuapi.dev/llms.txt` (their index) and `wuapi://webhook-events` (every event type).

Prompts: `send_message` (to, message), `setup_webhook` (url, events), `invite_customer` (customer, externalId, email) and `use_streams` (project, language). `use_streams` helps you receive events with Streams, the live alternative to Webhooks for code with no public endpoint.

## Security

- The key stays where you put it: in the client's configuration, a header, or the CLI's credentials file (mode 0600), which the server only reads. The server never logs it, never returns it, and never includes it in an error.
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
