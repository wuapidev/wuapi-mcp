import * as z from "zod";

// Prompts: ready-made starting points an MCP client lists as slash commands
// (Claude Code shows them as /mcp__wuapi__<name>). Each one tells the model
// which tools to use, in which order, and when to stop and ask.

export interface PromptDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  argsSchema: S;
  text: (args: z.infer<S>) => string;
}

function prompt<S extends z.ZodObject>(def: PromptDefinition<S>): PromptDefinition {
  return def as unknown as PromptDefinition;
}

export const PROMPTS: PromptDefinition[] = [
  prompt({
    name: "send_message",
    title: "Send a WhatsApp message",
    description: "Send a message to a number or group from one of your linked numbers.",
    argsSchema: z.object({
      to: z.string().describe("Phone number in E.164 (+584241112233) or a group id."),
      message: z.string().describe("What to send."),
      accountId: z.string().optional().describe("The account to send from. Default: ask, or the only ready one."),
    }),
    text: (a) =>
      [
        `Send this WhatsApp message with wuapi to ${a.to}:`,
        "",
        a.message,
        "",
        "Steps:",
        a.accountId
          ? `1. Use account ${a.accountId}. Check with get_account that its status is ready.`
          : "1. Call list_accounts. If exactly one account is ready, use it; if several are, ask me which one; if none is, tell me and stop.",
        "2. If the recipient is a phone number the account has not written to before, call check_numbers first. If it is not on WhatsApp, tell me and stop.",
        "3. Send it with send_text, then call get_message once and tell me its status.",
        "Do not send anything else, and do not send it twice.",
      ].join("\n"),
  }),
  prompt({
    name: "setup_webhook",
    title: "Set up a webhook",
    description: "Register an https endpoint to receive incoming messages and delivery updates.",
    argsSchema: z.object({
      url: z.string().describe("Your public https endpoint."),
      events: z.string().optional().describe("Comma-separated event types. Default: messages and account status."),
    }),
    text: (a) =>
      [
        `Set up a wuapi webhook endpoint at ${a.url}.`,
        "",
        `Events: ${a.events?.trim() || "message.received, message.sent, message.delivered, message.read, message.failed, account.connected, account.disconnected"}.`,
        "",
        "Steps:",
        "1. Call list_webhooks. If an endpoint with this URL exists, show it and ask whether to update its events with update_webhook instead of creating another.",
        "2. Otherwise call create_webhook. The signing secret is not returned to you: tell me to reveal it in the wuapi dashboard under Webhooks and store it on the server.",
        "3. Explain how to verify the Wuapi-Signature header: with the TypeScript SDK, verifyWebhook(rawBody, header, secret) from @wuapidev/sdk; otherwise an HMAC-SHA256 of `<t>.<rawBody>` keyed with the secret, compared in constant time, rejecting timestamps older than 5 minutes.",
        "4. Remind me that the endpoint must answer 2xx within 10 seconds, and that events can arrive more than once (deduplicate on the event id).",
      ].join("\n"),
  }),
  prompt({
    name: "invite_customer",
    title: "Invite a customer to link their number",
    description: "Create a project for a customer (if needed) and an invitation link they open to connect their own WhatsApp.",
    argsSchema: z.object({
      customer: z.string().describe("The customer's name."),
      externalId: z.string().optional().describe("Your own id for this customer."),
      email: z.string().optional().describe("Their email, to send the invitation."),
    }),
    text: (a) =>
      [
        `Invite ${a.customer} to link their WhatsApp number with wuapi.`,
        "",
        "Steps:",
        a.externalId
          ? `1. Look for their project with list_projects (externalId ${a.externalId}). If there is none, create it with create_project, name "${a.customer}", externalId "${a.externalId}".`
          : `1. Ask me whether ${a.customer} needs a project of their own. If yes, create it with create_project.`,
        `2. Call create_invitation for that project with inviteeName "${a.customer}"${a.email ? ` and inviteeEmail "${a.email}"` : ""}.`,
        "3. Give me the invitation url to send them, and when it expires. Then I can check progress with get_invitation.",
      ].join("\n"),
  }),
];
