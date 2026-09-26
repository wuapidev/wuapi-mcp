import type { Account, Group, Message, SendMessageParams, Wuapi } from "@wuapidev/sdk";
import { WEBHOOK_EVENT_TYPES, WuapiError } from "@wuapidev/sdk";
import * as z from "zod";
import { fail, ok, page, ToolInputError, type ContentBlock, type ToolResult } from "./format.js";

// The tool catalog. Every tool is one or two calls to the wuapi REST API
// through @wuapidev/sdk, with the caller's own API key: the API authorizes,
// rate limits, validates and logs each call exactly as it does for any other
// client. Nothing here reaches wuapi another way.
//
// Conventions:
// - snake_case names, a verb first; descriptions say when to use the tool and
//   what the ids look like.
// - Annotations: read-only tools say so; tools that delete, unlink, revoke or
//   leave are `destructiveHint: true` and take `confirm: true`, a required
//   argument the model has to set on purpose (and the user sees in the call).
// - Outputs are the API's own objects, compacted (src/format.ts): no nulls,
//   no secrets, no data URLs.

export type ToolGroup =
  | "context"
  | "accounts"
  | "messages"
  | "chats"
  | "contacts"
  | "groups"
  | "stories"
  | "webhooks"
  | "projects"
  | "invitations"
  | "usage";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  inputSchema: S;
  annotations: ToolAnnotations;
  run: (client: Wuapi, args: z.infer<S>) => Promise<ToolResult>;
}

function tool<S extends z.ZodObject>(def: ToolDefinition<S>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

// ---------------------------------------------------------------------------
// Annotation presets
// ---------------------------------------------------------------------------

/** Reads wuapi's own records. */
const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Reads live from WhatsApp through the linked number. */
const READ_LIVE: ToolAnnotations = { ...READ, openWorldHint: true };
/** Does something on WhatsApp that cannot be taken back as is: a send, a new group. */
const ACT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Sets a state on WhatsApp; repeating it changes nothing. */
const SET: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Creates or changes wuapi configuration (webhooks, projects, invitations). */
const CONFIGURE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTROY: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const DESTROY_CONFIG: ToolAnnotations = { ...DESTROY, openWorldHint: false };

// ---------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------

const id = (what: string) => z.string().trim().min(1).max(200).describe(what);
const accountId = id("The wuapi account id of the linked number to act as (from list_accounts).");
const messageId = id("A wuapi message id (from list_messages, a send tool, or a webhook).");
const chatId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("The chat: a contact as E.164 with + (`+584241112233`) or `lid:<digits>`, or a group id (`...@g.us`).");
const groupId = z.string().trim().min(1).max(200).describe("The group id (`...@g.us`), from list_groups.");
const to = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    "Recipient: a phone number in E.164 with + (`+584241112233`), `lid:<digits>`, the `@username` of a contact the account already chats with, a group id (`...@g.us`), or a channel id (`...@newsletter`) the account administers.",
  );
const projectFilter = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe("Only this project: its id, `ext:<externalId>`, or `none` for resources in no project. Organization keys only; a project key always sees its own project.");
const projectTarget = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe("Organization keys only: the project to create it in (id or `ext:<externalId>`). A project key always uses its own project.");
const limit = z.number().int().min(1).max(100).optional().describe("Page size, 1 to 100. Default 20.");
const cursor = z.string().min(1).max(1000).optional().describe("`nextCursor` from the previous page, to get the next one.");
const idempotencyKey = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .optional()
  .describe("Optional. Reuse the same key when retrying this exact call: within 24 hours wuapi returns the first result instead of doing it twice.");
const replyToMessageId = z.string().trim().min(1).max(64).optional().describe("A wuapi message id in the same chat to quote (reply to).");
const mentions = z.array(z.string().trim().min(1).max(200)).max(256).optional().describe("Contact ids to @mention (E.164 or `lid:<digits>`).");
const confirm = (what: string) =>
  z.literal(true).describe(`Must be true. ${what} Only set it after the user asked for this or agreed to it.`);
const contactIds = z
  .array(z.string().trim().min(1).max(200))
  .min(1)
  .max(256)
  .describe("Contact ids: E.164 with + (`+584241112233`) or `lid:<digits>`.");
