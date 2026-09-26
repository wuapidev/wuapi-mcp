import type { Wuapi } from "@wuapidev/sdk";
import { vi, type Mock } from "vitest";

type AnyFn = (...args: never[]) => unknown;
type ResourceName =
  | "accounts"
  | "proxyLocations"
  | "messages"
  | "chats"
  | "contacts"
  | "groups"
  | "stories"
  | "webhookEndpoints"
  | "projects"
  | "invitations"
  | "usage";
export type MockClient = { [R in ResourceName]: { [method: string]: Mock<AnyFn> } } & { me: Mock<AnyFn> };

/**
 * A stand-in for the SDK client: every method a tool may call is a vi.fn.
 * List methods return a paginator whose `page()` resolves to an empty page
 * unless the test says otherwise (`listPage(client.accounts.list, [...])`).
 */
export function mockClient(): MockClient {
  const emptyPage = () => ({ page: vi.fn(async () => ({ object: "list", items: [], nextCursor: null })) });
  const resources: Record<string, string[]> = {
    accounts: ["get", "create", "reconnect", "createPairingCode", "waitForQrCode"],
    proxyLocations: [],
    messages: ["send", "get", "edit", "delete", "react"],
    chats: ["markRead", "markUnread", "sendReadReceipts", "archive", "unarchive", "pin", "unpin", "mute", "unmute"],
    contacts: ["check", "lookup"],
    groups: ["get", "create", "addParticipants", "removeParticipants", "promoteParticipants", "demoteParticipants", "getInviteLink", "resetInviteLink", "leave"],
    stories: ["create"],
    webhookEndpoints: ["create", "update", "delete"],
    projects: ["get", "create", "getUsage"],
    invitations: ["create", "get", "cancel"],
    usage: ["get", "byProject"],
  };
  const lists = ["accounts", "proxyLocations", "messages", "groups", "webhookEndpoints", "projects", "invitations"];
  const client: Record<string, unknown> = { me: vi.fn() };
  for (const [name, methods] of Object.entries(resources)) {
    const r: Record<string, Mock<AnyFn>> = {};
    for (const m of methods) r[m] = vi.fn();
    if (lists.includes(name)) r.list = vi.fn(emptyPage) as unknown as Mock<AnyFn>;
    client[name] = r;
  }
  return client as MockClient;
}

export function asWuapi(client: MockClient): Wuapi {
  return client as unknown as Wuapi;
}

/** Make a list method answer one page with these items. */
export function listPage(fn: Mock<AnyFn>, items: unknown[], nextCursor: string | null = null) {
  const page = vi.fn(async () => ({ object: "list", items, nextCursor }));
  fn.mockImplementation((() => ({ page })) as never);
  return page;
}

export const KEY = "wu_live_0123456789abcdef0123456789abcdef0123456789abcdef";

export function message(overrides: Record<string, unknown> = {}) {
  return {
    object: "message",
    id: "msg_1",
    projectId: null,
    accountId: "acc_1",
    chatId: "+584241112233",
    chatType: "direct",
    direction: "outbound",
    source: "api",
    from: "+15550001111",
    to: "+584241112233",
    profileName: null,
    username: null,
    type: "text",
    text: "hi",
    media: null,
    status: "queued",
    error: null,
    mentions: [],
    createdAt: "2026-09-25T10:00:00.000Z",
    ...overrides,
  };
}

export function account(overrides: Record<string, unknown> = {}) {
  return {
    object: "account",
    id: "acc_1",
    projectId: null,
    name: "Front desk",
    status: "ready",
    phone: "+15550001111",
    profileName: "Acme",
    proxyLocation: { country: "US", city: "newyorkcity" },
    qrCodeUrl: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    billable: true,
    disconnectReason: null,
    lastError: null,
    rejectCalls: false,
    rejectCallsMessage: null,
    pacing: { messagesPerMinute: 12, firstContactPerMinute: 5, typing: { enabled: true, minMs: 800, maxMs: 6000, charsPerSecond: 25 }, queueTimeoutMinutes: 60, custom: false },
    historySync: "none",
    metadata: {},
    linkedAt: "2026-09-20T10:00:00.000Z",
    lastConnectedAt: "2026-09-25T10:00:00.000Z",
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
    ...overrides,
  };
}
