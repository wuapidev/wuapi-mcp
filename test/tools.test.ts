import { readFileSync } from "node:fs";
import { WuapiError } from "@wuapidev/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { errorResult, type ToolResult } from "../src/format.js";
import { TOOL_GROUPS, TOOLS } from "../src/tools.js";
import { account, asWuapi, listPage, message, mockClient, type MockClient } from "./helpers.js";

let client: MockClient;
beforeEach(() => {
  client = mockClient();
});

/** Validate the arguments with the tool's schema, run it, and turn a throw into the error result, as the server does. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  const parsed = def.inputSchema.parse(args);
  try {
    return await def.run(asWuapi(client), parsed as never);
  } catch (err) {
    return errorResult(err);
  }
}

function schemaAccepts(name: string, args: Record<string, unknown>): boolean {
  return TOOLS.find((t) => t.name === name)!.inputSchema.safeParse(args).success;
}

describe("catalog", () => {
  it("has unique snake_case names, a title, a description and a known group", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name, t.name).toMatch(/^[a-z][a-z_]{2,40}$/);
      expect(t.title.length, t.name).toBeGreaterThan(3);
      expect(t.description.length, t.name).toBeGreaterThan(30);
      expect(TOOL_GROUPS).toContain(t.group);
    }
  });

  it("marks reads read-only and never destructive", () => {
    for (const t of TOOLS.filter((t) => t.annotations.readOnlyHint)) {
      expect(t.annotations.destructiveHint, t.name).toBe(false);
      expect(t.name, t.name).toMatch(/^(get|list|check|lookup)_/);
    }
    for (const t of TOOLS.filter((t) => /^(get|list)_/.test(t.name))) expect(t.annotations.readOnlyHint, t.name).toBe(true);
  });

  it("makes every destructive tool require confirm: true", () => {
    const destructive = TOOLS.filter((t) => t.annotations.destructiveHint && !t.actions);
    expect(destructive.map((t) => t.name).sort()).toEqual(
      [
        "cancel_invitation", "cancel_message", "delete_chat", "delete_message", "delete_webhook", "leave_group",
        "remove_group_participants", "resend_invitation", "reset_group_invite_link",
      ].sort(),
    );
    for (const t of destructive) {
      const json = z.toJSONSchema(t.inputSchema) as { required?: string[]; properties: Record<string, { const?: unknown }> };
      expect(json.required, t.name).toContain("confirm");
      expect(json.properties.confirm?.const, t.name).toBe(true);
    }
    expect(schemaAccepts("delete_message", { messageId: "m" })).toBe(false);
    expect(schemaAccepts("delete_message", { messageId: "m", confirm: false })).toBe(false);
    expect(schemaAccepts("delete_message", { messageId: "m", confirm: true })).toBe(true);
  });

  it("makes every destructive action require confirm: true, and only those", () => {
    const destructive: string[] = [];
    for (const t of TOOLS.filter((t) => t.actions)) {
      for (const [action, spec] of Object.entries(t.actions!.specs)) {
        if (spec.annotations.destructiveHint) destructive.push(`${t.name}.${action}`);
        expect(spec.required.includes("confirm"), `${t.name}.${action}`).toBe(spec.annotations.destructiveHint);
      }
      expect(t.annotations.destructiveHint, t.name).toBe(Object.values(t.actions!.specs).some((s) => s.annotations.destructiveHint));
    }
    expect(destructive.sort()).toEqual(
      [
        "manage_block_list.block", "manage_group_settings.delete_picture", "manage_labels.delete", "manage_profile.delete_picture",
        "manage_profile.reset_contact_link", "manage_project.delete", "manage_project.revoke_key", "manage_stories.delete", "unlink_account.delete", "unlink_account.logout",
      ].sort(),
    );
  });
  it("produces a JSON schema for every tool input", () => {
    for (const t of TOOLS) {
      const json = z.toJSONSchema(t.inputSchema) as { type: string };
      expect(json.type, t.name).toBe("object");
    }
  });

  it("lists every tool in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const t of TOOLS) expect(readme, t.name).toContain(`\`${t.name}\``);
    expect(readme).toContain(`${TOOLS.length} tools reach every operation`);
    for (const t of TOOLS.filter((t) => t.actions)) {
      const row = readme.split("\n").find((l) => l.startsWith(`| \`${t.name}\` |`));
      expect(row, t.name).toBeDefined();
      const listed = [...row!.split("|")[2]!.matchAll(/`([a-z_]+)`(\\\*)?/g)].map((m) => `${m[1]}${m[2] ? "*" : ""}`);
      expect(listed, t.name).toEqual(t.actions!.names.map((a) => `${a}${t.actions!.specs[a]!.annotations.destructiveHint ? "*" : ""}`));
    }
  });

  it("covers the requested areas", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const n of [
      "list_accounts", "get_account", "get_account_qr_code", "create_account", "request_pairing_code",
      "send_text", "send_media", "upload_file", "send_location", "send_contact", "send_poll", "react_to_message", "reply_to_message",
      "get_message", "list_messages", "edit_message", "delete_message", "cancel_message",
      "list_chats", "get_chat", "mark_chat_read", "archive_chat", "pin_chat", "mute_chat",
      "list_contacts", "get_contact", "check_numbers", "lookup_contacts",
      "create_group", "get_group", "add_group_participants", "remove_group_participants", "promote_group_participants", "demote_group_participants", "get_group_invite_link", "leave_group",
      "post_story", "list_webhooks", "create_webhook", "update_webhook", "delete_webhook",
      "create_project", "create_invitation", "get_usage",
    ]) {
      expect(names.has(n), n).toBe(true);
    }
  });
});

describe("messages", () => {
  it("send_text sends a text with the idempotency key", async () => {
    client.messages.send!.mockResolvedValue(message());
    const res = await call("send_text", { accountId: "acc_1", to: "+584241112233", text: "hi", idempotencyKey: "k1" });
    expect(client.messages.send).toHaveBeenCalledWith({ accountId: "acc_1", to: "+584241112233", type: "text", text: "hi" }, { idempotencyKey: "k1" });
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as { message: { id: string } }).message.id).toBe("msg_1");
  });

  it("get_message fetches on-demand media only when asked", async () => {
    const media = { url: "https://api.wuapi.dev/v1/messages/msg_1/media", mimeType: "image/jpeg", filename: null, size: 10, downloaded: false };
    client.messages.get!.mockResolvedValue(message({ type: "image", media }));
    const file = { object: "media", messageId: "msg_1", url: "https://files.example/x", mimeType: "image/jpeg", filename: null, size: 10 };
    client.messages.getMedia!.mockResolvedValue(file);
    const plain = await call("get_message", { messageId: "msg_1" });
    expect(client.messages.getMedia).not.toHaveBeenCalled();
    expect((plain.structuredContent as { mediaFile?: unknown }).mediaFile).toBeUndefined();
    const res = await call("get_message", { messageId: "msg_1", fetchMedia: true });
    expect(client.messages.getMedia).toHaveBeenCalledWith("msg_1", { redirect: false });
    expect((res.structuredContent as { mediaFile: { url: string } }).mediaFile.url).toBe("https://files.example/x");
  });

  it("update_account passes mediaAutoDownload", async () => {
    client.accounts.update!.mockResolvedValue(account());
    await call("update_account", { accountId: "acc_1", mediaAutoDownload: { maxBytes: 5242880, types: ["image"] } });
    expect(client.accounts.update).toHaveBeenCalledWith("acc_1", { mediaAutoDownload: { maxBytes: 5242880, types: ["image"] } });
    expect(schemaAccepts("update_account", { accountId: "acc_1", mediaAutoDownload: "sometimes" })).toBe(false);
  });

  it("update_account passes imageQuality", async () => {
    client.accounts.update!.mockResolvedValue(account());
    await call("update_account", { accountId: "acc_1", imageQuality: "hd" });
    expect(client.accounts.update).toHaveBeenCalledWith("acc_1", { imageQuality: "hd" });
    expect(schemaAccepts("update_account", { accountId: "acc_1", imageQuality: "best" })).toBe(false);
  });

  it("send_media passes quality for an image and drops it for other files", async () => {
    client.messages.send!.mockResolvedValue(message({ type: "image" }));
    await call("send_media", { accountId: "acc_1", to: "+1555", type: "image", url: "https://example.com/a.jpg", quality: "hd" });
    expect(client.messages.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "image", media: { url: "https://example.com/a.jpg", quality: "hd" } }),
      undefined,
    );
    await call("send_media", { accountId: "acc_1", to: "+1555", type: "video", url: "https://example.com/a.mp4", quality: "hd" });
    expect(client.messages.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "video", media: { url: "https://example.com/a.mp4" } }), undefined);
    expect(schemaAccepts("send_media", { accountId: "a", to: "+1", type: "image", url: "https://example.com/a.jpg", quality: "best" })).toBe(false);
  });

  it("rejects an empty text before calling the API", () => {
    expect(schemaAccepts("send_text", { accountId: "acc_1", to: "+1", text: "" })).toBe(false);
  });

  it("send_media maps the caption to text and drops viewOnce for documents", async () => {
    client.messages.send!.mockResolvedValue(message({ type: "document" }));
    await call("send_media", { accountId: "acc_1", to: "+1555", type: "document", url: "https://example.com/a.pdf", caption: "Invoice", filename: "a.pdf", viewOnce: true });
    expect(client.messages.send).toHaveBeenCalledWith(
      { accountId: "acc_1", to: "+1555", type: "document", media: { url: "https://example.com/a.pdf", filename: "a.pdf" }, text: "Invoice" },
      undefined,
    );
  });

  it("upload_file uploads the bytes in one call, and send_media sends the upload by id", async () => {
    client.uploads.create!.mockResolvedValue({ object: "upload", id: "upl_1", status: "ready", mimeType: "image/png", filename: null, size: 3, uploadUrl: null });
    const res = await call("upload_file", { base64: "cG5n", mimeType: "image/png", filename: "paste.png", idempotencyKey: "u1" });
    expect(client.uploads.create).toHaveBeenCalledWith({ mimeType: "image/png", base64: "cG5n", filename: "paste.png" }, { idempotencyKey: "u1" });
    expect((res.structuredContent as { upload: { id: string; status: string } }).upload).toMatchObject({ id: "upl_1", status: "ready" });

    client.messages.send!.mockResolvedValue(message({ type: "voice" }));
    await call("send_media", { accountId: "acc_1", to: "+1555", type: "voice", uploadId: "upl_1" });
    expect(client.messages.send).toHaveBeenCalledWith({ accountId: "acc_1", to: "+1555", type: "voice", media: { uploadId: "upl_1" } }, undefined);
    await call("send_media", { accountId: "acc_1", to: "+1555", type: "image", uploadId: "upl_1", quality: "original" });
    expect(client.messages.send).toHaveBeenLastCalledWith({ accountId: "acc_1", to: "+1555", type: "image", media: { uploadId: "upl_1", quality: "original" } }, undefined);
  });

  it("send_media and post_story take exactly one of a URL or an upload", async () => {
    const both = await call("send_media", { accountId: "a", to: "+1", type: "image", url: "https://example.com/a.jpg", uploadId: "upl_1" });
    expect(both.isError).toBe(true);
    expect((await call("send_media", { accountId: "a", to: "+1", type: "image" })).isError).toBe(true);
    expect(client.messages.send).not.toHaveBeenCalled();

    client.stories.create!.mockResolvedValue(message({ type: "image" }));
    await call("post_story", { accountId: "a", type: "image", uploadId: "upl_1", text: "hi" });
    expect(client.stories.create).toHaveBeenLastCalledWith("a", { type: "image", media: { uploadId: "upl_1" }, text: "hi" }, undefined);
    await call("post_story", { accountId: "a", type: "image", mediaUrl: "https://example.com/a.jpg" });
    expect(client.stories.create).toHaveBeenLastCalledWith("a", { type: "image", media: { url: "https://example.com/a.jpg" } }, undefined);
    expect((await call("post_story", { accountId: "a", type: "image" })).isError).toBe(true);
    expect((await call("post_story", { accountId: "a", type: "image", mediaUrl: "https://example.com/a.jpg", uploadId: "upl_1" })).isError).toBe(true);
    expect(client.stories.create).toHaveBeenCalledTimes(2);
  });

  it("manage_stories reads stories without viewing them, and views, reacts and replies only when asked", async () => {
    const story = { object: "story", id: "st_1", accountId: "a", contactId: "+584241112233", own: false, type: "image", media: { downloaded: false }, viewedAt: null };
    const pageOf = listPage(client.stories.list!, [{ object: "story_group", contactId: "+584241112233", stories: [story] }]);
    const listed = await call("manage_stories", { action: "list", accountId: "a", unviewed: true, limit: 5 });
    expect(client.stories.list).toHaveBeenCalledWith("a", { unviewed: true, limit: 5 });
    expect(pageOf).toHaveBeenCalledTimes(1);
    expect((listed.structuredContent as { items: unknown[] }).items).toHaveLength(1);

    client.stories.get!.mockResolvedValue(story);
    client.stories.getMedia!.mockResolvedValue({ object: "media", storyId: "st_1", url: "https://files.example/x" });
    const got = await call("manage_stories", { action: "get", accountId: "a", storyId: "st_1", fetchMedia: true });
    expect(client.stories.getMedia).toHaveBeenCalledWith("a", "st_1", { redirect: false });
    expect((got.structuredContent as { mediaFile: { url: string } }).mediaFile.url).toBe("https://files.example/x");
    await call("manage_stories", { action: "list_own", accountId: "a" });
    await call("manage_stories", { action: "viewers", accountId: "a", storyId: "st_1" });
    expect(client.stories.listViewers).toHaveBeenCalledWith("a", "st_1", { limit: 20 });
    // Nothing so far told the contact anything.
    expect(client.stories.view).not.toHaveBeenCalled();

    client.stories.view!.mockResolvedValue({ ...story, viewedAt: "2026-10-01T12:00:00.000Z", authorNotified: true });
    const viewed = await call("manage_stories", { action: "view", accountId: "a", storyId: "st_1" });
    expect(client.stories.view).toHaveBeenCalledWith("a", "st_1", undefined);
    expect((viewed.structuredContent as { authorNotified: boolean }).authorNotified).toBe(true);

    await call("manage_stories", { action: "react", accountId: "a", storyId: "st_1", emoji: "💚" });
    expect(client.stories.react).toHaveBeenCalledWith("a", "st_1", { emoji: "💚" });

    client.messages.send!.mockResolvedValue(message());
    await call("manage_stories", { action: "reply", accountId: "a", storyId: "st_1", text: "Looks great", idempotencyKey: "k" });
    expect(client.messages.send).toHaveBeenLastCalledWith(
      { accountId: "a", to: "+584241112233", type: "text", text: "Looks great", replyToStoryId: "st_1" },
      { idempotencyKey: "k" },
    );
    // The account's own story takes no reply.
    client.stories.get!.mockResolvedValue({ ...story, own: true });
    expect((await call("manage_stories", { action: "reply", accountId: "a", storyId: "st_1", text: "x" })).isError).toBe(true);
    expect(client.messages.send).toHaveBeenCalledTimes(1);

    // Deleting needs confirm.
    expect((await call("manage_stories", { action: "delete", accountId: "a", storyId: "st_1" })).isError).toBe(true);
    expect(client.stories.delete).not.toHaveBeenCalled();
    await call("manage_stories", { action: "delete", accountId: "a", storyId: "st_1", confirm: true });
    expect(client.stories.delete).toHaveBeenCalledWith("a", "st_1");
  });

  it("send_media refuses URLs that are not http(s)", () => {
    expect(schemaAccepts("send_media", { accountId: "a", to: "+1", type: "image", url: "file:///etc/passwd" })).toBe(false);
    expect(schemaAccepts("send_media", { accountId: "a", to: "+1", type: "image", url: "javascript:alert(1)" })).toBe(false);
  });

  it("send_contact sends one card as contact and several as contacts", async () => {
    client.messages.send!.mockResolvedValue(message());
    await call("send_contact", { accountId: "a", to: "+1", contacts: [{ name: "Ana", phone: "+1555" }] });
    expect(client.messages.send).toHaveBeenLastCalledWith({ accountId: "a", to: "+1", type: "contact", contact: { name: "Ana", phone: "+1555" } }, undefined);
    await call("send_contact", { accountId: "a", to: "+1", contacts: [{ name: "Ana", phone: "+1555" }, { name: "Bo", phone: "+1666" }] });
    expect(client.messages.send).toHaveBeenLastCalledWith(
      { accountId: "a", to: "+1", type: "contacts", contacts: [{ name: "Ana", phone: "+1555" }, { name: "Bo", phone: "+1666" }] },
      undefined,
    );
  });

  it("send_location and send_poll build their objects", async () => {
    client.messages.send!.mockResolvedValue(message());
    await call("send_location", { accountId: "a", to: "+1", latitude: 10.5, longitude: -66.9, name: "Office" });
    expect(client.messages.send).toHaveBeenLastCalledWith({ accountId: "a", to: "+1", type: "location", location: { latitude: 10.5, longitude: -66.9, name: "Office" } }, undefined);
    await call("send_poll", { accountId: "a", to: "+1", question: "Lunch?", options: ["Yes", "No"], selectableCount: 1 });
    expect(client.messages.send).toHaveBeenLastCalledWith({ accountId: "a", to: "+1", type: "poll", poll: { name: "Lunch?", options: ["Yes", "No"], selectableCount: 1 } }, undefined);
  });

  it("reply_to_message quotes the message in its own chat, from its account", async () => {
    client.messages.get!.mockResolvedValue(message({ id: "msg_in", accountId: "acc_9", chatId: "120363@g.us", chatType: "group", direction: "inbound" }));
    client.messages.send!.mockResolvedValue(message());
    await call("reply_to_message", { messageId: "msg_in", text: "On it" });
    expect(client.messages.send).toHaveBeenCalledWith({ accountId: "acc_9", to: "120363@g.us", type: "text", text: "On it", replyToMessageId: "msg_in" }, undefined);
  });

  it("reply_to_message refuses channel posts", async () => {
    client.messages.get!.mockResolvedValue(message({ chatType: "channel" }));
    const res = await call("reply_to_message", { messageId: "m", text: "x" });
    expect(res.isError).toBe(true);
    expect(client.messages.send).not.toHaveBeenCalled();
  });

  it("cancel_message deletes only a queued message", async () => {
    client.messages.get!.mockResolvedValueOnce(message({ status: "sent" }));
    const refused = await call("cancel_message", { messageId: "m", confirm: true });
    expect(refused.isError).toBe(true);
    expect((refused.structuredContent as { error: { code: string } }).error.code).toBe("not_queued");
    expect(client.messages.delete).not.toHaveBeenCalled();

    client.messages.get!.mockResolvedValueOnce(message({ status: "queued" }));
    const done = await call("cancel_message", { messageId: "m", confirm: true });
    expect(done.isError).toBeUndefined();
    expect(client.messages.delete).toHaveBeenCalledWith("m");
  });

  it("delete_message passes forEveryone", async () => {
    await call("delete_message", { messageId: "m", forEveryone: false, confirm: true });
    expect(client.messages.delete).toHaveBeenCalledWith("m", { forEveryone: false });
  });

  it("list_messages sends the filters and a default page size", async () => {
    const page = listPage(client.messages.list!, [message()], "cur_2");
    const res = await call("list_messages", { accountId: "acc_1", direction: "inbound" });
    expect(client.messages.list).toHaveBeenCalledWith({ accountId: "acc_1", direction: "inbound", limit: 20 });
    expect(page).toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ nextCursor: "cur_2", hasMore: true });
  });
});

describe("accounts", () => {
  it("get_account drops the QR code image and says whether one is waiting", async () => {
    client.accounts.get!.mockResolvedValue(account({ status: "qr_ready", qrCodeUrl: "data:image/png;base64,AAAA" }));
    const res = await call("get_account", { accountId: "acc_1" });
    const out = res.structuredContent as Record<string, unknown>;
    expect(out.hasQrCode).toBe(true);
    expect(out).not.toHaveProperty("qrCodeUrl");
    expect(out).not.toHaveProperty("pacing");
    expect(JSON.stringify(res)).not.toContain("base64");
  });

  it("get_account_qr_code returns the QR code as an image", async () => {
    client.accounts.waitForQrCode!.mockResolvedValue(account({ status: "qr_ready", qrCodeUrl: "data:image/png;base64,iVBORw0KGgo=" }));
    const res = await call("get_account_qr_code", { accountId: "acc_1" });
    expect(client.accounts.waitForQrCode).toHaveBeenCalledWith("acc_1", { timeoutMs: 15_000, intervalMs: 2_000 });
    expect(res.content).toContainEqual({ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });
  });

  it("get_account_qr_code answers with the status when no QR code came in time", async () => {
    client.accounts.waitForQrCode!.mockRejectedValue(
      new WuapiError({ status: 0, code: "wait_timeout", message: "Timed out", details: { account: account({ status: "initializing" }) } }),
    );
    const res = await call("get_account_qr_code", { accountId: "acc_1", waitSeconds: 5 });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ status: "initializing" });
  });

  it("create_account passes the proxy location and project", async () => {
    client.accounts.create!.mockResolvedValue(account({ status: "initializing" }));
    await call("create_account", { proxyLocation: { country: "US", city: "newyorkcity" }, name: "Desk", projectId: "ext:c_1" });
    expect(client.accounts.create).toHaveBeenCalledWith({ proxyLocation: { country: "US", city: "newyorkcity" }, name: "Desk", projectId: "ext:c_1" }, undefined);
  });

  it("list_accounts compacts every account", async () => {
    listPage(client.accounts.list!, [account({ qrCodeUrl: "data:image/png;base64,AAAA" })]);
    const res = await call("list_accounts", { projectId: "none", limit: 5 });
    expect(client.accounts.list).toHaveBeenCalledWith({ projectId: "none", limit: 5 });
    expect(JSON.stringify(res)).not.toContain("base64");
  });
});

describe("chats, contacts and groups", () => {
  it("list_chats sends the filters and keeps the latest message short", async () => {
    const chat = {
      object: "chat", id: "+584241112233", projectId: null, accountId: "a", type: "direct", name: "Maria", savedName: "Maria", profileName: "Maria G.",
      username: null, pictureId: "1727164540", lastMessage: message({ id: "m_9", text: "ok", direction: "inbound", status: "received" }), lastMessageAt: "2026-09-24T08:21:05.000Z",
      unread: true, unreadCount: 2, pinned: null, archived: null, muted: null, muteExpiresAt: null,
    };
    listPage(client.chats.list!, [chat], "cur_2");
    const res = await call("list_chats", { accountId: "a", unread: true, type: "direct", q: "maria" });
    expect(client.chats.list).toHaveBeenCalledWith("a", { unread: true, type: "direct", q: "maria", limit: 20 });
    const out = res.structuredContent as { items: Array<Record<string, unknown>>; nextCursor: string; hasMore: boolean };
    expect(out).toMatchObject({ nextCursor: "cur_2", hasMore: true });
    expect(out.items[0]).toMatchObject({ id: "+584241112233", name: "Maria", unread: true, unreadCount: 2 });
    expect(out.items[0]!.lastMessage).toEqual({ id: "m_9", direction: "inbound", from: chat.lastMessage.from, type: "text", text: "ok", status: "received" });

    await call("list_chats", { accountId: "a", archived: false });
    expect(client.chats.list).toHaveBeenLastCalledWith("a", { archived: false, limit: 20 });
  });

  it("get_chat returns the chat with its latest message", async () => {
    client.chats.get!.mockResolvedValue({ object: "chat", id: "+1", lastMessage: message({ id: "m_9" }), pinned: false, archived: null });
    const res = await call("get_chat", { accountId: "a", chatId: "+1" });
    expect(client.chats.get).toHaveBeenCalledWith("a", "+1");
    const out = res.structuredContent as Record<string, unknown>;
    expect(out).toMatchObject({ id: "+1", pinned: false, lastMessage: { id: "m_9", chatId: "+584241112233" } });
    // A state wuapi never observed is left out, not reported as false.
    expect(out).not.toHaveProperty("archived");
  });

  it("list_contacts sends the search and pages; get_contact returns one", async () => {
    const contact = {
      object: "contact", id: "+584241112233", accountId: "a", phone: "+584241112233", lid: null, savedName: "Maria Gonzalez", profileName: "Maria G.",
      username: null, about: null, pictureId: "1727164540", businessName: null, deviceCount: null,
    };
    listPage(client.contacts.list!, [contact], "cur_2");
    const res = await call("list_contacts", { accountId: "a", q: "maria" });
    expect(client.contacts.list).toHaveBeenCalledWith("a", { q: "maria", limit: 20 });
    const out = res.structuredContent as { items: Array<Record<string, unknown>>; nextCursor: string; hasMore: boolean };
    expect(out).toMatchObject({ nextCursor: "cur_2", hasMore: true });
    expect(out.items[0]).toMatchObject({ id: "+584241112233", savedName: "Maria Gonzalez", pictureId: "1727164540" });
    await call("list_contacts", { accountId: "a" });
    expect(client.contacts.list).toHaveBeenLastCalledWith("a", { limit: 20 });

    client.contacts.get!.mockResolvedValue(contact);
    const one = await call("get_contact", { accountId: "a", contactId: "+584241112233" });
    expect(client.contacts.get).toHaveBeenCalledWith("a", "+584241112233");
    expect(one.structuredContent).toMatchObject({ id: "+584241112233", savedName: "Maria Gonzalez" });
  });

  it("archive_chat, pin_chat and mute_chat pick the right call", async () => {
    await call("archive_chat", { accountId: "a", chatId: "+1" });
    expect(client.chats.archive).toHaveBeenCalledWith("a", "+1");
    await call("archive_chat", { accountId: "a", chatId: "+1", archived: false });
    expect(client.chats.unarchive).toHaveBeenCalledWith("a", "+1");
    await call("pin_chat", { accountId: "a", chatId: "+1", pinned: false });
    expect(client.chats.unpin).toHaveBeenCalledWith("a", "+1");
    await call("mute_chat", { accountId: "a", chatId: "+1", durationSeconds: 3600 });
    expect(client.chats.mute).toHaveBeenCalledWith("a", "+1", { durationSeconds: 3600 });
    await call("mark_chat_read", { accountId: "a", chatId: "+1" });
    expect(client.chats.markRead).toHaveBeenCalledWith("a", "+1");
  });

  it("check_numbers and lookup_contacts return items", async () => {
    client.contacts.check!.mockResolvedValue([{ object: "contact_check", phone: "+1555", onWhatsApp: true, contactId: "+1555", businessName: null, username: "ana" }]);
    const res = await call("check_numbers", { accountId: "a", phones: ["+1555"] });
    expect(res.structuredContent).toEqual({ items: [{ phone: "+1555", onWhatsApp: true, contactId: "+1555", username: "ana" }] });
    expect(schemaAccepts("check_numbers", { accountId: "a", phones: Array.from({ length: 51 }, (_, i) => `+1555${i}`) })).toBe(false);
  });

  it("group participant tools call the matching SDK method", async () => {
    for (const [tool, method] of [
      ["add_group_participants", "addParticipants"],
      ["promote_group_participants", "promoteParticipants"],
      ["demote_group_participants", "demoteParticipants"],
    ] as const) {
      client.groups[method]!.mockResolvedValue([]);
      await call(tool, { accountId: "a", groupId: "g@g.us", contactIds: ["+1555"] });
      expect(client.groups[method]).toHaveBeenCalledWith("a", "g@g.us", ["+1555"]);
    }
    client.groups.removeParticipants!.mockResolvedValue([]);
    await call("remove_group_participants", { accountId: "a", groupId: "g@g.us", contactIds: ["+1555"], confirm: true });
    expect(client.groups.removeParticipants).toHaveBeenCalledWith("a", "g@g.us", ["+1555"]);
  });

  it("create_group creates a group, inside a community when communityId is given", async () => {
    client.groups.create!.mockResolvedValue({ object: "group", id: "g@g.us", name: "Team", communityId: null, participants: [] });
    await call("create_group", { accountId: "a", name: "Team", participants: ["+1555"] });
    expect(client.groups.create).toHaveBeenLastCalledWith("a", { name: "Team", participants: ["+1555"] }, undefined);
    client.groups.create!.mockResolvedValue({ object: "group", id: "g@g.us", name: "Volunteers", communityId: "c@g.us", participants: [] });
    const res = await call("create_group", { accountId: "a", name: "Volunteers", participants: ["+1555"], communityId: "c@g.us", idempotencyKey: "k" });
    expect(client.groups.create).toHaveBeenLastCalledWith("a", { name: "Volunteers", participants: ["+1555"], communityId: "c@g.us" }, { idempotencyKey: "k" });
    expect(res.structuredContent).toMatchObject({ id: "g@g.us", communityId: "c@g.us" });
  });

  it("list_groups says which community each group belongs to", async () => {
    listPage(client.groups.list!, [
      { object: "group", id: "c@g.us", name: "Town", community: true, communityId: null, default: false, participants: [] },
      { object: "group", id: "g@g.us", name: "Announcements", community: false, communityId: "c@g.us", default: true, participants: [] },
    ]);
    const res = await call("list_groups", { accountId: "a" });
    expect((res.structuredContent as { items: unknown[] }).items).toEqual([
      // (a null is left out of a result: no `communityId` means the group is in no community)
      { id: "c@g.us", name: "Town", community: true, default: false, participantCount: 0 },
      { id: "g@g.us", name: "Announcements", community: false, communityId: "c@g.us", default: true, participantCount: 0 },
    ]);
    const described = TOOLS.find((t) => t.name === "list_groups")?.description ?? "";
    expect(described).toContain("communityId");
  });

  it("list_groups returns counts, not every participant", async () => {
    listPage(client.groups.list!, [{ object: "group", id: "g@g.us", name: "Team", participants: [{ contactId: "+1", role: "admin" }, { contactId: "+2", role: "member" }] }]);
    const res = await call("list_groups", { accountId: "a" });
    expect((res.structuredContent as { items: unknown[] }).items[0]).toEqual({ id: "g@g.us", name: "Team", participantCount: 2 });
  });
});

describe("webhooks, projects, invitations, usage", () => {
  it("create_webhook never returns the signing secret", async () => {
    client.webhookEndpoints.create!.mockResolvedValue({
      object: "webhook_endpoint",
      id: "we_1",
      projectId: null,
      url: "https://example.com/hook",
      events: ["message.received"],
      active: true,
      secret: "whsec_supersecret",
      createdAt: "x",
      updatedAt: "x",
    });
    const res = await call("create_webhook", { url: "https://example.com/hook", events: ["message.received"] });
    expect(JSON.stringify(res)).not.toContain("whsec_");
    expect(JSON.stringify(res)).toContain("we_1");
  });

  it("create_webhook refuses plain http and unknown events", () => {
    expect(schemaAccepts("create_webhook", { url: "http://example.com", events: ["message.received"] })).toBe(false);
    expect(schemaAccepts("create_webhook", { url: "https://example.com", events: ["message.nope"] })).toBe(false);
    expect(schemaAccepts("create_webhook", { url: "https://example.com", events: ["webhook.test"] })).toBe(false);
  });

  it("update_webhook needs a change", async () => {
    const res = await call("update_webhook", { webhookEndpointId: "we_1" });
    expect(res.isError).toBe(true);
    expect(client.webhookEndpoints.update).not.toHaveBeenCalled();
  });

  it("create_invitation passes the fields and returns the url", async () => {
    client.invitations.create!.mockResolvedValue({ object: "invitation", id: "inv_1", status: "pending", url: "https://wuapi.dev/invite/tok" });
    const res = await call("create_invitation", { projectId: "ext:c_1", inviteeName: "Ana", idempotencyKey: "k" });
    expect(client.invitations.create).toHaveBeenCalledWith({ projectId: "ext:c_1", inviteeName: "Ana" }, { idempotencyKey: "k" });
    expect(res.structuredContent).toMatchObject({ url: "https://wuapi.dev/invite/tok" });
  });

  it("get_usage_by_project reads one project or all", async () => {
    client.projects.getUsage!.mockResolvedValue({ object: "project_usage", projectId: "p" });
    client.usage.byProject!.mockResolvedValue({ object: "usage_report" });
    await call("get_usage_by_project", { projectId: "p", month: "2026-08" });
    expect(client.projects.getUsage).toHaveBeenCalledWith("p", { month: "2026-08" });
    await call("get_usage_by_project", {});
    expect(client.usage.byProject).toHaveBeenCalledWith({});
    expect(schemaAccepts("get_usage_by_project", { month: "2026-13" })).toBe(false);
  });
});

describe("errors", () => {
  it("turns an API error into an error result with its code and request id", async () => {
    client.messages.send!.mockRejectedValue(
      new WuapiError({ status: 409, code: "account_not_ready", message: "The account is not connected.", requestId: "req_123" }),
    );
    const res = await call("send_text", { accountId: "a", to: "+1", text: "hi" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ error: { code: "account_not_ready", status: 409, requestId: "req_123" } });
    expect(res.content[0]).toMatchObject({ type: "text" });
  });

  it("does not leak unexpected error messages", async () => {
    client.messages.get!.mockRejectedValue(new Error("boom at /internal/path with wu_live_secret"));
    const res = await call("get_message", { messageId: "m" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).not.toContain("wu_live_");
    expect(JSON.stringify(res)).not.toContain("/internal/path");
  });
});
