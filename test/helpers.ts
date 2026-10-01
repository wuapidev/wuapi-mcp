import type { Wuapi } from "@wuapidev/sdk";
import { vi, type Mock } from "vitest";

type AnyFn = (...args: never[]) => unknown;
type ResourceName =
  | "accounts"
  | "proxyLocations"
  | "messages"
  | "chats"
  | "contacts"
  | "bots"
  | "profile"
  | "privacy"
  | "labels"
  | "calls"
  | "stickerPacks"
  | "orders"
  | "groups"
  | "channels"
  | "stories"
  | "webhookEndpoints"
  | "projects"
  | "invitations"
  | "branding"
  | "usage";
export type MockClient = { [R in ResourceName]: { [method: string]: Mock<AnyFn> } } & {
  me: Mock<AnyFn>;
  projects: { apiKeys: { [method: string]: Mock<AnyFn> } };
};

/**
 * A stand-in for the SDK client: every method a tool may call is a vi.fn.
 * List methods return a paginator whose `page()` resolves to an empty page
 * unless the test says otherwise (`listPage(client.accounts.list, [...])`).
 */
export function mockClient(): MockClient {
  const emptyPage = () => ({ page: vi.fn(async () => ({ object: "list", items: [], nextCursor: null })) });
  const resources: Record<string, string[]> = {
    accounts: ["get", "create", "update", "delete", "reconnect", "logout", "createPairingCode", "waitForQrCode", "setPresence", "setDefaultDisappearingTimer"],
    proxyLocations: [],
    messages: ["send", "get", "getMedia", "edit", "delete", "react", "vote", "star", "unstar", "addLabel", "removeLabel"],
    chats: [
      "markRead", "markUnread", "sendReadReceipts", "archive", "unarchive", "pin", "unpin", "mute", "unmute",
      "sendPresence", "delete", "setDisappearingTimer", "addLabel", "removeLabel", "get",
    ],
    contacts: ["get", "check", "lookup", "getPicture", "getBusinessProfile", "subscribePresence", "block", "unblock", "getLink", "resetLink", "resolveLink"],
    bots: [],
    profile: ["update", "setPicture", "deletePicture"],
    privacy: ["get", "update", "getStoryPrivacy"],
    labels: ["upsert", "delete"],
    calls: ["reject"],
    stickerPacks: ["get"],
    orders: ["get"],
    groups: [
      "get", "create", "update", "addParticipants", "removeParticipants", "promoteParticipants", "demoteParticipants",
      "getInviteLink", "resetInviteLink", "leave", "join", "getInvite", "setPicture", "deletePicture",
      "approveJoinRequests", "rejectJoinRequests", "linkSubgroup", "unlinkSubgroup",
    ],
    channels: ["create", "get", "getInvite", "follow", "unfollow", "mute", "unmute", "react", "markViewed"],
    stories: ["create"],
    webhookEndpoints: ["create", "get", "update", "delete"],
    projects: ["get", "create", "update", "delete", "getUsage"],
    invitations: ["create", "get", "cancel", "resend"],
    branding: ["get", "update"],
    usage: ["get", "byProject"],
  };
  const lists: Record<string, string[]> = {
    accounts: ["list"],
    proxyLocations: ["list"],
    messages: ["list"],
    chats: ["list"],
    contacts: ["list", "listBlocked"],
    bots: ["list"],
    groups: ["list", "listJoinRequests", "listSubgroups", "listCommunityParticipants"],
    channels: ["list", "listMessages"],
    webhookEndpoints: ["list"],
    projects: ["list"],
    invitations: ["list"],
  };
  const client: Record<string, unknown> = { me: vi.fn() };
  for (const [name, methods] of Object.entries(resources)) {
    const r: Record<string, Mock<AnyFn>> = {};
    for (const m of methods) r[m] = vi.fn();
    for (const m of lists[name] ?? []) r[m] = vi.fn(emptyPage) as unknown as Mock<AnyFn>;
    client[name] = r;
  }
  (client.projects as Record<string, unknown>).apiKeys = { list: vi.fn(emptyPage), revoke: vi.fn() };
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
    mediaAutoDownload: "none",
    metadata: {},
    linkedAt: "2026-09-20T10:00:00.000Z",
    lastConnectedAt: "2026-09-25T10:00:00.000Z",
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
    ...overrides,
  };
}