const mediaUrl = z
  .string()
  .trim()
  .max(2048)
  .regex(/^https?:\/\//i, "Must be an http(s) URL.")
  .describe("Public http(s) URL of the file. wuapi downloads it (up to 100 MB); private and internal addresses are refused.");
const proxyLocation = z
  .object({
    country: z.string().trim().length(2).describe("ISO 3166-1 alpha-2 country code, uppercase: `US`."),
    city: z.string().trim().min(1).max(100).describe("City code from list_proxy_locations: `newyorkcity`."),
  })
  .describe("Where the number's residential proxy exits: a country and city pair from list_proxy_locations.");
const metadata = z.record(z.string().min(1).max(64), z.string().max(500)).optional().describe("Your own string values, stored with it.");
const webhookEvents = z
  .array(z.enum(WEBHOOK_EVENT_TYPES.filter((e) => e !== "webhook.test") as [string, ...string[]]))
  .min(1)
  .describe("Event types to receive, such as `message.received`, `message.sent`, `message.failed`, `account.connected`, `account.disconnected`.");

const DEFAULT_LIMIT = 20;
const listArgs = (a: { limit?: number | undefined; cursor?: string | undefined }) => ({
  limit: a.limit ?? DEFAULT_LIMIT,
  ...(a.cursor ? { cursor: a.cursor } : {}),
});
const opts = (key: string | undefined) => (key ? { idempotencyKey: key } : undefined);
/** Drop keys whose value is undefined, so optional arguments are not sent as `undefined`. */
function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** An account without its QR code image and pacing internals. */
function slimAccount(a: Account): Record<string, unknown> {
  const { qrCodeUrl, pacing: _pacing, ...rest } = a;
  return { ...rest, hasQrCode: qrCodeUrl !== null && qrCodeUrl !== undefined };
}

/** A group in a list: the participant count instead of every participant. */
function slimGroup(g: Group): Record<string, unknown> {
  const { participants, ...rest } = g;
  return { ...rest, participantCount: participants?.length ?? 0 };
}

function sent(message: Message): ToolResult {
  return ok({
    message,
    note: "Queued. It is sent at the account's pace; check it with get_message (status becomes sent, delivered, read or failed).",
  });
}

async function send(client: Wuapi, params: SendMessageParams, key: string | undefined): Promise<ToolResult> {
  return sent(await client.messages.send(params, opts(key)));
}

const sendBase = {
  accountId,
  to,
  replyToMessageId,
  mentions,
  idempotencyKey,
};

function base(a: { accountId: string; to: string; replyToMessageId?: string | undefined; mentions?: string[] | undefined }) {
  return defined({ accountId: a.accountId, to: a.to, replyToMessageId: a.replyToMessageId, mentions: a.mentions });
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const TOOLS: ToolDefinition[] = [
  // ---- context -------------------------------------------------------------
  tool({
    name: "get_current_key",
    title: "Who am I",
    group: "context",
    description:
      "The organization, API key (name and last 4 characters, never the key) and project this server acts as. Call it first when you are unsure whether the key is an organization key or a project key.",
    inputSchema: z.object({}),
    annotations: READ,
    run: async (client) => {
      const me = await client.me();
      return ok({
        organization: me.organization,
        apiKey: { id: me.apiKey.id, name: me.apiKey.name, last4: me.apiKey.last4, projectId: me.apiKey.projectId },
        project: me.project,
        scope: me.project ? "project" : "organization",
      });
    },
  }),

  // ---- accounts ------------------------------------------------------------
  tool({
    name: "list_accounts",
    title: "List accounts",
    group: "accounts",
    description:
      "List the linked WhatsApp numbers (accounts), newest first, with their status: `ready` can send; `qr_ready` waits for a QR scan; `disconnected` or `failed` need attention.",
    inputSchema: z.object({ projectId: projectFilter, limit, cursor }),
    annotations: READ,
    run: async (client, a) => page(await client.accounts.list(defined({ projectId: a.projectId, ...listArgs(a) })).page(), (x) => slimAccount(x)),
  }),
  tool({
    name: "get_account",
    title: "Get an account",
    group: "accounts",
    description:
      "One account: status, linked phone number, profile name, proxy location, disconnect reason and last error. `hasQrCode` says a QR code is waiting to be scanned (get it with get_account_qr_code).",
    inputSchema: z.object({ accountId }),
    annotations: READ,
    run: async (client, a) => ok(slimAccount(await client.accounts.get(a.accountId))),
  }),
  tool({
    name: "get_account_qr_code",
    title: "Get the QR code to link a number",
    group: "accounts",
    description:
      "The QR code to scan in WhatsApp (Settings > Linked devices > Link a device), as an image. Waits a few seconds for one when the account is still starting. QR codes rotate about every 20 seconds: call again if it expired. Returns the status instead when the account is already linked, and the pairing code when it links by phone number.",
    inputSchema: z.object({
      accountId,
      waitSeconds: z.number().int().min(0).max(30).optional().describe("How long to wait for a QR code to appear. Default 15."),
    }),
    annotations: READ,
    run: async (client, a) => {
      const waitMs = (a.waitSeconds ?? 15) * 1000;
      let account: Account;
      try {
        account = waitMs > 0 ? await client.accounts.waitForQrCode(a.accountId, { timeoutMs: waitMs, intervalMs: 2_000 }) : await client.accounts.get(a.accountId);
      } catch (err) {
        // No QR code within the wait: answer with where the account is instead.
        const last = err instanceof WuapiError && err.code === "wait_timeout" ? (err.details?.account as Account | undefined) : undefined;
        if (!last) throw err;
        account = last;
      }
      if (account.status === "ready") return ok({ status: "ready", phone: account.phone, note: "Already linked. Nothing to scan." });
      if (account.pairingCode) {
        return ok({ status: account.status, pairingCode: account.pairingCode, pairingCodeExpiresAt: account.pairingCodeExpiresAt, note: pairingInstructions });
      }
      const qr = account.qrCodeUrl ? /^data:(image\/[a-z]+);base64,(.+)$/.exec(account.qrCodeUrl) : null;
      if (!qr) return ok({ status: account.status, note: "No QR code yet. Call again in a few seconds." });
      const image: ContentBlock = { type: "image", mimeType: qr[1]!, data: qr[2]! };
      return ok(
        { status: account.status, note: "Scan it in WhatsApp: Settings > Linked devices > Link a device. It rotates about every 20 seconds." },
        [image],
      );
    },
  }),
  tool({
    name: "create_account",
    title: "Connect a new number",
    group: "accounts",
    description:
      "Start linking a new WhatsApp number. Pick `proxyLocation` with list_proxy_locations (near where the phone is). Then show the QR code with get_account_qr_code, or pass `pairingPhone` to link with an 8-character pairing code instead. A linked number is billable; a new organization links its first number with no card. To let someone else link their own number, use create_invitation.",
    inputSchema: z.object({
      proxyLocation,
      name: z.string().trim().min(1).max(100).optional().describe("A name for the account, such as `Front desk`."),
      pairingPhone: z.string().trim().min(4).max(32).optional().describe("Link by pairing code instead of QR code: the number to link, E.164."),
      projectId: projectTarget,
      historySync: z.enum(["none", "recent"]).optional().describe("`recent` imports the chats the phone sends right after linking. Default `none`."),
      idempotencyKey,
    }),
    annotations: CONFIGURE,
    run: async (client, a) => {
      const account = await client.accounts.create(
        defined({ proxyLocation: a.proxyLocation, name: a.name, pairingPhone: a.pairingPhone, projectId: a.projectId, historySync: a.historySync }),
        opts(a.idempotencyKey),
      );
      return ok({
        account: slimAccount(account),
        next: a.pairingPhone
          ? "Call get_account_qr_code in a few seconds: it returns the pairing code to type on the phone."
          : "Call get_account_qr_code and show the QR code to the phone's owner.",
      });
    },
  }),
  tool({
    name: "request_pairing_code",
    title: "Get a pairing code",
    group: "accounts",
    description:
      "Link by phone number instead of QR code: returns an 8-character code the owner types in WhatsApp. It lives about 160 seconds. Fails with `already_linked` when the account is ready.",
    inputSchema: z.object({
      accountId,
      phone: z.string().trim().min(4).max(32).describe("The number to link, E.164 (`+584121234567`) or digits."),
    }),
    annotations: ACT,
    run: async (client, a) => {
      const code = await client.accounts.createPairingCode(a.accountId, { phone: a.phone });
      return ok({ pairingCode: code.code, expiresAt: code.expiresAt, note: pairingInstructions });
    },
  }),
  tool({
    name: "reconnect_account",
    title: "Reconnect an account",
    group: "accounts",
    description: "Restart the account's session. Use it when an account is `disconnected`; when the link is no longer valid it produces a fresh QR code.",
    inputSchema: z.object({ accountId }),
    annotations: SET,
    run: async (client, a) => ok(slimAccount(await client.accounts.reconnect(a.accountId))),
  }),
  tool({
    name: "list_proxy_locations",
    title: "List proxy locations",
    group: "accounts",
    description: "Countries and cities a new number's proxy can exit from, for create_account and create_invitation. Search with `q` (`sao` finds Sao Paulo) or filter by `country`.",
    inputSchema: z.object({
      q: z.string().trim().min(1).max(100).optional().describe("City or country name or code."),
      country: z.string().trim().length(2).optional().describe("ISO 3166-1 alpha-2 country code."),
      limit,
      cursor,
    }),
    annotations: READ,
    run: async (client, a) => page(await client.proxyLocations.list(defined({ q: a.q, country: a.country, ...listArgs(a) })).page()),
  }),

  // ---- messages ------------------------------------------------------------
  tool({
    name: "send_text",
    title: "Send a text message",
    group: "messages",
    description:
      "Send a text message from a linked number to a contact, group or channel. The message is queued and sent at the account's pace; the result has its id and `queued` status. Send only to people who expect it.",
    inputSchema: z.object({
      ...sendBase,
      text: z.string().min(1).max(4096).describe("The message, up to 4096 characters. WhatsApp formatting works: *bold*, _italic_."),
    }),
    annotations: ACT,
    run: (client, a) => send(client, { ...base(a), type: "text", text: a.text }, a.idempotencyKey),
  }),
  tool({
    name: "send_media",
    title: "Send an image, video, audio or document",
    group: "messages",
    description:
      "Send a file from a public URL: an image, video, audio, voice note (ogg/opus), document or sticker, with an optional caption. wuapi downloads the URL itself.",
    inputSchema: z.object({
      ...sendBase,
      type: z.enum(["image", "video", "audio", "voice", "document", "sticker"]).describe("What kind of file it is."),
      url: mediaUrl,
      caption: z.string().max(4096).optional().describe("Text shown with the file."),
      mimeType: z.string().trim().max(255).optional().describe("Guessed from the URL when omitted."),
      filename: z.string().trim().max(255).optional().describe("Documents: the file name the recipient sees."),
      viewOnce: z.boolean().optional().describe("Images, videos, audio and voice: can be opened once."),
    }),
    annotations: ACT,
    run: (client, a) => {
      const media = defined({ url: a.url, mimeType: a.mimeType, filename: a.filename });
      const viewOnce = a.type === "image" || a.type === "video" || a.type === "audio" || a.type === "voice" ? a.viewOnce : undefined;
      const params = defined({ ...base(a), type: a.type, media, text: a.caption, viewOnce }) as SendMessageParams;
      return send(client, params, a.idempotencyKey);
    },
  }),
  tool({
    name: "send_location",
    title: "Send a location",
    group: "messages",
    description: "Send a map pin, with an optional place name and address.",
    inputSchema: z.object({
      ...sendBase,
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      name: z.string().trim().max(200).optional().describe("Place name."),
      address: z.string().trim().max(500).optional(),
    }),
    annotations: ACT,
    run: (client, a) =>
      send(
        client,
        { ...base(a), type: "location", location: defined({ latitude: a.latitude, longitude: a.longitude, name: a.name, address: a.address }) },
        a.idempotencyKey,
      ),
  }),
  tool({
    name: "send_contact",
    title: "Send contact cards",
    group: "messages",
    description: "Send one contact card, or up to 20 in one message.",
    inputSchema: z.object({
      ...sendBase,
      contacts: z
        .array(z.object({ name: z.string().trim().min(1).max(200), phone: z.string().trim().min(4).max(32).describe("E.164 with +.") }))
        .min(1)
        .max(20),
    }),
    annotations: ACT,
    run: (client, a) => {
      const [first, ...more] = a.contacts;
      const params: SendMessageParams =
        more.length === 0 && first ? { ...base(a), type: "contact", contact: first } : { ...base(a), type: "contacts", contacts: a.contacts };
      return send(client, params, a.idempotencyKey);
    },
  }),
  tool({
    name: "send_poll",
    title: "Send a poll",
    group: "messages",
    description: "Send a poll with 2 to 12 options. Votes arrive as `poll.voted` webhooks and in the message's poll tally (get_message).",
    inputSchema: z.object({
      ...sendBase,
      question: z.string().trim().min(1).max(255).describe("The poll question."),
      options: z.array(z.string().trim().min(1).max(100)).min(2).max(12).describe("2 to 12 unique options."),
      selectableCount: z.number().int().min(0).max(12).optional().describe("How many options a voter may pick. 0 (default) means any number; 1 makes it single choice."),
    }),
    annotations: ACT,
    run: (client, a) =>
      send(client, { ...base(a), type: "poll", poll: defined({ name: a.question, options: a.options, selectableCount: a.selectableCount }) }, a.idempotencyKey),
  }),
  tool({
    name: "reply_to_message",
    title: "Reply to a message",
    group: "messages",
    description: "Reply with text to a message, quoting it, in the same chat and from the same account. Works for messages in direct chats and groups.",
    inputSchema: z.object({
      messageId,
      text: z.string().min(1).max(4096).describe("The reply."),
      idempotencyKey,
    }),
    annotations: ACT,
    run: async (client, a) => {
      const original = await client.messages.get(a.messageId);
      if (original.chatType === "channel" || original.chatType === "story") {
        throw new ToolInputError("Replies work in direct chats and groups only, not on channel posts or stories.");
      }
      return send(client, { accountId: original.accountId, to: original.chatId, type: "text", text: a.text, replyToMessageId: original.id }, a.idempotencyKey);
    },
  }),
  tool({
    name: "react_to_message",
    title: "React to a message",
    group: "messages",
    description: "React to a message with an emoji, as the account that received or sent it. An empty string removes the reaction.",
    inputSchema: z.object({
      messageId,
      emoji: z.string().max(32).describe("One emoji, such as a thumbs up. Empty removes the reaction."),
    }),
    annotations: SET,
    run: async (client, a) => {
      await client.messages.react(a.messageId, a.emoji);
      return ok({ messageId: a.messageId, emoji: a.emoji, reacted: a.emoji !== "" });
    },
  }),
  tool({
    name: "get_message",
    title: "Get a message",
    group: "messages",
    description: "One message with its status (`queued`, `sent`, `delivered`, `read`, `failed`, or `received` for inbound), content, and error when it failed.",
    inputSchema: z.object({ messageId }),
    annotations: READ,
    run: async (client, a) => ok(await client.messages.get(a.messageId)),
  }),
  tool({
    name: "list_messages",
    title: "List messages",
    group: "messages",
    description:
      "Messages wuapi stored, newest first: sent and received. Filter by account, chat and direction to read a conversation. There is no endpoint that lists chats; recent messages show who wrote.",
    inputSchema: z.object({
      accountId: accountId.optional(),
      chatId: chatId.optional(),
      direction: z.enum(["inbound", "outbound"]).optional(),
      projectId: projectFilter,
      limit,
      cursor,
    }),
    annotations: READ,
    run: async (client, a) =>
      page(await client.messages.list(defined({ accountId: a.accountId, chatId: a.chatId, direction: a.direction, projectId: a.projectId, ...listArgs(a) })).page()),
  }),
  tool({
    name: "edit_message",
    title: "Edit a sent text message",
    group: "messages",
    description: "Change the text of an outbound text message, within WhatsApp's edit window (about 15 minutes). A message still queued is sent with the new text.",
    inputSchema: z.object({ messageId, text: z.string().min(1).max(4096).describe("The new text.") }),
    annotations: SET,
    run: async (client, a) => ok(await client.messages.edit(a.messageId, a.text)),
  }),
  tool({
    name: "delete_message",
    title: "Delete a message",
    group: "messages",
    description:
      "Delete an outbound message for everyone (or only on the linked devices with `forEveryone: false`). A message still queued is cancelled instead and never sent. This cannot be undone.",
    inputSchema: z.object({
      messageId,
      forEveryone: z.boolean().optional().describe("Default true: delete it for every participant."),
      confirm: confirm("Deleting a message cannot be undone."),
    }),
    annotations: DESTROY,
    run: async (client, a) => {
      await client.messages.delete(a.messageId, defined({ forEveryone: a.forEveryone }));
      return ok({ messageId: a.messageId, deleted: true });
    },
  }),
  tool({
    name: "cancel_message",
    title: "Cancel a queued message",
    group: "messages",
    description:
      "Stop a message that is still `queued` from being sent. It ends `failed` with error code `cancelled`. Fails with `not_queued` when the message already left; use delete_message for those.",
    inputSchema: z.object({ messageId, confirm: confirm("The message will not be sent.") }),
    annotations: DESTROY,
    run: async (client, a) => {
      const message = await client.messages.get(a.messageId);
      if (message.status !== "queued") {
        return fail("not_queued", `The message is already ${message.status}; only queued messages can be cancelled. Use delete_message to delete it.`);
      }
      await client.messages.delete(a.messageId);
      return ok({ messageId: a.messageId, cancelled: true });
    },
  }),

  // ---- chats ---------------------------------------------------------------
  tool({
    name: "mark_chat_read",
    title: "Mark a chat read or unread",
    group: "chats",
    description: "Clear (or set, with `unread: true`) the chat's unread badge on the linked devices. Sends no read receipts; use send_read_receipts for blue ticks.",
    inputSchema: z.object({ accountId, chatId, unread: z.boolean().optional().describe("Mark it unread instead.") }),
    annotations: SET,
    run: async (client, a) => {
      if (a.unread) await client.chats.markUnread(a.accountId, a.chatId);
      else await client.chats.markRead(a.accountId, a.chatId);
      return ok({ accountId: a.accountId, chatId: a.chatId, unread: Boolean(a.unread) });
    },
  }),
  tool({
    name: "send_read_receipts",
    title: "Send read receipts",
    group: "chats",
    description: "Send read receipts (blue ticks) for inbound messages in a chat: the given ids, or every unread inbound message wuapi stores for it.",
    inputSchema: z.object({
      accountId,
      chatId,
      messageIds: z.array(z.string().trim().min(1).max(64)).max(500).optional().describe("wuapi ids of inbound messages in this chat. Default: every unread one."),
    }),
    annotations: SET,
    run: async (client, a) => ok(await client.chats.sendReadReceipts(a.accountId, a.chatId, defined({ messageIds: a.messageIds }))),
  }),
  tool({
    name: "archive_chat",
    title: "Archive or unarchive a chat",
    group: "chats",
    description: "Archive a chat on the linked devices, or unarchive it with `archived: false`.",
    inputSchema: z.object({ accountId, chatId, archived: z.boolean().optional().describe("Default true.") }),
    annotations: SET,
    run: async (client, a) => {
      const archived = a.archived ?? true;
      if (archived) await client.chats.archive(a.accountId, a.chatId);
      else await client.chats.unarchive(a.accountId, a.chatId);
      return ok({ accountId: a.accountId, chatId: a.chatId, archived });
    },
  }),
  tool({
    name: "pin_chat",
    title: "Pin or unpin a chat",
    group: "chats",
    description: "Pin a chat to the top on the linked devices, or unpin it with `pinned: false`.",
    inputSchema: z.object({ accountId, chatId, pinned: z.boolean().optional().describe("Default true.") }),
    annotations: SET,
    run: async (client, a) => {
      const pinned = a.pinned ?? true;
      if (pinned) await client.chats.pin(a.accountId, a.chatId);
      else await client.chats.unpin(a.accountId, a.chatId);
      return ok({ accountId: a.accountId, chatId: a.chatId, pinned });
    },
  }),
  tool({
    name: "mute_chat",
    title: "Mute or unmute a chat",
    group: "chats",
    description: "Mute a chat's notifications for a while or until unmuted, or unmute it with `muted: false`.",
    inputSchema: z.object({
      accountId,
      chatId,
      muted: z.boolean().optional().describe("Default true."),
      durationSeconds: z.number().int().min(0).max(315_360_000).optional().describe("How long to mute. Omitted or 0: until unmuted."),
    }),
    annotations: SET,
    run: async (client, a) => {
      const muted = a.muted ?? true;
      if (muted) await client.chats.mute(a.accountId, a.chatId, defined({ durationSeconds: a.durationSeconds }));
      else await client.chats.unmute(a.accountId, a.chatId);
      return ok({ accountId: a.accountId, chatId: a.chatId, muted });
    },
  }),

  // ---- contacts ------------------------------------------------------------
  tool({
    name: "check_numbers",
    title: "Check numbers on WhatsApp",
    group: "contacts",
    description: "Which of these phone numbers have WhatsApp, with their contact id, business name and username when known. Check before sending to a new number.",
    inputSchema: z.object({
      accountId,
      phones: z.array(z.string().trim().min(4).max(32)).min(1).max(50).describe("1 to 50 numbers, E.164 (`+584241112233`) or digits."),
    }),
    annotations: READ_LIVE,
    run: async (client, a) => ok({ items: await client.contacts.check(a.accountId, a.phones) }),
  }),
  tool({
    name: "lookup_contacts",
    title: "Look up contacts",
    group: "contacts",
    description:
      "About text, WhatsApp username, business name and device count of 1 to 50 contacts. Usernames cannot be searched: WhatsApp does not let a linked device resolve an @username, so look contacts up by number or `lid:` id.",
    inputSchema: z.object({
      accountId,
      contactIds: z.array(z.string().trim().min(1).max(200)).min(1).max(50).describe("1 to 50 contact ids: E.164, digits or `lid:<digits>`."),
    }),
    annotations: READ_LIVE,
    run: async (client, a) => ok({ items: await client.contacts.lookup(a.accountId, a.contactIds) }),
  }),

  // ---- groups --------------------------------------------------------------
  tool({
    name: "list_groups",
    title: "List groups",
    group: "groups",
    description: "Every group the account is in, read live from WhatsApp, with the participant count. Use get_group for the participants.",
    inputSchema: z.object({ accountId, limit, cursor }),
    annotations: READ_LIVE,
    run: async (client, a) => page(await client.groups.list(a.accountId, listArgs(a)).page(), (g) => slimGroup(g)),
  }),
  tool({
    name: "get_group",
    title: "Get a group",
    group: "groups",
    description: "A group's name, description, settings and participants with their roles (member, admin, owner).",
    inputSchema: z.object({ accountId, groupId }),
    annotations: READ_LIVE,
    run: async (client, a) => ok(await client.groups.get(a.accountId, a.groupId)),
  }),
  tool({
    name: "create_group",
    title: "Create a group",
    group: "groups",
    description: "Create a WhatsApp group with the account as owner. Participants whose privacy settings refuse being added get an invite code instead (see the result).",
    inputSchema: z.object({
      accountId,
      name: z.string().trim().min(1).max(100).describe("The group name."),
      participants: contactIds.describe("Contact ids to add: E.164 with + or `lid:<digits>`."),
      idempotencyKey,
    }),
    annotations: ACT,
    run: async (client, a) => ok(await client.groups.create(a.accountId, { name: a.name, participants: a.participants }, opts(a.idempotencyKey))),
  }),
  tool({
    name: "add_group_participants",
    title: "Add people to a group",
    group: "groups",
    description: "Add participants to a group the account administers. Each result says whether it worked; someone who cannot be added directly comes back with an invite code.",
    inputSchema: z.object({ accountId, groupId, contactIds }),
    annotations: ACT,
    run: async (client, a) => ok({ items: await client.groups.addParticipants(a.accountId, a.groupId, a.contactIds) }),
  }),
  tool({
    name: "remove_group_participants",
    title: "Remove people from a group",
    group: "groups",
    description: "Remove participants from a group the account administers.",
    inputSchema: z.object({ accountId, groupId, contactIds, confirm: confirm("Removed participants have to be added or invited again.") }),
    annotations: DESTROY,
    run: async (client, a) => ok({ items: await client.groups.removeParticipants(a.accountId, a.groupId, a.contactIds) }),
  }),
  tool({
    name: "promote_group_participants",
    title: "Make participants admins",
    group: "groups",
    description: "Make participants admins of a group the account administers.",
    inputSchema: z.object({ accountId, groupId, contactIds }),
    annotations: SET,
    run: async (client, a) => ok({ items: await client.groups.promoteParticipants(a.accountId, a.groupId, a.contactIds) }),
  }),
  tool({
    name: "demote_group_participants",
    title: "Remove admin rights",
    group: "groups",
    description: "Turn group admins back into regular members.",
    inputSchema: z.object({ accountId, groupId, contactIds }),
    annotations: SET,
    run: async (client, a) => ok({ items: await client.groups.demoteParticipants(a.accountId, a.groupId, a.contactIds) }),
  }),
  tool({
    name: "get_group_invite_link",
    title: "Get a group's invite link",
    group: "groups",
    description: "The group's `https://chat.whatsapp.com/...` invite link. The account must be an admin.",
    inputSchema: z.object({ accountId, groupId }),
    annotations: READ_LIVE,
    run: async (client, a) => ok(await client.groups.getInviteLink(a.accountId, a.groupId)),
  }),
  tool({
    name: "reset_group_invite_link",
    title: "Reset a group's invite link",
    group: "groups",
    description: "Revoke the group's invite link and return a new one. Anyone holding the old link can no longer join with it.",
    inputSchema: z.object({ accountId, groupId, confirm: confirm("The old invite link stops working.") }),
    annotations: { ...DESTROY, idempotentHint: false },
    run: async (client, a) => ok(await client.groups.resetInviteLink(a.accountId, a.groupId)),
  }),
  tool({
    name: "leave_group",
    title: "Leave a group",
    group: "groups",
    description: "Make the account leave a group. To come back it has to be added or invited again.",
    inputSchema: z.object({ accountId, groupId, confirm: confirm("The account leaves the group.") }),
    annotations: DESTROY,
    run: async (client, a) => {
      await client.groups.leave(a.accountId, a.groupId);
      return ok({ accountId: a.accountId, groupId: a.groupId, left: true });
    },
  }),

  // ---- stories -------------------------------------------------------------
  tool({
    name: "post_story",
    title: "Post a story",
    group: "stories",
    description: "Post a story from the account: text on a colored background, or an image or video from a public URL with an optional caption.",
    inputSchema: z.object({
      accountId,
      type: z.enum(["text", "image", "video"]).optional().describe("Default `text`."),
      text: z.string().max(4096).optional().describe("The story text (required for `text`), or the caption."),
      mediaUrl: mediaUrl.optional().describe("Image or video: public http(s) URL of the file."),
      backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Text stories: `#RRGGBB`."),
      idempotencyKey,
    }),
    annotations: ACT,
    run: async (client, a) => {
      const type = a.type ?? "text";
      if (type === "text") {
        if (!a.text || !a.text.trim()) throw new ToolInputError("A text story needs `text`.");
        return ok({ message: await client.stories.create(a.accountId, defined({ type, text: a.text, backgroundColor: a.backgroundColor }), opts(a.idempotencyKey)) });
      }
      if (!a.mediaUrl) throw new ToolInputError(`An ${type} story needs \`mediaUrl\`.`);
      return ok({ message: await client.stories.create(a.accountId, defined({ type, media: { url: a.mediaUrl }, text: a.text }), opts(a.idempotencyKey)) });
    },
  }),

  // ---- webhooks ------------------------------------------------------------
  tool({
    name: "list_webhooks",
    title: "List webhook endpoints",
    group: "webhooks",
    description: "The webhook endpoints that receive events: URL, events and whether active. Signing secrets are never shown here.",
    inputSchema: z.object({ projectId: projectFilter, limit, cursor }),
    annotations: READ,
    run: async (client, a) => page(await client.webhookEndpoints.list(defined({ projectId: a.projectId, ...listArgs(a) })).page()),
  }),
  tool({
    name: "create_webhook",
    title: "Create a webhook endpoint",
    group: "webhooks",
    description:
      "Register a public https URL to receive events as signed POST requests. The signing secret is not returned through this tool, to keep it out of the conversation: the user reveals it in the wuapi dashboard (Webhooks, rotate the endpoint's secret) and stores it with their server.",
    inputSchema: z.object({
      url: z.string().trim().max(2048).regex(/^https:\/\//i, "Must be an https URL.").describe("Public https URL that answers 2xx within 10 seconds."),
      events: webhookEvents,
      projectId: projectTarget,
      idempotencyKey,
    }),
    annotations: CONFIGURE,
    run: async (client, a) => {
      const endpoint = await client.webhookEndpoints.create(defined({ url: a.url, events: a.events as never, projectId: a.projectId }), opts(a.idempotencyKey));
      return ok({ endpoint, signingSecret: webhookSecretNote });
    },
  }),
  tool({
    name: "update_webhook",
    title: "Update a webhook endpoint",
    group: "webhooks",
    description: "Change a webhook endpoint's URL or events, or pause it (`active: false`) and resume it.",
    inputSchema: z.object({
      webhookEndpointId: id("The webhook endpoint id, from list_webhooks."),
      url: z.string().trim().max(2048).regex(/^https:\/\//i, "Must be an https URL.").optional(),
      events: webhookEvents.optional(),
      active: z.boolean().optional(),
    }),
    annotations: { ...CONFIGURE, idempotentHint: true },
    run: async (client, a) => {
      if (a.url === undefined && a.events === undefined && a.active === undefined) throw new ToolInputError("Pass at least one of url, events or active.");
      return ok(await client.webhookEndpoints.update(a.webhookEndpointId, defined({ url: a.url, events: a.events as never, active: a.active })));
    },
  }),
  tool({
    name: "delete_webhook",
    title: "Delete a webhook endpoint",
    group: "webhooks",
    description: "Delete a webhook endpoint. Its events stop at once, including deliveries still retrying.",
    inputSchema: z.object({
      webhookEndpointId: id("The webhook endpoint id, from list_webhooks."),
      confirm: confirm("The endpoint stops receiving events."),
    }),
    annotations: DESTROY_CONFIG,
    run: async (client, a) => {
      await client.webhookEndpoints.delete(a.webhookEndpointId);
      return ok({ webhookEndpointId: a.webhookEndpointId, deleted: true });
    },
  }),

  // ---- projects ------------------------------------------------------------
  tool({
    name: "list_projects",
    title: "List projects",
    group: "projects",
    description: "Projects: one per customer of a platform, each with its own numbers, keys, webhooks and usage. Organization keys only.",
    inputSchema: z.object({
      externalId: z.string().trim().min(1).max(128).optional().describe("Exact match on your own customer id."),
      status: z.enum(["active", "suspended"]).optional(),
      limit,
      cursor,
    }),
    annotations: READ,
    run: async (client, a) => page(await client.projects.list(defined({ externalId: a.externalId, status: a.status, ...listArgs(a) })).page()),
  }),
  tool({
    name: "get_project",
    title: "Get a project",
    group: "projects",
    description: "One project: name, external id, status, account limit and count. Organization keys only.",
    inputSchema: z.object({ projectId: id("The project id or `ext:<externalId>`.") }),
    annotations: READ,
    run: async (client, a) => ok(await client.projects.get(a.projectId)),
  }),
  tool({
    name: "create_project",
    title: "Create a project",
    group: "projects",
    description:
      "Create a project for one of your customers. Set `externalId` to your own customer id so you can address it as `ext:<externalId>`. Then invite the customer to link their number with create_invitation. Organization keys only.",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(100),
      externalId: z.string().regex(/^[A-Za-z0-9._:@-]{1,128}$/).optional().describe("Your id for this customer: letters, digits and `. _ : @ -`."),
      maxAccounts: z.number().int().min(0).max(10_000).optional().describe("How many numbers it may link. Omitted: no limit."),
      metadata,
      idempotencyKey,
    }),
    annotations: CONFIGURE,
    run: async (client, a) =>
      ok(await client.projects.create(defined({ name: a.name, externalId: a.externalId, maxAccounts: a.maxAccounts, metadata: a.metadata }), opts(a.idempotencyKey))),
  }),

  // ---- invitations ---------------------------------------------------------
  tool({
    name: "create_invitation",
    title: "Invite someone to link their number",
    group: "invitations",
    description:
      "Create a branded page (`url`) where a customer links their own WhatsApp number to your project by QR code or pairing code, without an account on wuapi. Send them the `url`: it is returned only here. With `inviteeEmail`, wuapi can email it too.",
    inputSchema: z.object({
      projectId: projectTarget,
      accountName: z.string().trim().max(100).optional().describe("Name of the account created when they finish."),
      inviteeName: z.string().trim().max(100).optional(),
      inviteeEmail: z.string().trim().email().max(254).optional(),
      inviteePhone: z.string().trim().max(32).optional().describe("E.164."),
      suggestedCountry: z.string().trim().length(2).optional().describe("ISO country preselected on the page."),
      proxyLocation: proxyLocation.optional().describe("Preset the proxy location. Without it the invitee picks the country and city."),
      methods: z.array(z.enum(["qr_code", "pairing_code"])).min(1).optional().describe("How they may link. Default both."),
      historySync: z.enum(["none", "recent"]).optional(),
      returnUrl: z.string().trim().max(2048).regex(/^https:\/\//i, "Must be an https URL.").optional().describe("Where the page sends them when done."),
      expiresInDays: z.number().int().min(1).max(30).optional().describe("1 to 30. Default 7."),
      idempotencyKey,
    }),
    annotations: CONFIGURE,
    run: async (client, a) => {
      const { idempotencyKey: key, ...params } = a;
      return ok(await client.invitations.create(defined(params), opts(key)));
    },
  }),
  tool({
    name: "list_invitations",
    title: "List invitations",
    group: "invitations",
    description: "Invitations and their status: `pending`, `in_progress`, `completed` (with the new `accountId`), `failed`, `cancelled` or `expired`.",
    inputSchema: z.object({
      projectId: projectFilter,
      status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled", "expired"]).optional(),
      limit,
      cursor,
    }),
    annotations: READ,
    run: async (client, a) => page(await client.invitations.list(defined({ projectId: a.projectId, status: a.status, ...listArgs(a) })).page()),
  }),
  tool({
    name: "get_invitation",
    title: "Get an invitation",
    group: "invitations",
    description: "One invitation's status, and the linked `accountId` once completed.",
    inputSchema: z.object({ invitationId: id("The invitation id.") }),
    annotations: READ,
    run: async (client, a) => ok(await client.invitations.get(a.invitationId)),
  }),
  tool({
    name: "cancel_invitation",
    title: "Cancel an invitation",
    group: "invitations",
    description: "Cancel an invitation: its link stops working. Completed invitations cannot be cancelled.",
    inputSchema: z.object({ invitationId: id("The invitation id."), confirm: confirm("The invitation link stops working.") }),
    annotations: DESTROY_CONFIG,
    run: async (client, a) => ok(await client.invitations.cancel(a.invitationId)),
  }),

  // ---- usage ---------------------------------------------------------------
  tool({
    name: "get_usage",
    title: "Get this month's usage",
    group: "usage",
    description: "The current month's bill so far: billable numbers, proxy traffic, and the total in cents (USD). Organization keys only.",
    inputSchema: z.object({}),
    annotations: READ,
    run: async (client) => ok(await client.usage.get()),
  }),
  tool({
    name: "get_usage_by_project",
    title: "Get usage per project",
    group: "usage",
    description:
      "Numbers, proxy traffic and messages sent and received per project for a month, for rebilling your customers. With `projectId`, that project only. Organization keys only.",
    inputSchema: z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe("`YYYY-MM` in UTC. Default: the current month."),
      projectId: z.string().trim().min(1).max(200).optional().describe("One project: its id or `ext:<externalId>`."),
    }),
    annotations: READ,
    run: async (client, a) => {
      const params = defined({ month: a.month });
      if (a.projectId) return ok(await client.projects.getUsage(a.projectId, params));
      return ok(await client.usage.byProject(params));
    },
  }),
];

const pairingInstructions =
  "On the phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead, then type the code. It expires in about 160 seconds.";

const webhookSecretNote =
  "Not shown here. In the wuapi dashboard, open Webhooks, rotate this endpoint's secret to reveal a new one, and store it on your server to verify the Wuapi-Signature header.";

export const TOOL_GROUPS: ToolGroup[] = [
  "context",
  "accounts",
  "messages",
  "chats",
  "contacts",
  "groups",
  "stories",
  "webhooks",
  "projects",
  "invitations",
  "usage",
];
