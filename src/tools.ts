import type { Account, AccountUpdateParams, Chat, Group, Message, PictureInput, SendMessageParams, Wuapi } from "@wuapidev/sdk";
import { WEBHOOK_EVENT_TYPES, WuapiError } from "@wuapidev/sdk";
import * as z from "zod";
import { actionTool, type ActionToolInfo } from "./actions.js";
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
  | "profile"
  | "groups"
  | "channels"
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
  /** Tools with an `action` (src/actions.ts): the actions and the exact input they are parsed with. */
  actions?: ActionToolInfo;
  /** A tool mixing reads and writes: the same tool with only its reading actions, for read-only servers. */
  readOnlyVariant?: ToolDefinition;
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
const uploadId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe("The id of an upload made with upload_file (or `POST /v1/uploads`): a file wuapi already stores. Usable for 24 hours, any number of times.");
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

const contactId = z.string().trim().min(1).max(200).describe("A contact: E.164 with + (`+584241112233`) or `lid:<digits>`.");
const channelId = z.string().trim().min(1).max(200).describe("The channel id (`...@newsletter`), from manage_channel `list`.");
const communityId = z.string().trim().min(1).max(200).describe("The community's group id (`...@g.us`), from list_groups (`community: true`).");
const pictureUrl = z
  .string()
  .trim()
  .max(2048)
  .regex(/^https:\/\//i, "Must be an https URL.")
  .describe("The picture as a public https URL of a JPEG. wuapi downloads it. Pass this or `pictureBase64`.");
const pictureBase64 = z.string().trim().min(1).max(5_000_000).describe("The picture as a base64 JPEG. Pass this or `pictureUrl`.");
const inviteCode = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe("The invite code, or the full invite link (`https://chat.whatsapp.com/...`, `https://whatsapp.com/channel/...`).");
const disappearingSeconds = z
  .literal([0, 86_400, 604_800, 7_776_000])
  .describe("How long messages last: 86400 (24 hours), 604800 (7 days) or 7776000 (90 days). 0 turns disappearing messages off.");
const privacyAudience = z.enum(["all", "contacts", "contact_blacklist", "none"]);
const nullableHttpsUrl = z.string().trim().max(2048).regex(/^https:\/\//i, "Must be an https URL.").nullable();
const pacingUpdate = z
  .object({
    messagesPerMinute: z.number().int().min(0).max(30).nullable().optional().describe("0 to 30 messages per minute. 0 turns the cap off; null resets it (off)."),
    firstContactPerMinute: z
      .number()
      .int()
      .min(0)
      .max(30)
      .nullable()
      .optional()
      .describe("Messages per minute to contacts the account never wrote to, up to `messagesPerMinute`. 0 turns the cap off; null resets it."),
    typing: z
      .object({
        enabled: z.boolean().nullable().optional().describe("Show typing before each message."),
        minMs: z.number().int().min(0).max(10_000).nullable().optional().describe("Shortest typing time, 0 to 10000 ms."),
        maxMs: z.number().int().min(0).max(20_000).nullable().optional().describe("Longest typing time, `minMs` to 20000 ms."),
        charsPerSecond: z.number().int().min(5).max(100).nullable().optional().describe("Typing speed, 5 to 100."),
      })
      .nullable()
      .optional()
      .describe("The typing indicator before each message. Fields you pass are merged; null resets."),
    queueTimeoutMinutes: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .nullable()
      .optional()
      .describe("How long a message may wait for the account to be ready before it fails, 1 to 1440. null resets it to 60."),
  })
  .nullable()
  .describe(
    "Anti-ban pacing, merged over the stored values: omitted fields keep theirs, null resets the whole pacing to the defaults (every protection off). Recommended for bulk, cold or marketing sends: `{\"messagesPerMinute\": 12, \"firstContactPerMinute\": 5, \"typing\": {\"enabled\": true}}`.",
  );

/** The last part of an invite link, or the code as given. */
function inviteCodeOf(input: string): string {
  if (!/^https?:\/\//i.test(input)) return input;
  try {
    return new URL(input).pathname.split("/").filter(Boolean).at(-1) ?? input;
  } catch {
    return input;
  }
}

/** Exactly one of a picture URL or base64 JPEG. */
function pictureInput(a: { pictureUrl?: string | undefined; pictureBase64?: string | undefined }): PictureInput {
  if (a.pictureUrl && a.pictureBase64) throw new ToolInputError("Pass `pictureUrl` or `pictureBase64`, not both.");
  if (a.pictureUrl) return { url: a.pictureUrl };
  if (a.pictureBase64) return { base64: a.pictureBase64 };
  throw new ToolInputError("Pass the picture as `pictureUrl` or `pictureBase64`.");
}

/** The defined values, or a ToolInputError when there is none. */
function changes<T extends Record<string, unknown>>(value: T, fields: string): T {
  const out = defined(value);
  if (Object.keys(out).length === 0) throw new ToolInputError(`Pass at least one of ${fields}.`);
  return out;
}

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

/** A chat in a list: its latest message cut down to what tells the conversation apart. */
function slimChat(c: Chat): Record<string, unknown> {
  const m = c.lastMessage;
  return {
    ...c,
    lastMessage: m ? { id: m.id, direction: m.direction, from: m.from, type: m.type, text: m.text, status: m.status } : null,
  };
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

  tool({
    name: "update_account",
    title: "Update an account",
    group: "accounts",
    description:
      "Change an account's settings: rename it, reject incoming calls automatically, turn on and tune its pacing (the anti-ban protections, off by default), choose whether the next link imports recent chats, choose which received media is downloaded right away (the rest on demand), choose the quality its images are sent at, or move its proxy location. Pacing applies from the next send. A proxy location change gives the number a new exit IP and reconnects it; it is refused within 10 minutes of the previous change. Returns the updated account with its pacing.",
    inputSchema: z.object({
      accountId,
      name: z.string().trim().min(1).max(100).optional().describe("A name for the account, such as `Front desk`."),
      rejectCalls: z.boolean().optional().describe("Reject incoming calls automatically."),
      rejectCallsMessage: z.string().max(1000).optional().describe("Text sent to the caller after an automatic reject (not for group calls)."),
      pacing: pacingUpdate.optional(),
      historySync: z
        .enum(["none", "recent"])
        .optional()
        .describe("`recent` imports the chats the phone sends at the next link. A number that is already linked gets no new history."),
      mediaAutoDownload: z
        .union([
          z.enum(["none", "all"]),
          z.object({
            maxBytes: z.number().int().min(1).max(2_000_000_000).describe("Largest file downloaded up front, in bytes."),
            types: z.array(z.enum(["image", "video", "audio", "document", "sticker"])).min(1).describe("Media types downloaded up front."),
          }),
        ])
        .optional()
        .describe(
          "Which received media is downloaded right away through the number's proxy (proxy traffic). `none` (default for new accounts): on demand, when its media URL is first requested. `all`: every file. `{maxBytes, types}`: only those.",
        ),
      imageQuality: z
        .enum(["standard", "hd", "original"])
        .optional()
        .describe(
          "What the account's images are re-encoded to before their upload through the number's proxy (proxy traffic). `standard` (default): longest side 1600 px, JPEG, as WhatsApp sends a photo. `hd`: up to 4096 px. `original`: the file as it is.",
        ),
      proxyLocation: z
        .object({
          country: z.string().trim().length(2).optional().describe("ISO 3166-1 alpha-2 country code, uppercase. Goes with `city`."),
          city: z.string().trim().min(1).max(100).optional().describe("City code from list_proxy_locations. Goes with `country`."),
          strictCity: z.boolean().optional().describe("`true` requires the exact city; `false` prefers it and may exit from another city of the same country."),
        })
        .optional()
        .describe("Move the number (`country` and `city` together), switch whether its city is exact (`strictCity`), or both. The session reconnects on a new exit IP."),
    }),
    annotations: { ...SET, openWorldHint: true },
    run: async (client, a) => {
      const { accountId: target, ...rest } = a;
      const params = changes(rest, "name, rejectCalls, rejectCallsMessage, pacing, historySync, mediaAutoDownload, imageQuality or proxyLocation");
      const loc = a.proxyLocation;
      if (loc) {
        if ((loc.country === undefined) !== (loc.city === undefined)) throw new ToolInputError("`proxyLocation.country` and `proxyLocation.city` go together.");
        if (loc.country === undefined && loc.strictCity === undefined) throw new ToolInputError("`proxyLocation` needs `country` and `city`, `strictCity`, or both.");
      }
      const account = await client.accounts.update(target, params as AccountUpdateParams);
      return ok({ ...slimAccount(account), pacing: account.pacing });
    },
  }),
  actionTool({
    name: "unlink_account",
    title: "Log out or delete an account",
    group: "accounts",
    description:
      "Unlink a WhatsApp number from wuapi. Both actions log the number out on WhatsApp and stop billing for it. Use `logout` to keep the account and its stored messages (reconnect_account then shows a new QR code to link again); use `delete` to remove the account for good.",
    fields: { accountId, confirm: confirm("The number is logged out of WhatsApp.") },
    actions: (act) => ({
      logout: act({
        summary: "Unlink the phone and stop billing, keeping the account and its messages. Returns the account.",
        annotations: DESTROY,
        required: ["accountId", "confirm"],
        run: async (client, a) => ok(slimAccount(await client.accounts.logout(a.accountId))),
      }),
      delete: act({
        summary: "Log out, delete the account and stop billing for it. Cannot be undone; fires no event.",
        annotations: DESTROY,
        required: ["accountId", "confirm"],
        run: async (client, a) => {
          await client.accounts.delete(a.accountId);
          return ok({ accountId: a.accountId, deleted: true });
        },
      }),
    }),
  }),
  actionTool({
    name: "set_presence",
    title: "Set presence or typing",
    group: "accounts",
    description:
      "Presence as contacts see it: the account online or offline, typing or recording in a chat, and presence events from a contact. Typing shows until `paused` or the next message. With typing turned on in the account's pacing (update_account), sends show it on their own.",
    fields: { accountId, chatId, contactId },
    actions: (act) => {
      const account = (state: "online" | "offline", summary: string) =>
        act({
          summary,
          annotations: SET,
          required: ["accountId"],
          run: async (client, a) => {
            await client.accounts.setPresence(a.accountId, state);
            return ok({ accountId: a.accountId, presence: state });
          },
        });
      const chat = (state: "typing" | "recording" | "paused", summary: string) =>
        act({
          summary,
          annotations: SET,
          required: ["accountId", "chatId"],
          run: async (client, a) => {
            await client.chats.sendPresence(a.accountId, a.chatId, state);
            return ok({ accountId: a.accountId, chatId: a.chatId, presence: state });
          },
        });
      return {
        online: account("online", "Show the account as online to contacts."),
        offline: account("offline", "Show the account as offline."),
        typing: chat("typing", "Show typing in a chat."),
        recording: chat("recording", "Show recording audio in a chat."),
        paused: chat("paused", "Clear the typing or recording indicator in a chat."),
        subscribe: act({
          summary:
            "Receive `contact.presence_updated` webhook events when the contact comes online, goes offline or types. Fails with `not_supported` when the account cannot receive presence events.",
          annotations: SET,
          required: ["accountId", "contactId"],
          run: async (client, a) => {
            await client.contacts.subscribePresence(a.accountId, a.contactId);
            return ok({ accountId: a.accountId, contactId: a.contactId, subscribed: true });
          },
        }),
      };
    },
  }),
  tool({
    name: "set_disappearing_timer",
    title: "Set disappearing messages",
    group: "accounts",
    description:
      "Turn disappearing messages on or off: for one chat with `chatId`, or without it the account's default timer, which new chats start with. Messages already stored in wuapi are kept.",
    inputSchema: z.object({
      accountId,
      chatId: chatId.optional().describe("The chat (a contact or group id). Omit it to set the account's default for new chats."),
      durationSeconds: disappearingSeconds,
    }),
    annotations: SET,
    run: async (client, a) => {
      if (a.chatId) await client.chats.setDisappearingTimer(a.accountId, a.chatId, a.durationSeconds);
      else await client.accounts.setDefaultDisappearingTimer(a.accountId, a.durationSeconds);
      return ok({ accountId: a.accountId, chatId: a.chatId ?? "default", durationSeconds: a.durationSeconds });
    },
  }),
  tool({
    name: "reject_call",
    title: "Reject an incoming call",
    group: "accounts",
    description:
      "Reject a WhatsApp call ringing on the account, with the `id` and `from` of its `call.received` webhook event. To reject every call automatically, set `rejectCalls` with update_account.",
    inputSchema: z.object({
      accountId,
      callId: id("The call id: `data.object.id` of the `call.received` event."),
      from: z.string().trim().min(1).max(128).describe("The caller: `data.object.from` of the same event."),
      idempotencyKey,
    }),
    annotations: ACT,
    run: async (client, a) => {
      await client.calls.reject(a.accountId, a.callId, { from: a.from }, opts(a.idempotencyKey));
      return ok({ accountId: a.accountId, callId: a.callId, rejected: true });
    },
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
      "Send a file: an image, video, audio, voice note (ogg/opus), document or sticker, with an optional caption. Give exactly one of `url` (a public URL wuapi downloads itself) or `uploadId` (a file uploaded before with upload_file). Images go out at the account's image quality (`standard` by default, as WhatsApp sends a photo); pass `quality` to change it for one image, or send the file as a `document` to deliver it untouched.",
    inputSchema: z.object({
      ...sendBase,
      type: z.enum(["image", "video", "audio", "voice", "document", "sticker"]).describe("What kind of file it is."),
      url: mediaUrl.optional(),
      uploadId: uploadId.optional(),
      caption: z.string().max(4096).optional().describe("Text shown with the file."),
      mimeType: z.string().trim().max(255).optional().describe("Guessed from the URL, or the upload's own type, when omitted."),
      filename: z.string().trim().max(255).optional().describe("Documents: the file name the recipient sees."),
      viewOnce: z.boolean().optional().describe("Images, videos, audio and voice: can be opened once."),
      quality: z
        .enum(["standard", "hd", "original"])
        .optional()
        .describe("Images only: the quality of this image instead of the account's. `hd` is WhatsApp's HD photo; `original` sends the file without re-encoding it."),
    }),
    annotations: ACT,
    run: (client, a) => {
      if ((a.url === undefined) === (a.uploadId === undefined)) throw new ToolInputError("Give exactly one of `url` or `uploadId`.");
      const media = defined({ url: a.url, uploadId: a.uploadId, mimeType: a.mimeType, filename: a.filename, quality: a.type === "image" ? a.quality : undefined });
      const viewOnce = a.type === "image" || a.type === "video" || a.type === "audio" || a.type === "voice" ? a.viewOnce : undefined;
      const params = defined({ ...base(a), type: a.type, media, text: a.caption, viewOnce }) as SendMessageParams;
      return send(client, params, a.idempotencyKey);
    },
  }),
  tool({
    name: "upload_file",
    title: "Upload a file to send",
    group: "messages",
    description:
      "Upload a file whose bytes you have (not a URL) so it can be sent: returns an upload whose `id` goes in `uploadId` of send_media or post_story. The file can be sent for 24 hours, to any number of chats. Up to 5 MB; the hosted server takes requests up to 1 MB, so about 700 KB of file there. For a file that is already at a public URL, skip this and pass the URL to send_media.",
    inputSchema: z.object({
      base64: z.string().trim().min(1).max(7_000_000).describe("The file's bytes in base64."),
      mimeType: z.string().trim().min(3).max(255).describe("The file's MIME type: `image/jpeg`, `application/pdf`, `audio/ogg; codecs=opus` for a voice note."),
      filename: z.string().trim().min(1).max(255).optional().describe("Documents: the file name the recipient sees."),
      idempotencyKey,
    }),
    annotations: CONFIGURE,
    run: async (client, a) =>
      ok({ upload: await client.uploads.create(defined({ mimeType: a.mimeType, base64: a.base64, filename: a.filename }), opts(a.idempotencyKey)) }),
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
    description:
      "One message with its status (`queued`, `sent`, `delivered`, `read`, `failed`, or `received` for inbound), content, and error when it failed. Received media is on demand by default (`media.downloaded: false`): pass `fetchMedia: true` to download it once and get a direct `mediaFile.url` that needs no API key.",
    inputSchema: z.object({
      messageId,
      fetchMedia: z.boolean().optional().describe("Also download the message's media if needed and return its direct URL as `mediaFile`."),
    }),
    annotations: READ,
    run: async (client, a) => {
      const message = await client.messages.get(a.messageId);
      if (!a.fetchMedia || !message.media) return ok(message);
      return ok({ ...message, mediaFile: await client.messages.getMedia(a.messageId, { redirect: false }) });
    },
  }),
  tool({
    name: "list_messages",
    title: "List messages",
    group: "messages",
    description:
      "Messages wuapi stored, newest first: sent and received. Filter by account, chat and direction to read a conversation. Use list_chats to see which conversations an account has.",
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

  tool({
    name: "vote_in_poll",
    title: "Vote in a poll",
    group: "messages",
    description:
      "Vote in a poll message as the account that received or sent it, with the names of its options (get_message shows them). An empty list retracts the vote. Returns the poll with its tally.",
    inputSchema: z.object({
      messageId,
      options: z.array(z.string().min(1).max(100)).max(12).describe("Option names exactly as in the poll. `[]` retracts the vote."),
      idempotencyKey,
    }),
    annotations: SET,
    run: async (client, a) => ok(await client.messages.vote(a.messageId, a.options, opts(a.idempotencyKey))),
  }),
  tool({
    name: "star_message",
    title: "Star or unstar a message",
    group: "messages",
    description: "Star a message on the phone and the other linked devices, or unstar it with `starred: false`. Returns the message.",
    inputSchema: z.object({ messageId, starred: z.boolean().optional().describe("Default true.") }),
    annotations: SET,
    run: async (client, a) => ok(a.starred === false ? await client.messages.unstar(a.messageId) : await client.messages.star(a.messageId)),
  }),

  // ---- chats ---------------------------------------------------------------
  tool({
    name: "list_chats",
    title: "List chats",
    group: "chats",
    description:
      "An account's conversations, the one with the newest message first: each chat's name, picture id, latest message and WhatsApp's unread, pinned, archived and muted state. Only chats wuapi stored a message of. A state field that is missing (`unread`, `unreadCount`, `pinned`, `pinnedAt`, `archived`, `muted`) is not known to wuapi yet, which is not the same as `false`. Filter by `archived`, `unread` or `type`, or search names, numbers and recent text with `q`. Read a conversation with list_messages and the chat's `id` as `chatId`.",
    inputSchema: z.object({
      accountId,
      archived: z.boolean().optional().describe("true: only chats WhatsApp reported as archived. false: every other chat, including those whose state is not known yet."),
      unread: z.boolean().optional().describe("true: only chats with unread messages or marked as unread. false: every other chat."),
      type: z.enum(["direct", "group", "channel"]).optional().describe("Only chats with a contact, groups, or channels."),
      q: z.string().trim().min(1).max(100).optional().describe("Search the contact or group name, the number, the username and recent message text. Results come best match first."),
      limit,
      cursor,
    }),
    annotations: READ,
    run: async (client, a) =>
      page(
        await client.chats.list(a.accountId, defined({ archived: a.archived, unread: a.unread, type: a.type, q: a.q, ...listArgs(a) })).page(),
        (c) => slimChat(c),
      ),
  }),
  tool({
    name: "get_chat",
    title: "Get a chat",
    group: "chats",
    description:
      "One conversation of an account: its name, its latest message in full, and WhatsApp's unread, pinned, archived and muted state (a field that is missing is not known yet, which is not the same as `false`). A chat wuapi stored no message of answers `not_found`.",
    inputSchema: z.object({ accountId, chatId }),
    annotations: READ,
    run: async (client, a) => ok(await client.chats.get(a.accountId, a.chatId)),
  }),
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

  tool({
    name: "delete_chat",
    title: "Delete a chat",
    group: "chats",
    description:
      "Delete a chat from the account's linked devices (the phone and WhatsApp Web). The messages wuapi stores are kept and still readable with list_messages. This cannot be undone on the devices.",
    inputSchema: z.object({
      accountId,
      chatId,
      deleteMedia: z.boolean().optional().describe("Also delete the chat's media files from the devices."),
      confirm: confirm("The chat disappears from the phone."),
    }),
    annotations: DESTROY,
    run: async (client, a) => {
      await client.chats.delete(a.accountId, a.chatId, defined({ deleteMedia: a.deleteMedia }));
      return ok({ accountId: a.accountId, chatId: a.chatId, deleted: true });
    },
  }),
  actionTool({
    name: "manage_labels",
    title: "Manage labels",
    group: "chats",
    description:
      "WhatsApp Business labels on chats and messages: create or edit a label, delete it, and add it to or remove it from a chat or a message. WhatsApp Business accounts only; others answer `not_supported`. There is no endpoint that lists labels: they arrive in `label.updated` webhook events, and `upsert` creates one under an id you choose.",
    fields: {
      accountId,
      labelId: z.string().trim().min(1).max(64).describe("The label id. `upsert` creates the label under this id when there is none."),
      name: z.string().trim().min(1).max(100).describe("The label name."),
      color: z.number().int().min(0).max(19).describe("WhatsApp's label color index, 0 to 19. Default 0."),
      chatId,
      messageId,
      confirm: confirm("The label is removed from every chat and message."),
    },
    actions: (act) => ({
      upsert: act({
        summary: "Create the label with this id, or rename or recolor it. Returns the label.",
        annotations: SET,
        required: ["accountId", "labelId", "name"],
        optional: ["color"],
        run: async (client, a) => ok(await client.labels.upsert(a.accountId, a.labelId, defined({ name: a.name, color: a.color }))),
      }),
      delete: act({
        summary: "Delete the label.",
        annotations: DESTROY,
        required: ["accountId", "labelId", "confirm"],
        run: async (client, a) => {
          await client.labels.delete(a.accountId, a.labelId);
          return ok({ accountId: a.accountId, labelId: a.labelId, deleted: true });
        },
      }),
      label_chat: act({
        summary: "Add the label to a chat.",
        annotations: SET,
        required: ["accountId", "chatId", "labelId"],
        run: async (client, a) => {
          await client.chats.addLabel(a.accountId, a.chatId, a.labelId);
          return ok({ accountId: a.accountId, chatId: a.chatId, labelId: a.labelId, labeled: true });
        },
      }),
      unlabel_chat: act({
        summary: "Remove the label from a chat.",
        annotations: SET,
        required: ["accountId", "chatId", "labelId"],
        run: async (client, a) => {
          await client.chats.removeLabel(a.accountId, a.chatId, a.labelId);
          return ok({ accountId: a.accountId, chatId: a.chatId, labelId: a.labelId, labeled: false });
        },
      }),
      label_message: act({
        summary: "Add the label to a message, as the account that sent or received it.",
        annotations: SET,
        required: ["messageId", "labelId"],
        run: async (client, a) => {
          await client.messages.addLabel(a.messageId, a.labelId);
          return ok({ messageId: a.messageId, labelId: a.labelId, labeled: true });
        },
      }),
      unlabel_message: act({
        summary: "Remove the label from a message.",
        annotations: SET,
        required: ["messageId", "labelId"],
        run: async (client, a) => {
          await client.messages.removeLabel(a.messageId, a.labelId);
          return ok({ messageId: a.messageId, labelId: a.labelId, labeled: false });
        },
      }),
    }),
  }),

  // ---- contacts ------------------------------------------------------------
  tool({
    name: "list_contacts",
    title: "List contacts",
    group: "contacts",
    description:
      "An account's address book as its phone synced it to wuapi, ordered by saved name: each contact's id, number, `savedName`, WhatsApp profile name, and the username and picture id seen so far. Only contacts the phone saved (or that have a business name); people the account just chatted with are in list_chats. Read from what wuapi stored, so `about` and `deviceCount` are not here: lookup_contacts asks WhatsApp for those. Search names, usernames and numbers with `q`.",
    inputSchema: z.object({
      accountId,
      q: z.string().trim().min(1).max(100).optional().describe("Search the saved name, profile name, business name, username or number. Results come best match first."),
      limit,
      cursor,
    }),
    annotations: READ,
    run: async (client, a) => page(await client.contacts.list(a.accountId, defined({ q: a.q, ...listArgs(a) })).page()),
  }),
  tool({
    name: "get_contact",
    title: "Get a contact",
    group: "contacts",
    description:
      "One contact of an account's address book, by number or `lid:` id: its saved name, profile name, username and picture id as wuapi stored them. A number that is not saved on the phone answers `not_found`; lookup_contacts asks WhatsApp about any number.",
    inputSchema: z.object({ accountId, contactId }),
    annotations: READ,
    run: async (client, a) => ok(await client.contacts.get(a.accountId, a.contactId)),
  }),
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
      "About text, picture id, WhatsApp username, business name and device count of 1 to 50 contacts, asked from WhatsApp (the saved names are in list_contacts). Usernames cannot be searched: WhatsApp does not let a linked device resolve an @username, so look contacts up by number or `lid:` id.",
    inputSchema: z.object({
      accountId,
      contactIds: z.array(z.string().trim().min(1).max(200)).min(1).max(50).describe("1 to 50 contact ids: E.164, digits or `lid:<digits>`."),
    }),
    annotations: READ_LIVE,
    run: async (client, a) => ok({ items: await client.contacts.lookup(a.accountId, a.contactIds) }),
  }),

  actionTool({
    name: "lookup_whatsapp_info",
    title: "Look up WhatsApp details",
    group: "contacts",
    description:
      "Read details from WhatsApp through a linked number: a contact's profile picture or business profile, who a contact QR link or business message link points to, WhatsApp's AI bot directory, and the sticker pack or catalog order a message refers to. Nothing is changed.",
    fields: {
      accountId,
      contactId,
      preview: z.boolean().describe("A small preview instead of the full picture."),
      kind: z.enum(["contact", "business"]).describe("`contact` for a contact QR link, `business` for a business message link."),
      code: z.string().trim().min(1).max(512).describe("The link, or its code."),
      stickerPackId: id("The sticker pack id, from a sticker message."),
      orderId: id("The order id, from an order message."),
      token: z.string().trim().min(1).max(512).describe("The order's token, from the same order message."),
      limit,
      cursor,
    },
    actions: (act) => ({
      contact_picture: act({
        summary: "The contact's profile picture URL, when the account can see it.",
        annotations: READ_LIVE,
        required: ["accountId", "contactId"],
        optional: ["preview"],
        run: async (client, a) => ok(await client.contacts.getPicture(a.accountId, a.contactId, defined({ preview: a.preview }))),
      }),
      business_profile: act({
        summary: "A business contact's address, email, categories, time zone and opening hours.",
        annotations: READ_LIVE,
        required: ["accountId", "contactId"],
        run: async (client, a) => ok(await client.contacts.getBusinessProfile(a.accountId, a.contactId)),
      }),
      resolve_link: act({
        summary: "Who a contact QR link or business message link points to, and its prefilled text. Fails with `not_supported` when WhatsApp does not offer it to the account.",
        annotations: READ_LIVE,
        required: ["accountId", "kind", "code"],
        run: async (client, a) => ok(await client.contacts.resolveLink(a.accountId, { kind: a.kind, code: a.code })),
      }),
      bots: act({
        summary: "WhatsApp's AI bot directory as the account sees it. Fails with `not_supported` where WhatsApp does not offer it.",
        annotations: READ_LIVE,
        required: ["accountId"],
        optional: ["limit", "cursor"],
        run: async (client, a) => page(await client.bots.list(a.accountId, listArgs(a)).page()),
      }),
      sticker_pack: act({
        summary: "A sticker pack and its stickers.",
        annotations: READ_LIVE,
        required: ["accountId", "stickerPackId"],
        run: async (client, a) => ok(await client.stickerPacks.get(a.accountId, a.stickerPackId)),
      }),
      order: act({
        summary: "The products, quantities and totals of a catalog order received as a message.",
        annotations: READ_LIVE,
        required: ["accountId", "orderId", "token"],
        run: async (client, a) => ok(await client.orders.get(a.accountId, a.orderId, { token: a.token })),
      }),
    }),
  }),
  actionTool({
    name: "manage_block_list",
    title: "Block or unblock contacts",
    group: "contacts",
    description: "The account's block list on WhatsApp: list blocked contacts, block a contact (it can no longer message or call the account) or unblock it.",
    fields: { accountId, contactId, limit, cursor, confirm: confirm("The contact can no longer message or call the account.") },
    actions: (act) => ({
      list: act({
        summary: "Blocked contacts, with their number and `lid:` id when known.",
        annotations: READ_LIVE,
        required: ["accountId"],
        optional: ["limit", "cursor"],
        run: async (client, a) => page(await client.contacts.listBlocked(a.accountId, listArgs(a)).page()),
      }),
      block: act({
        summary: "Block a contact.",
        annotations: DESTROY,
        required: ["accountId", "contactId", "confirm"],
        run: async (client, a) => {
          await client.contacts.block(a.accountId, a.contactId);
          return ok({ accountId: a.accountId, contactId: a.contactId, blocked: true });
        },
      }),
      unblock: act({
        summary: "Unblock a contact.",
        annotations: SET,
        required: ["accountId", "contactId"],
        run: async (client, a) => {
          await client.contacts.unblock(a.accountId, a.contactId);
          return ok({ accountId: a.accountId, contactId: a.contactId, blocked: false });
        },
      }),
    }),
  }),

  // ---- profile -------------------------------------------------------------
  actionTool({
    name: "manage_profile",
    title: "Manage the account's profile",
    group: "profile",
    description:
      "The linked number's own WhatsApp profile: its display name and About text, its profile picture, and its contact QR link (a `https://wa.me/qr/...` link that opens a chat with it).",
    fields: {
      accountId,
      name: z.string().trim().min(1).max(25).describe("Display name, up to 25 characters."),
      about: z.string().max(139).describe("About text, up to 139 characters."),
      pictureUrl,
      pictureBase64,
      confirm: confirm("This cannot be undone."),
    },
    actions: (act) => ({
      update: act({
        summary: "Change the display name, the About text, or both.",
        annotations: SET,
        required: ["accountId"],
        optional: ["name", "about"],
        run: async (client, a) => {
          const params = changes({ name: a.name, about: a.about }, "name or about");
          await client.profile.update(a.accountId, params);
          return ok({ accountId: a.accountId, ...params, updated: true });
        },
      }),
      set_picture: act({
        summary: "Set the profile picture from an https URL or base64 JPEG. Returns the picture.",
        annotations: SET,
        required: ["accountId"],
        optional: ["pictureUrl", "pictureBase64"],
        run: async (client, a) => ok(await client.profile.setPicture(a.accountId, pictureInput(a))),
      }),
      delete_picture: act({
        summary: "Remove the profile picture.",
        annotations: DESTROY,
        required: ["accountId", "confirm"],
        run: async (client, a) => {
          await client.profile.deletePicture(a.accountId);
          return ok({ accountId: a.accountId, pictureDeleted: true });
        },
      }),
      get_contact_link: act({
        summary: "The account's contact QR link.",
        annotations: READ_LIVE,
        required: ["accountId"],
        run: async (client, a) => ok(await client.contacts.getLink(a.accountId)),
      }),
      reset_contact_link: act({
        summary: "Revoke the contact QR link and return a new one. The old link stops working.",
        annotations: { ...DESTROY, idempotentHint: false },
        required: ["accountId", "confirm"],
        run: async (client, a) => ok(await client.contacts.resetLink(a.accountId)),
      }),
    }),
  }),
  actionTool({
    name: "manage_privacy",
    title: "Manage privacy settings",
    group: "profile",
    description: "The account's WhatsApp privacy settings: who sees its last seen, profile picture, stories and online status, who may add it to groups or call it, and whether it sends read receipts.",
    fields: {
      accountId,
      groupAdd: privacyAudience.describe("Who can add the account to groups."),
      lastSeen: privacyAudience.describe("Who sees its last seen."),
      stories: privacyAudience.describe("Who sees its stories."),
      profile: privacyAudience.describe("Who sees its profile picture."),
      readReceipts: z.enum(["all", "none"]).describe("`none` stops sending read receipts (and seeing others')."),
      online: z.enum(["all", "match_last_seen"]).describe("Who sees it online."),
      callAdd: z.enum(["all", "known"]).describe("Who can call it: everyone, or only known contacts."),
      messages: z.enum(["all", "contacts"]).describe("Who can message it."),
    },
    actions: (act) => ({
      get: act({
        summary: "Every privacy setting.",
        annotations: READ_LIVE,
        required: ["accountId"],
        run: async (client, a) => ok(await client.privacy.get(a.accountId)),
      }),
      get_story_privacy: act({
        summary: "Who sees the account's stories: its contacts, all but some, or only some.",
        annotations: READ_LIVE,
        required: ["accountId"],
        run: async (client, a) => ok(await client.privacy.getStoryPrivacy(a.accountId)),
      }),
      update: act({
        summary: "Change one or more settings. Each setting is one change on WhatsApp. Returns every setting.",
        annotations: SET,
        required: ["accountId"],
        optional: ["groupAdd", "lastSeen", "stories", "profile", "readReceipts", "online", "callAdd", "messages"],
        run: async (client, a) => {
          const { accountId: target, action: _action, ...settings } = a;
          return ok(await client.privacy.update(target, changes(settings, "the privacy settings")));
        },
      }),
    }),
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

  actionTool({
    name: "manage_group_settings",
    title: "Change a group's info and settings",
    group: "groups",
    description:
      "Change a group the account administers: its name, description and settings (who can send, who can edit the info, whether joining needs approval, who can add members), and its picture.",
    fields: {
      accountId,
      groupId,
      name: z.string().trim().min(1).max(100).describe("The group name."),
      description: z.string().max(2048).describe("The group description. An empty string clears it."),
      announce: z.boolean().describe("`true`: only admins can send messages."),
      locked: z.boolean().describe("`true`: only admins can edit the group info."),
      joinApproval: z.boolean().describe("`true`: new members need an admin's approval (see manage_group_joins)."),
      memberAddMode: z.enum(["admins", "all_members"]).describe("Who can add members."),
      pictureUrl,
      pictureBase64,
      confirm: confirm("The group picture is removed."),
    },
    actions: (act) => ({
      update: act({
        summary: "Change any of name, description, announce, locked, joinApproval and memberAddMode. Returns the group.",
        annotations: SET,
        required: ["accountId", "groupId"],
        optional: ["name", "description", "announce", "locked", "joinApproval", "memberAddMode"],
        run: async (client, a) => {
          const { accountId: acc, groupId: gid, action: _action, ...rest } = a;
          const params = changes(rest, "name, description, announce, locked, joinApproval or memberAddMode");
          return ok(slimGroup(await client.groups.update(acc, gid, params)));
        },
      }),
      set_picture: act({
        summary: "Set the group picture from an https URL or base64 JPEG. Returns the picture.",
        annotations: SET,
        required: ["accountId", "groupId"],
        optional: ["pictureUrl", "pictureBase64"],
        run: async (client, a) => ok(await client.groups.setPicture(a.accountId, a.groupId, pictureInput(a))),
      }),
      delete_picture: act({
        summary: "Remove the group picture.",
        annotations: DESTROY,
        required: ["accountId", "groupId", "confirm"],
        run: async (client, a) => {
          await client.groups.deletePicture(a.accountId, a.groupId);
          return ok({ accountId: a.accountId, groupId: a.groupId, pictureDeleted: true });
        },
      }),
    }),
  }),
  actionTool({
    name: "manage_group_joins",
    title: "Join groups and handle join requests",
    group: "groups",
    description:
      "Joining groups: preview the group behind an invite link, join it, and, in a group that needs approval to join, list, approve or reject the pending requests (the account must be an admin).",
    fields: {
      accountId,
      groupId,
      code: inviteCode,
      contactIds: contactIds.describe("1 to 256 contact ids of people who asked to join."),
      limit,
      cursor,
      idempotencyKey,
    },
    actions: (act) => ({
      preview_invite: act({
        summary: "The group behind an invite code or link, without joining: name, description, size.",
        annotations: READ_LIVE,
        required: ["accountId", "code"],
        run: async (client, a) => ok(slimGroup(await client.groups.getInvite(a.accountId, inviteCodeOf(a.code)))),
      }),
      join: act({
        summary: "Join a group with an invite code or link. Returns the group id; a group that needs approval makes it a pending request instead.",
        annotations: ACT,
        required: ["accountId", "code"],
        optional: ["idempotencyKey"],
        run: async (client, a) => ok(await client.groups.join(a.accountId, a.code, opts(a.idempotencyKey))),
      }),
      list_requests: act({
        summary: "Pending requests to join the group.",
        annotations: READ_LIVE,
        required: ["accountId", "groupId"],
        optional: ["limit", "cursor"],
        run: async (client, a) => page(await client.groups.listJoinRequests(a.accountId, a.groupId, listArgs(a)).page()),
      }),
      approve_requests: act({
        summary: "Let these people in. Each result says whether it worked.",
        annotations: SET,
        required: ["accountId", "groupId", "contactIds"],
        run: async (client, a) => ok({ items: await client.groups.approveJoinRequests(a.accountId, a.groupId, a.contactIds) }),
      }),
      reject_requests: act({
        summary: "Turn these requests down. Each result says whether it worked.",
        annotations: SET,
        required: ["accountId", "groupId", "contactIds"],
        run: async (client, a) => ok({ items: await client.groups.rejectJoinRequests(a.accountId, a.groupId, a.contactIds) }),
      }),
    }),
  }),
  actionTool({
    name: "manage_community",
    title: "Manage communities",
    group: "groups",
    description:
      "WhatsApp communities: a community is a group with `community: true` that links other groups. Create one, list its groups and members, and link or unlink groups (the account must admin both). get_group reads the community itself; send to it like a group.",
    fields: {
      accountId,
      communityId,
      groupId: groupId.describe("The group to link or unlink (`...@g.us`)."),
      name: z.string().trim().min(1).max(100).describe("The community name."),
      limit,
      cursor,
      idempotencyKey,
    },
    actions: (act) => ({
      create: act({
        summary: "Create a community with the account as owner. Returns it.",
        annotations: ACT,
        required: ["accountId", "name"],
        optional: ["idempotencyKey"],
        run: async (client, a) => ok(slimGroup(await client.groups.create(a.accountId, { name: a.name, community: true }, opts(a.idempotencyKey)))),
      }),
      list_groups: act({
        summary: "The groups linked to the community, marking its default (announcement) group.",
        annotations: READ_LIVE,
        required: ["accountId", "communityId"],
        optional: ["limit", "cursor"],
        run: async (client, a) => page(await client.groups.listSubgroups(a.accountId, a.communityId, listArgs(a)).page()),
      }),
      list_members: act({
        summary: "Members across the community's linked groups.",
        annotations: READ_LIVE,
        required: ["accountId", "communityId"],
        optional: ["limit", "cursor"],
        run: async (client, a) => page(await client.groups.listCommunityParticipants(a.accountId, a.communityId, listArgs(a)).page()),
      }),
      link_group: act({
        summary: "Link a group into the community.",
        annotations: SET,
        required: ["accountId", "communityId", "groupId"],
        run: async (client, a) => {
          await client.groups.linkSubgroup(a.accountId, a.communityId, a.groupId);
          return ok({ accountId: a.accountId, communityId: a.communityId, groupId: a.groupId, linked: true });
        },
      }),
      unlink_group: act({
        summary: "Unlink a group from the community. The group itself stays.",
        annotations: SET,
        required: ["accountId", "communityId", "groupId"],
        run: async (client, a) => {
          await client.groups.unlinkSubgroup(a.accountId, a.communityId, a.groupId);
          return ok({ accountId: a.accountId, communityId: a.communityId, groupId: a.groupId, linked: false });
        },
      }),
    }),
  }),

  // ---- channels ------------------------------------------------------------
  actionTool({
    name: "manage_channel",
    title: "Manage channels",
    group: "channels",
    description:
      "WhatsApp channels (one-to-many broadcasts, ids end in `@newsletter`): list the ones the account follows or owns, read one and its posts, preview an invite, create a channel, follow, unfollow, mute and unmute, react to posts and count as a viewer. To post to a channel the account administers, use send_text or send_media with `to` set to the channel id.",
    fields: {
      accountId,
      channelId,
      code: inviteCode,
      name: z.string().trim().min(1).max(100).describe("The channel name."),
      description: z.string().max(2048).describe("The channel description."),
      pictureBase64: z.string().trim().min(1).max(5_000_000).describe("The channel picture as a base64 JPEG."),
      channelMessageId: id("A post's id, from `list_messages`."),
      channelMessageIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100).describe("1 to 100 post ids, from `list_messages`."),
      emoji: z.string().max(32).describe("One emoji. An empty string removes the reaction."),
      limit,
      cursor,
      idempotencyKey,
    },
    actions: (act) => {
      const toggle = (verb: "follow" | "unfollow" | "mute" | "unmute", summary: string, result: Record<string, boolean>) =>
        act({
          summary,
          annotations: SET,
          required: ["accountId", "channelId"],
          run: async (client, a) => {
            await client.channels[verb](a.accountId, a.channelId);
            return ok({ accountId: a.accountId, channelId: a.channelId, ...result });
          },
        });
      return {
        list: act({
          summary: "Channels the account follows or administers, with its role.",
          annotations: READ_LIVE,
          required: ["accountId"],
          optional: ["limit", "cursor"],
          run: async (client, a) => page(await client.channels.list(a.accountId, listArgs(a)).page()),
        }),
        get: act({
          summary: "One channel: name, description, subscriber count, the account's role and whether it is muted.",
          annotations: READ_LIVE,
          required: ["accountId", "channelId"],
          run: async (client, a) => ok(await client.channels.get(a.accountId, a.channelId)),
        }),
        preview_invite: act({
          summary: "The channel behind an invite code or link, without following it.",
          annotations: READ_LIVE,
          required: ["accountId", "code"],
          run: async (client, a) => ok(await client.channels.getInvite(a.accountId, inviteCodeOf(a.code))),
        }),
        list_messages: act({
          summary: "The channel's recent posts, newest first, with view and reaction counts.",
          annotations: READ_LIVE,
          required: ["accountId", "channelId"],
          optional: ["limit", "cursor"],
          run: async (client, a) => page(await client.channels.listMessages(a.accountId, a.channelId, listArgs(a)).page()),
        }),
        create: act({
          summary: "Create a channel with the account as owner. Returns it.",
          annotations: ACT,
          required: ["accountId", "name"],
          optional: ["description", "pictureBase64", "idempotencyKey"],
          run: async (client, a) =>
            ok(await client.channels.create(a.accountId, defined({ name: a.name, description: a.description, pictureBase64: a.pictureBase64 }), opts(a.idempotencyKey))),
        }),
        follow: toggle("follow", "Follow the channel.", { following: true }),
        unfollow: toggle("unfollow", "Stop following the channel.", { following: false }),
        mute: toggle("mute", "Mute the channel's notifications.", { muted: true }),
        unmute: toggle("unmute", "Unmute the channel.", { muted: false }),
        react: act({
          summary: "React to a post with an emoji, or remove the reaction with an empty string.",
          annotations: SET,
          required: ["accountId", "channelId", "channelMessageId", "emoji"],
          run: async (client, a) => {
            await client.channels.react(a.accountId, a.channelId, a.channelMessageId, a.emoji);
            return ok({ channelId: a.channelId, channelMessageId: a.channelMessageId, emoji: a.emoji, reacted: a.emoji !== "" });
          },
        }),
        mark_viewed: act({
          summary: "Count the account as a viewer of these posts.",
          annotations: SET,
          required: ["accountId", "channelId", "channelMessageIds"],
          run: async (client, a) => {
            await client.channels.markViewed(a.accountId, a.channelId, a.channelMessageIds);
            return ok({ channelId: a.channelId, viewed: a.channelMessageIds.length });
          },
        }),
      };
    },
  }),

  // ---- stories -------------------------------------------------------------
  tool({
    name: "post_story",
    title: "Post a story",
    group: "stories",
    description:
      "Post a story from the account: text on a colored background, or an image or video with an optional caption, from a public URL (`mediaUrl`) or a file uploaded with upload_file (`uploadId`).",
    inputSchema: z.object({
      accountId,
      type: z.enum(["text", "image", "video"]).optional().describe("Default `text`."),
      text: z.string().max(4096).optional().describe("The story text (required for `text`), or the caption."),
      mediaUrl: mediaUrl.optional().describe("Image or video: public http(s) URL of the file."),
      uploadId: uploadId.optional(),
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
      if ((a.mediaUrl === undefined) === (a.uploadId === undefined)) throw new ToolInputError(`An ${type} story needs exactly one of \`mediaUrl\` or \`uploadId\`.`);
      const media = a.uploadId !== undefined ? { uploadId: a.uploadId } : { url: a.mediaUrl as string };
      return ok({ message: await client.stories.create(a.accountId, defined({ type, media, text: a.text }), opts(a.idempotencyKey)) });
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

  tool({
    name: "get_webhook",
    title: "Get a webhook endpoint",
    group: "webhooks",
    description: "One webhook endpoint: its URL, events and whether it is active. Never its signing secret.",
    inputSchema: z.object({ webhookEndpointId: id("The webhook endpoint id, from list_webhooks.") }),
    annotations: READ,
    run: async (client, a) => ok(await client.webhookEndpoints.get(a.webhookEndpointId)),
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

  actionTool({
    name: "manage_project",
    title: "Update, delete or audit a project",
    group: "projects",
    description:
      "Change a project (rename it, set its external id, metadata or account limit, suspend or resume it), delete it, and list or revoke its API keys. Suspending refuses every send and write in the project while reads and inbound messages keep working. Organization keys only. New project keys are created in the wuapi dashboard: no tool returns an API key.",
    fields: {
      projectId: id("The project id or `ext:<externalId>`."),
      name: z.string().trim().min(1).max(100).describe("The project name."),
      externalId: z
        .string()
        .regex(/^[A-Za-z0-9._:@-]{1,128}$/)
        .nullable()
        .describe("Your id for this customer: letters, digits and `. _ : @ -`. null clears it."),
      metadata: z.record(z.string().min(1).max(64), z.string().max(500)).describe("Your own string values. Replaces the whole metadata object."),
      maxAccounts: z.number().int().min(0).max(10_000).nullable().describe("How many numbers it may link. null removes the limit."),
      status: z.enum(["active", "suspended"]).describe("`suspended` refuses sends and writes; `active` resumes."),
      apiKeyId: id("The API key id, from `list_keys`."),
      limit,
      cursor,
      confirm: confirm("This cannot be undone."),
    },
    actions: (act) => ({
      update: act({
        summary: "Change any of name, externalId, metadata, maxAccounts and status. Returns the project.",
        annotations: { ...CONFIGURE, idempotentHint: true },
        required: ["projectId"],
        optional: ["name", "externalId", "metadata", "maxAccounts", "status"],
        run: async (client, a) => {
          const { projectId: target, action: _action, ...rest } = a;
          return ok(await client.projects.update(target, changes(rest, "name, externalId, metadata, maxAccounts or status")));
        },
      }),
      delete: act({
        summary: "Delete the project: its keys stop working at once, and its numbers are logged out and deleted in the background with its webhook endpoints.",
        annotations: DESTROY_CONFIG,
        required: ["projectId", "confirm"],
        run: async (client, a) => {
          await client.projects.delete(a.projectId);
          return ok({ projectId: a.projectId, deleted: true });
        },
      }),
      list_keys: act({
        summary: "The project's API keys, revoked ones included: name, last 4 characters, last use. Never the key itself.",
        annotations: READ,
        required: ["projectId"],
        optional: ["limit", "cursor"],
        run: async (client, a) => page(await client.projects.apiKeys.list(a.projectId, listArgs(a)).page()),
      }),
      revoke_key: act({
        summary: "Revoke one of the project's API keys. It stops working at once.",
        annotations: DESTROY_CONFIG,
        required: ["projectId", "apiKeyId", "confirm"],
        run: async (client, a) => {
          await client.projects.apiKeys.revoke(a.projectId, a.apiKeyId);
          return ok({ projectId: a.projectId, apiKeyId: a.apiKeyId, revoked: true });
        },
      }),
    }),
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

  tool({
    name: "resend_invitation",
    title: "Resend an invitation",
    group: "invitations",
    description:
      "Give an invitation a new link and expiry and email it again when it has an `inviteeEmail`. The previous `url` stops working; send the new one from the result. An account the invitee already started is kept, so they resume where they left off.",
    inputSchema: z.object({ invitationId: id("The invitation id."), confirm: confirm("The current invitation link stops working."), idempotencyKey }),
    annotations: { ...DESTROY_CONFIG, idempotentHint: false },
    run: async (client, a) => ok(await client.invitations.resend(a.invitationId, opts(a.idempotencyKey))),
  }),
  actionTool({
    name: "manage_branding",
    title: "Manage invitation branding",
    group: "invitations",
    description:
      "How the invitation page and email look to your customers: display name, logo, accent color, support link, and whether the \"Powered by wuapi\" footer shows. Organization keys only.",
    fields: {
      displayName: z.string().trim().min(1).max(60).describe("Your name as customers see it. Required the first time."),
      logoUrl: nullableHttpsUrl.describe("https URL of your logo. null clears it."),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().describe("`#RRGGBB`. null uses wuapi's."),
      supportUrl: nullableHttpsUrl.describe("https URL where customers get help. null clears it."),
      hideWuapiBranding: z.boolean().describe("Hide the \"Powered by wuapi\" footer. `true` needs the White label add-on (`addon_required` otherwise)."),
    },
    actions: (act) => ({
      get: act({
        summary: "The current branding.",
        annotations: READ,
        run: async (client) => ok(await client.branding.get()),
      }),
      update: act({
        summary: "Change any of the fields. Returns the branding.",
        annotations: { ...CONFIGURE, idempotentHint: true },
        optional: ["displayName", "logoUrl", "accentColor", "supportUrl", "hideWuapiBranding"],
        run: async (client, a) => {
          const { action: _action, ...rest } = a;
          return ok(await client.branding.update(changes(rest, "displayName, logoUrl, accentColor, supportUrl or hideWuapiBranding")));
        },
      }),
    }),
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
  "profile",
  "groups",
  "channels",
  "stories",
  "webhooks",
  "projects",
  "invitations",
  "usage",
];
