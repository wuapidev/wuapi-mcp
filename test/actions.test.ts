import { beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { errorResult, type ToolResult } from "../src/format.js";
import { toolsFor } from "../src/server.js";
import { TOOLS } from "../src/tools.js";
import { account, asWuapi, listPage, message, mockClient, type MockClient } from "./helpers.js";

// The tools added for full API coverage, most of them with an `action`.

let client: MockClient;
beforeEach(() => {
  client = mockClient();
});

function tool(name: string) {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

/** As the server does: validate with the published schema, run, turn a throw into the error result. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const def = tool(name);
  const parsed = def.inputSchema.parse(args);
  try {
    return await def.run(asWuapi(client), parsed as never);
  } catch (err) {
    return errorResult(err);
  }
}

const accepts = (name: string, args: Record<string, unknown>) => tool(name).inputSchema.safeParse(args).success;
const errorOf = (res: ToolResult) => (res.structuredContent as { error: { code: string; message: string } }).error;
const out = (res: ToolResult) => res.structuredContent as Record<string, unknown>;

describe("action tools", () => {
  const actionTools = TOOLS.filter((t) => t.actions);

  it("publish a plain object schema with `action` as an enum and every field optional but action", () => {
    expect(actionTools.length).toBeGreaterThanOrEqual(12);
    for (const t of actionTools) {
      const json = z.toJSONSchema(t.inputSchema) as { type: string; required: string[]; properties: Record<string, { enum?: string[]; description?: string }>; oneOf?: unknown };
      expect(json.type, t.name).toBe("object");
      expect(json.oneOf, t.name).toBeUndefined();
      expect(json.required, t.name).toEqual(["action"]);
      expect(json.properties.action!.enum, t.name).toEqual(t.actions!.names);
      for (const [field, prop] of Object.entries(json.properties)) {
        if (field !== "action") expect(prop.description, `${t.name}.${field}`).toMatch(/(Required|Optional) for/);
      }
      for (const a of t.actions!.names) expect(t.description, `${t.name}.${a}`).toContain(`- \`${a}\`: `);
    }
  });

  it("parse each call with the exact union: a missing field names the action", async () => {
    const res = await call("manage_channel", { action: "get", accountId: "acc_1" });
    expect(res.isError).toBe(true);
    expect(errorOf(res)).toMatchObject({ code: "invalid_request", message: "Action `get` needs `channelId`." });
    expect(client.channels.get).not.toHaveBeenCalled();
    expect(tool("manage_channel").actions!.actionSchema.safeParse({ action: "get", accountId: "a", channelId: "c@newsletter" }).success).toBe(true);
    expect(tool("manage_channel").actions!.actionSchema.safeParse({ action: "get", accountId: "a" }).success).toBe(false);
  });

  it("refuse destructive actions without confirm: true, before any call", async () => {
    const res = await call("manage_block_list", { action: "block", accountId: "a", contactId: "+1555" });
    expect(errorOf(res).message).toContain("needs `confirm: true`");
    expect(client.contacts.block).not.toHaveBeenCalled();
    expect(accepts("manage_block_list", { action: "block", accountId: "a", contactId: "+1555", confirm: false })).toBe(false);
  });

  it("refuse unknown actions in the schema", () => {
    expect(accepts("manage_channel", { action: "post", accountId: "a" })).toBe(false);
  });

  it("drop fields the action does not use", async () => {
    await call("manage_channel", { action: "follow", accountId: "a", channelId: "c@newsletter", emoji: "x" });
    expect(client.channels.follow).toHaveBeenCalledWith("a", "c@newsletter");
  });

  it("combine annotations: read-only only when every action reads", () => {
    expect(tool("lookup_whatsapp_info").annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool("manage_channel").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(tool("manage_block_list").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("keep their reading actions in read-only mode", () => {
    const readOnly = toolsFor({ readOnly: true });
    const channel = readOnly.find((t) => t.name === "manage_channel")!;
    expect(channel.actions!.names).toEqual(["list", "get", "preview_invite", "list_messages"]);
    expect(channel.annotations.readOnlyHint).toBe(true);
    expect(z.toJSONSchema(channel.inputSchema)).toMatchObject({ properties: { action: { enum: ["list", "get", "preview_invite", "list_messages"] } } });
    expect(channel.inputSchema.safeParse({ action: "follow", accountId: "a", channelId: "c" }).success).toBe(false);
    const branding = readOnly.find((t) => t.name === "manage_branding")!;
    expect(branding.actions!.names).toEqual(["get"]);
    expect(branding.inputSchema.safeParse({ action: "get" }).success).toBe(true);
    for (const name of ["unlink_account", "manage_labels", "set_presence", "manage_group_settings"]) expect(readOnly.find((t) => t.name === name), name).toBeUndefined();
    expect(readOnly.find((t) => t.name === "lookup_whatsapp_info")).toBe(tool("lookup_whatsapp_info"));
  });

  it("run a read-only variant's action", async () => {
    const branding = toolsFor({ readOnly: true }).find((t) => t.name === "manage_branding")!;
    client.branding.get!.mockResolvedValue({ object: "branding", displayName: "Acme", logoUrl: null });
    const res = await branding.run(asWuapi(client), branding.inputSchema.parse({ action: "get" }) as never);
    expect(res.structuredContent).toEqual({ displayName: "Acme" });
  });
});

describe("accounts", () => {
  it("update_account sends only the given fields and returns the pacing", async () => {
    client.accounts.update!.mockResolvedValue(account({ qrCodeUrl: "data:image/png;base64,AAAA" }));
    const res = await call("update_account", { accountId: "acc_1", rejectCalls: true, pacing: { messagesPerMinute: 12, typing: { enabled: true } } });
    expect(client.accounts.update).toHaveBeenCalledWith("acc_1", { rejectCalls: true, pacing: { messagesPerMinute: 12, typing: { enabled: true } } });
    expect(out(res).pacing).toMatchObject({ messagesPerMinute: 12 });
    expect(JSON.stringify(res)).not.toContain("base64");
  });

  it("update_account validates bounds and needs a change", async () => {
    expect(accepts("update_account", { accountId: "a", pacing: { messagesPerMinute: 31 } })).toBe(false);
    expect(accepts("update_account", { accountId: "a", pacing: null })).toBe(true);
    expect((await call("update_account", { accountId: "a" })).isError).toBe(true);
    expect((await call("update_account", { accountId: "a", proxyLocation: { country: "US" } })).isError).toBe(true);
    expect((await call("update_account", { accountId: "a", proxyLocation: {} })).isError).toBe(true);
    await call("update_account", { accountId: "a", proxyLocation: { strictCity: true } });
    expect(client.accounts.update).toHaveBeenCalledWith("a", { proxyLocation: { strictCity: true } });
  });

  it("unlink_account logs out or deletes, with confirm", async () => {
    client.accounts.logout!.mockResolvedValue(account({ status: "disconnected" }));
    const res = await call("unlink_account", { action: "logout", accountId: "acc_1", confirm: true });
    expect(client.accounts.logout).toHaveBeenCalledWith("acc_1");
    expect(out(res)).toMatchObject({ id: "acc_1", status: "disconnected", hasQrCode: false });
    await call("unlink_account", { action: "delete", accountId: "acc_1", confirm: true });
    expect(client.accounts.delete).toHaveBeenCalledWith("acc_1");
    expect((await call("unlink_account", { action: "delete", accountId: "acc_2" })).isError).toBe(true);
    expect(client.accounts.delete).toHaveBeenCalledTimes(1);
  });

  it("set_presence picks the account, chat or contact call", async () => {
    await call("set_presence", { action: "online", accountId: "a" });
    expect(client.accounts.setPresence).toHaveBeenCalledWith("a", "online");
    const res = await call("set_presence", { action: "typing", accountId: "a", chatId: "+1555" });
    expect(client.chats.sendPresence).toHaveBeenCalledWith("a", "+1555", "typing");
    expect(out(res)).toEqual({ accountId: "a", chatId: "+1555", presence: "typing" });
    await call("set_presence", { action: "paused", accountId: "a", chatId: "+1555" });
    expect(client.chats.sendPresence).toHaveBeenLastCalledWith("a", "+1555", "paused");
    await call("set_presence", { action: "subscribe", accountId: "a", contactId: "+1555" });
    expect(client.contacts.subscribePresence).toHaveBeenCalledWith("a", "+1555");
    expect((await call("set_presence", { action: "recording", accountId: "a" })).isError).toBe(true);
  });

  it("set_disappearing_timer sets one chat or the default", async () => {
    await call("set_disappearing_timer", { accountId: "a", chatId: "+1555", durationSeconds: 86400 });
    expect(client.chats.setDisappearingTimer).toHaveBeenCalledWith("a", "+1555", 86400);
    const res = await call("set_disappearing_timer", { accountId: "a", durationSeconds: 0 });
    expect(client.accounts.setDefaultDisappearingTimer).toHaveBeenCalledWith("a", 0);
    expect(out(res)).toMatchObject({ chatId: "default", durationSeconds: 0 });
    expect(accepts("set_disappearing_timer", { accountId: "a", durationSeconds: 3600 })).toBe(false);
  });

  it("reject_call passes the caller and idempotency key", async () => {
    await call("reject_call", { accountId: "a", callId: "call_1", from: "+1555", idempotencyKey: "k" });
    expect(client.calls.reject).toHaveBeenCalledWith("a", "call_1", { from: "+1555" }, { idempotencyKey: "k" });
  });
});

describe("messages and chats", () => {
  it("vote_in_poll votes with option names", async () => {
    client.messages.vote!.mockResolvedValue(message({ type: "poll" }));
    await call("vote_in_poll", { messageId: "m", options: ["Yes"], idempotencyKey: "k" });
    expect(client.messages.vote).toHaveBeenCalledWith("m", ["Yes"], { idempotencyKey: "k" });
    await call("vote_in_poll", { messageId: "m", options: [] });
    expect(client.messages.vote).toHaveBeenLastCalledWith("m", [], undefined);
  });

  it("forward_message forwards to the chats named, with the idempotency key", async () => {
    client.messages.forward!.mockResolvedValue({ object: "list", items: [message({ forwarded: true }), message({ forwarded: true })], nextCursor: null });
    const res = out(await call("forward_message", { messageId: "m", to: ["+584241112233", "120363041234567890@g.us"], idempotencyKey: "k" }));
    expect(client.messages.forward).toHaveBeenCalledWith("m", { to: ["+584241112233", "120363041234567890@g.us"] }, { idempotencyKey: "k" });
    expect(res.items as unknown[]).toHaveLength(2);
    // WhatsApp's limit per forward, and at least one chat.
    expect(accepts("forward_message", { messageId: "m", to: [] })).toBe(false);
    expect(accepts("forward_message", { messageId: "m", to: ["1", "2", "3", "4", "5", "6"] })).toBe(false);
    expect(accepts("forward_message", { messageId: "m", to: ["+584241112233"] })).toBe(true);
  });

  it("star_message stars by default and unstars with starred: false", async () => {
    client.messages.star!.mockResolvedValue(message({ starred: true }));
    client.messages.unstar!.mockResolvedValue(message({ starred: false }));
    expect(out(await call("star_message", { messageId: "m" }))).toMatchObject({ starred: true });
    await call("star_message", { messageId: "m", starred: false });
    expect(client.messages.unstar).toHaveBeenCalledWith("m");
  });

  it("delete_chat needs confirm and passes deleteMedia", async () => {
    expect(accepts("delete_chat", { accountId: "a", chatId: "+1" })).toBe(false);
    await call("delete_chat", { accountId: "a", chatId: "+1", deleteMedia: true, confirm: true });
    expect(client.chats.delete).toHaveBeenCalledWith("a", "+1", { deleteMedia: true });
  });

  it("manage_labels calls the label, chat and message endpoints", async () => {
    client.labels.upsert!.mockResolvedValue({ object: "label", id: "1", accountId: "a", name: "VIP", color: 3 });
    const res = await call("manage_labels", { action: "upsert", accountId: "a", labelId: "1", name: "VIP", color: 3 });
    expect(client.labels.upsert).toHaveBeenCalledWith("a", "1", { name: "VIP", color: 3 });
    expect(out(res)).toMatchObject({ id: "1", name: "VIP" });
    expect(accepts("manage_labels", { action: "upsert", accountId: "a", labelId: "1", name: "VIP", color: 20 })).toBe(false);
    await call("manage_labels", { action: "delete", accountId: "a", labelId: "1", confirm: true });
    expect(client.labels.delete).toHaveBeenCalledWith("a", "1");
    await call("manage_labels", { action: "label_chat", accountId: "a", chatId: "+1", labelId: "1" });
    expect(client.chats.addLabel).toHaveBeenCalledWith("a", "+1", "1");
    await call("manage_labels", { action: "unlabel_chat", accountId: "a", chatId: "+1", labelId: "1" });
    expect(client.chats.removeLabel).toHaveBeenCalledWith("a", "+1", "1");
    await call("manage_labels", { action: "label_message", messageId: "m", labelId: "1" });
    expect(client.messages.addLabel).toHaveBeenCalledWith("m", "1");
    await call("manage_labels", { action: "unlabel_message", messageId: "m", labelId: "1" });
    expect(client.messages.removeLabel).toHaveBeenCalledWith("m", "1");
  });
});

describe("contacts, profile and privacy", () => {
  it("lookup_whatsapp_info reads pictures, business profiles, links, bots, sticker packs and orders", async () => {
    client.contacts.getPicture!.mockResolvedValue({ object: "picture", id: "p1", url: "https://pps.example/p1.jpg", preview: true });
    const pic = await call("lookup_whatsapp_info", { action: "contact_picture", accountId: "a", contactId: "+1555", preview: true });
    expect(client.contacts.getPicture).toHaveBeenCalledWith("a", "+1555", { preview: true });
    expect(out(pic)).toEqual({ id: "p1", url: "https://pps.example/p1.jpg", preview: true });
    await call("lookup_whatsapp_info", { action: "business_profile", accountId: "a", contactId: "+1555" });
    expect(client.contacts.getBusinessProfile).toHaveBeenCalledWith("a", "+1555");
    await call("lookup_whatsapp_info", { action: "resolve_link", accountId: "a", kind: "business", code: "https://wa.me/message/ABC" });
    expect(client.contacts.resolveLink).toHaveBeenCalledWith("a", { kind: "business", code: "https://wa.me/message/ABC" });
    listPage(client.bots.list!, [{ object: "bot", id: "b1", name: "Helper" }], "next");
    const bots = await call("lookup_whatsapp_info", { action: "bots", accountId: "a", limit: 5 });
    expect(client.bots.list).toHaveBeenCalledWith("a", { limit: 5 });
    expect(out(bots)).toMatchObject({ items: [{ id: "b1" }], hasMore: true });
    await call("lookup_whatsapp_info", { action: "sticker_pack", accountId: "a", stickerPackId: "sp1" });
    expect(client.stickerPacks.get).toHaveBeenCalledWith("a", "sp1");
    await call("lookup_whatsapp_info", { action: "order", accountId: "a", orderId: "o1", token: "tok" });
    expect(client.orders.get).toHaveBeenCalledWith("a", "o1", { token: "tok" });
  });

  it("manage_block_list lists, blocks with confirm and unblocks", async () => {
    await call("manage_block_list", { action: "list", accountId: "a" });
    expect(client.contacts.listBlocked).toHaveBeenCalledWith("a", { limit: 20 });
    const res = await call("manage_block_list", { action: "block", accountId: "a", contactId: "+1555", confirm: true });
    expect(client.contacts.block).toHaveBeenCalledWith("a", "+1555");
    expect(out(res)).toEqual({ accountId: "a", contactId: "+1555", blocked: true });
    await call("manage_block_list", { action: "unblock", accountId: "a", contactId: "+1555" });
    expect(client.contacts.unblock).toHaveBeenCalledWith("a", "+1555");
  });

  it("manage_favorite_stickers lists, gets a file, adds from a message or an upload, and removes", async () => {
    await call("manage_favorite_stickers", { action: "list", accountId: "a", limit: 5 });
    expect(client.favoriteStickers.list).toHaveBeenCalledWith("a", { limit: 5 });

    client.favoriteStickers.getMedia!.mockResolvedValue({ object: "media", stickerId: "s1", url: "https://files.example/s1", mimeType: "image/webp", size: 10 });
    const file = await call("manage_favorite_stickers", { action: "get_file", accountId: "a", stickerId: "s1" });
    expect(client.favoriteStickers.getMedia).toHaveBeenCalledWith("a", "s1", { redirect: false });
    expect(out(file)).toMatchObject({ url: "https://files.example/s1" });

    await call("manage_favorite_stickers", { action: "add", accountId: "a", messageId: "m1" });
    expect(client.favoriteStickers.add).toHaveBeenLastCalledWith("a", { messageId: "m1" }, undefined);
    await call("manage_favorite_stickers", { action: "add", accountId: "a", uploadId: "u1", idempotencyKey: "k1" });
    expect(client.favoriteStickers.add).toHaveBeenLastCalledWith("a", { uploadId: "u1" }, { idempotencyKey: "k1" });
    expect((await call("manage_favorite_stickers", { action: "add", accountId: "a" })).isError).toBe(true);
    expect((await call("manage_favorite_stickers", { action: "add", accountId: "a", messageId: "m1", uploadId: "u1" })).isError).toBe(true);
    expect(client.favoriteStickers.add).toHaveBeenCalledTimes(2);

    // Removing is not destructive: the sticker can be favorited again.
    const removed = await call("manage_favorite_stickers", { action: "remove", accountId: "a", stickerId: "s1" });
    expect(client.favoriteStickers.remove).toHaveBeenCalledWith("a", "s1");
    expect(out(removed)).toEqual({ accountId: "a", stickerId: "s1", removed: true });
    expect((await call("manage_favorite_stickers", { action: "remove", accountId: "a" })).isError).toBe(true);
    expect(client.favoriteStickers.remove).toHaveBeenCalledTimes(1);
  });

  it("manage_profile updates the name and about, pictures and the contact link", async () => {
    await call("manage_profile", { action: "update", accountId: "a", about: "Open 9-5" });
    expect(client.profile.update).toHaveBeenCalledWith("a", { about: "Open 9-5" });
    expect((await call("manage_profile", { action: "update", accountId: "a" })).isError).toBe(true);
    expect(accepts("manage_profile", { action: "update", accountId: "a", name: "x".repeat(26) })).toBe(false);

    await call("manage_profile", { action: "set_picture", accountId: "a", pictureUrl: "https://example.com/me.jpg" });
    expect(client.profile.setPicture).toHaveBeenCalledWith("a", { url: "https://example.com/me.jpg" });
    await call("manage_profile", { action: "set_picture", accountId: "a", pictureBase64: "/9j/4AAQ" });
    expect(client.profile.setPicture).toHaveBeenLastCalledWith("a", { base64: "/9j/4AAQ" });
    expect((await call("manage_profile", { action: "set_picture", accountId: "a" })).isError).toBe(true);
    expect((await call("manage_profile", { action: "set_picture", accountId: "a", pictureUrl: "https://e.com/a.jpg", pictureBase64: "x" })).isError).toBe(true);
    expect(accepts("manage_profile", { action: "set_picture", accountId: "a", pictureUrl: "http://example.com/me.jpg" })).toBe(false);

    await call("manage_profile", { action: "delete_picture", accountId: "a", confirm: true });
    expect(client.profile.deletePicture).toHaveBeenCalledWith("a");
    client.contacts.getLink!.mockResolvedValue({ object: "contact_link", url: "https://wa.me/qr/ABC" });
    expect(out(await call("manage_profile", { action: "get_contact_link", accountId: "a" }))).toEqual({ url: "https://wa.me/qr/ABC" });
    await call("manage_profile", { action: "reset_contact_link", accountId: "a", confirm: true });
    expect(client.contacts.resetLink).toHaveBeenCalledWith("a");
  });

  it("manage_privacy reads and changes settings with WhatsApp's values", async () => {
    await call("manage_privacy", { action: "get", accountId: "a" });
    expect(client.privacy.get).toHaveBeenCalledWith("a");
    await call("manage_privacy", { action: "get_story_privacy", accountId: "a" });
    expect(client.privacy.getStoryPrivacy).toHaveBeenCalledWith("a");
    await call("manage_privacy", { action: "update", accountId: "a", readReceipts: "none", lastSeen: "contacts" });
    expect(client.privacy.update).toHaveBeenCalledWith("a", { readReceipts: "none", lastSeen: "contacts" });
    expect(accepts("manage_privacy", { action: "update", accountId: "a", readReceipts: "contacts" })).toBe(false);
    expect((await call("manage_privacy", { action: "update", accountId: "a" })).isError).toBe(true);
  });
});

describe("groups, communities and channels", () => {
  const group = { object: "group", id: "g@g.us", name: "Team", community: false, participants: [{ contactId: "+1", role: "admin" }] };

  it("manage_group_settings updates settings and pictures", async () => {
    client.groups.update!.mockResolvedValue(group);
    const res = await call("manage_group_settings", { action: "update", accountId: "a", groupId: "g@g.us", announce: true, memberAddMode: "admins" });
    expect(client.groups.update).toHaveBeenCalledWith("a", "g@g.us", { announce: true, memberAddMode: "admins" });
    expect(out(res)).toMatchObject({ id: "g@g.us", participantCount: 1 });
    expect((await call("manage_group_settings", { action: "update", accountId: "a", groupId: "g@g.us" })).isError).toBe(true);
    await call("manage_group_settings", { action: "set_picture", accountId: "a", groupId: "g@g.us", pictureUrl: "https://example.com/g.jpg" });
    expect(client.groups.setPicture).toHaveBeenCalledWith("a", "g@g.us", { url: "https://example.com/g.jpg" });
    await call("manage_group_settings", { action: "delete_picture", accountId: "a", groupId: "g@g.us", confirm: true });
    expect(client.groups.deletePicture).toHaveBeenCalledWith("a", "g@g.us");
  });

  it("manage_group_joins previews by code or link, joins and handles requests", async () => {
    client.groups.getInvite!.mockResolvedValue(group);
    await call("manage_group_joins", { action: "preview_invite", accountId: "a", code: "https://chat.whatsapp.com/AbC123" });
    expect(client.groups.getInvite).toHaveBeenCalledWith("a", "AbC123");
    await call("manage_group_joins", { action: "preview_invite", accountId: "a", code: "AbC123" });
    expect(client.groups.getInvite).toHaveBeenLastCalledWith("a", "AbC123");
    client.groups.join!.mockResolvedValue({ object: "group_join", accountId: "a", groupId: "g@g.us" });
    const joined = await call("manage_group_joins", { action: "join", accountId: "a", code: "AbC123", idempotencyKey: "k" });
    expect(client.groups.join).toHaveBeenCalledWith("a", "AbC123", { idempotencyKey: "k" });
    expect(out(joined)).toEqual({ accountId: "a", groupId: "g@g.us" });
    await call("manage_group_joins", { action: "list_requests", accountId: "a", groupId: "g@g.us" });
    expect(client.groups.listJoinRequests).toHaveBeenCalledWith("a", "g@g.us", { limit: 20 });
    client.groups.approveJoinRequests!.mockResolvedValue([{ object: "participant_result", contactId: "+1", error: null }]);
    const approved = await call("manage_group_joins", { action: "approve_requests", accountId: "a", groupId: "g@g.us", contactIds: ["+1"] });
    expect(out(approved)).toEqual({ items: [{ contactId: "+1" }] });
    client.groups.rejectJoinRequests!.mockResolvedValue([]);
    await call("manage_group_joins", { action: "reject_requests", accountId: "a", groupId: "g@g.us", contactIds: ["+2"] });
    expect(client.groups.rejectJoinRequests).toHaveBeenCalledWith("a", "g@g.us", ["+2"]);
    expect(accepts("manage_group_joins", { action: "approve_requests", accountId: "a", groupId: "g@g.us", contactIds: [] })).toBe(false);
  });

  it("manage_community creates communities and links groups", async () => {
    client.groups.create!.mockResolvedValue({ ...group, community: true, participants: [] });
    await call("manage_community", { action: "create", accountId: "a", name: "Neighbors" });
    expect(client.groups.create).toHaveBeenCalledWith("a", { name: "Neighbors", community: true }, undefined);
    await call("manage_community", { action: "list_groups", accountId: "a", communityId: "c@g.us" });
    expect(client.groups.listSubgroups).toHaveBeenCalledWith("a", "c@g.us", { limit: 20 });
    await call("manage_community", { action: "list_members", accountId: "a", communityId: "c@g.us", cursor: "x" });
    expect(client.groups.listCommunityParticipants).toHaveBeenCalledWith("a", "c@g.us", { limit: 20, cursor: "x" });
    await call("manage_community", { action: "link_group", accountId: "a", communityId: "c@g.us", groupId: "g@g.us" });
    expect(client.groups.linkSubgroup).toHaveBeenCalledWith("a", "c@g.us", "g@g.us");
    await call("manage_community", { action: "unlink_group", accountId: "a", communityId: "c@g.us", groupId: "g@g.us" });
    expect(client.groups.unlinkSubgroup).toHaveBeenCalledWith("a", "c@g.us", "g@g.us");
  });

  it("manage_channel reaches every channel endpoint", async () => {
    await call("manage_channel", { action: "list", accountId: "a" });
    expect(client.channels.list).toHaveBeenCalledWith("a", { limit: 20 });
    await call("manage_channel", { action: "get", accountId: "a", channelId: "c@newsletter" });
    expect(client.channels.get).toHaveBeenCalledWith("a", "c@newsletter");
    await call("manage_channel", { action: "preview_invite", accountId: "a", code: "https://whatsapp.com/channel/0029Va" });
    expect(client.channels.getInvite).toHaveBeenCalledWith("a", "0029Va");
    await call("manage_channel", { action: "list_messages", accountId: "a", channelId: "c@newsletter", limit: 10 });
    expect(client.channels.listMessages).toHaveBeenCalledWith("a", "c@newsletter", { limit: 10 });
    client.channels.create!.mockResolvedValue({ object: "channel", id: "n@newsletter", name: "News", role: "owner" });
    const created = await call("manage_channel", { action: "create", accountId: "a", name: "News", description: "Daily", idempotencyKey: "k" });
    expect(client.channels.create).toHaveBeenCalledWith("a", { name: "News", description: "Daily" }, { idempotencyKey: "k" });
    expect(out(created)).toMatchObject({ id: "n@newsletter" });
    for (const verb of ["follow", "unfollow", "mute", "unmute"] as const) {
      await call("manage_channel", { action: verb, accountId: "a", channelId: "c@newsletter" });
      expect(client.channels[verb]).toHaveBeenCalledWith("a", "c@newsletter");
    }
    const reacted = await call("manage_channel", { action: "react", accountId: "a", channelId: "c@newsletter", channelMessageId: "101", emoji: "" });
    expect(client.channels.react).toHaveBeenCalledWith("a", "c@newsletter", "101", "");
    expect(out(reacted)).toMatchObject({ reacted: false });
    await call("manage_channel", { action: "mark_viewed", accountId: "a", channelId: "c@newsletter", channelMessageIds: ["101", "102"] });
    expect(client.channels.markViewed).toHaveBeenCalledWith("a", "c@newsletter", ["101", "102"]);
    expect(accepts("manage_channel", { action: "mark_viewed", accountId: "a", channelId: "c", channelMessageIds: Array.from({ length: 101 }, (_, i) => `${i}`) })).toBe(false);
  });
});

describe("webhooks, projects, invitations and branding", () => {
  it("get_webhook never returns the secret", async () => {
    client.webhookEndpoints.get!.mockResolvedValue({ object: "webhook_endpoint", id: "we_1", url: "https://e.com/h", secret: "whsec_x" });
    const res = await call("get_webhook", { webhookEndpointId: "we_1" });
    expect(client.webhookEndpoints.get).toHaveBeenCalledWith("we_1");
    expect(JSON.stringify(res)).not.toContain("whsec_");
  });

  it("manage_project updates, deletes and manages keys", async () => {
    await call("manage_project", { action: "update", projectId: "ext:c_1", status: "suspended", maxAccounts: null });
    expect(client.projects.update).toHaveBeenCalledWith("ext:c_1", { status: "suspended", maxAccounts: null });
    expect((await call("manage_project", { action: "update", projectId: "p" })).isError).toBe(true);
    expect(accepts("manage_project", { action: "update", projectId: "p", externalId: "bad id" })).toBe(false);
    await call("manage_project", { action: "delete", projectId: "p", confirm: true });
    expect(client.projects.delete).toHaveBeenCalledWith("p");
    listPage(client.projects.apiKeys.list!, [{ object: "api_key", id: "k1", last4: "abcd", key: "wu_live_never" }]);
    const keys = await call("manage_project", { action: "list_keys", projectId: "p" });
    expect(client.projects.apiKeys.list).toHaveBeenCalledWith("p", { limit: 20 });
    expect(JSON.stringify(keys)).not.toContain("wu_live_");
    await call("manage_project", { action: "revoke_key", projectId: "p", apiKeyId: "k1", confirm: true });
    expect(client.projects.apiKeys.revoke).toHaveBeenCalledWith("p", "k1");
  });

  it("resend_invitation needs confirm and returns the new url", async () => {
    expect(accepts("resend_invitation", { invitationId: "inv_1" })).toBe(false);
    client.invitations.resend!.mockResolvedValue({ object: "invitation", id: "inv_1", status: "pending", url: "https://wuapi.dev/invite/new" });
    const res = await call("resend_invitation", { invitationId: "inv_1", confirm: true });
    expect(client.invitations.resend).toHaveBeenCalledWith("inv_1", undefined);
    expect(out(res)).toMatchObject({ url: "https://wuapi.dev/invite/new" });
  });

  it("manage_branding reads and updates, clearing with null", async () => {
    await call("manage_branding", { action: "get" });
    expect(client.branding.get).toHaveBeenCalled();
    await call("manage_branding", { action: "update", displayName: "Acme", logoUrl: null, accentColor: "#112233" });
    expect(client.branding.update).toHaveBeenCalledWith({ displayName: "Acme", logoUrl: null, accentColor: "#112233" });
    expect(accepts("manage_branding", { action: "update", accentColor: "red" })).toBe(false);
    expect(accepts("manage_branding", { action: "update", supportUrl: "http://e.com" })).toBe(false);
    expect((await call("manage_branding", { action: "update" })).isError).toBe(true);
  });
});
