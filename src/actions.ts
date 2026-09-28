import type { Wuapi } from "@wuapidev/sdk";
import * as z from "zod";
import { ToolInputError, type ToolResult } from "./format.js";
import type { ToolAnnotations, ToolDefinition, ToolGroup } from "./tools.js";

// Tools with an `action`: one tool for a resource with many small operations
// (a channel: list, get, follow, mute, react...), so the catalog stays short
// enough for a model to pick the right tool.
//
// Each action declares which of the tool's fields it needs. From that:
//
// - `actionSchema` is the exact input, a discriminated union on `action`
//   (zod). Every call is parsed with it before the action runs, so a missing
//   or misplaced argument is refused with a message that names the action.
// - `inputSchema`, what clients see, is the same thing flattened into one
//   object: `action` as an enum and every field optional, each field saying
//   which actions use it. MCP clients and model APIs expect a plain object
//   schema at the root; several refuse a root `oneOf`/`anyOf`.
// - The tool's annotations add up its actions': read-only only when every
//   action reads, destructive when any action is. Destructive actions require
//   `confirm: true`.
// - `readOnlyVariant` is the same tool restricted to its reading actions, what
//   a read-only server registers instead of leaving the reads out.

type Fields = Record<string, z.ZodType>;

type ActionArgs<F extends Fields, R extends keyof F, O extends keyof F> = { action: string } & { [K in R]: z.output<F[K]> } & {
  [K in O]?: z.output<F[K]> | undefined;
};

export interface ActionSpec {
  /** One sentence for the tool description: what the action does and returns. */
  summary: string;
  annotations: ToolAnnotations;
  required: readonly string[];
  optional: readonly string[];
  run: (client: Wuapi, args: Record<string, unknown>) => Promise<ToolResult>;
}

/** Declares one action of a tool with these fields, typing its arguments from the fields it names. */
export type ActionFactory<F extends Fields> = <R extends keyof F & string = never, O extends keyof F & string = never>(spec: {
  summary: string;
  annotations: ToolAnnotations;
  required?: readonly R[];
  optional?: readonly O[];
  run: (client: Wuapi, args: ActionArgs<F, R, O>) => Promise<ToolResult>;
}) => ActionSpec;

const declare = ((spec: { summary: string; annotations: ToolAnnotations; required?: readonly string[]; optional?: readonly string[]; run: unknown }) => ({
  summary: spec.summary,
  annotations: spec.annotations,
  required: spec.required ?? [],
  optional: spec.optional ?? [],
  run: spec.run as ActionSpec["run"],
})) as ActionFactory<Fields>;

export interface ActionToolInfo {
  /** The action names, in the order the description lists them. */
  names: string[];
  specs: Record<string, ActionSpec>;
  /** The exact input: a discriminated union on `action`. */
  actionSchema: z.ZodType;
}

interface ActionToolConfig {
  name: string;
  title: string;
  group: ToolGroup;
  /** What the tool is for, when to use it. The list of actions is appended. */
  description: string;
  fields: Fields;
  actions: Record<string, ActionSpec>;
}

/**
 * A tool with an `action`. `actions` receives `act`, which declares one
 * action: its summary, annotations, the fields it requires and accepts, and
 * what it runs.
 */
export function actionTool<F extends Fields>(config: {
  name: string;
  title: string;
  group: ToolGroup;
  description: string;
  fields: F;
  actions: (act: ActionFactory<F>) => Record<string, ActionSpec>;
}): ToolDefinition {
  return buildActionTool({ ...config, actions: config.actions(declare as unknown as ActionFactory<F>) });
}

const isDestructive = (a: ActionSpec) => a.annotations.destructiveHint;

function combine(specs: ActionSpec[]): ToolAnnotations {
  return {
    readOnlyHint: specs.every((s) => s.annotations.readOnlyHint),
    destructiveHint: specs.some((s) => s.annotations.destructiveHint),
    idempotentHint: specs.every((s) => s.annotations.idempotentHint),
    openWorldHint: specs.some((s) => s.annotations.openWorldHint),
  };
}

const list = (names: string[]) => names.map((n) => `\`${n}\``).join(", ");

function buildActionTool(config: ActionToolConfig): ToolDefinition {
  const names = Object.keys(config.actions);
  if (names.length < 2) throw new Error(`${config.name}: an action tool needs at least two actions`);
  const specs = config.actions;

  for (const [action, spec] of Object.entries(specs)) {
    for (const f of [...spec.required, ...spec.optional]) {
      if (!(f in config.fields)) throw new Error(`${config.name}.${action}: unknown field ${f}`);
    }
    if (isDestructive(spec) && !spec.required.includes("confirm")) throw new Error(`${config.name}.${action}: a destructive action must require confirm`);
  }

  // The exact input: one object per action.
  const variants = names.map((action) => {
    const spec = specs[action]!;
    const shape: Record<string, z.ZodType> = { action: z.literal(action) };
    for (const f of spec.required) shape[f] = config.fields[f]!;
    for (const f of spec.optional) shape[f] = config.fields[f]!.optional();
    return z.object(shape);
  });
  const actionSchema = z.discriminatedUnion("action", variants as unknown as [z.ZodObject, ...z.ZodObject[]]);

  // What clients see: one flat object.
  const flat: Record<string, z.ZodType> = {
    action: z.enum(names as [string, ...string[]]).describe("What to do. See the list of actions in the tool description."),
  };
  for (const [field, schema] of Object.entries(config.fields)) {
    const requiredBy = names.filter((a) => specs[a]!.required.includes(field));
    const optionalFor = names.filter((a) => specs[a]!.optional.includes(field));
    if (!requiredBy.length && !optionalFor.length) continue;
    const required = requiredBy.length === names.length ? "Required for every action." : requiredBy.length ? `Required for ${list(requiredBy)}.` : "";
    const usage = [required, optionalFor.length ? `Optional for ${list(optionalFor)}.` : ""]
      .filter(Boolean)
      .join(" ");
    flat[field] = schema.optional().describe(`${schema.description ?? ""} ${usage}`.trim());
  }

  const lines = names.map((a) => {
    const spec = specs[a]!;
    return `- \`${a}\`: ${spec.summary}${isDestructive(spec) ? " Needs `confirm: true`." : ""}`;
  });
  const description = `${config.description}\n\nActions:\n${lines.join("\n")}`;

  const run = async (client: Wuapi, args: Record<string, unknown>): Promise<ToolResult> => {
    const action = String(args.action);
    const spec = specs[action];
    if (!spec) throw new ToolInputError(`Unknown action \`${action}\`. Use one of ${list(names)}.`);
    if (spec.required.includes("confirm") && args.confirm !== true) {
      throw new ToolInputError(`Action \`${action}\` needs \`confirm: true\`. Only set it after the user asked for this or agreed to it.`);
    }
    const missing = spec.required.filter((f) => f !== "confirm" && args[f] === undefined);
    if (missing.length) throw new ToolInputError(`Action \`${action}\` needs ${list(missing)}.`);
    const parsed = actionSchema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.length ? `\`${i.path.join(".")}\`: ` : ""}${i.message}`).join("; ");
      throw new ToolInputError(`Action \`${action}\`: ${issues}`);
    }
    return spec.run(client, parsed.data as Record<string, unknown>);
  };

  const def: ToolDefinition = {
    name: config.name,
    title: config.title,
    group: config.group,
    description,
    inputSchema: z.object(flat),
    annotations: combine(names.map((a) => specs[a]!)),
    run: run as ToolDefinition["run"],
    actions: { names, specs, actionSchema },
  };

  // Read-only servers keep the reading actions of a mixed tool.
  const reads = names.filter((a) => specs[a]!.annotations.readOnlyHint);
  if (reads.length > 0 && reads.length < names.length) {
    const readSpecs = Object.fromEntries(reads.map((a) => [a, specs[a]!]));
    def.readOnlyVariant =
      reads.length === 1 ? singleActionTool(config, reads[0]!, readSpecs[reads[0]!]!) : buildActionTool({ ...config, actions: readSpecs });
  }
  return def;
}

/** A read-only variant with one action left: still takes `action`, so calls look the same in both modes. */
function singleActionTool(config: ActionToolConfig, action: string, spec: ActionSpec): ToolDefinition {
  const shape: Record<string, z.ZodType> = { action: z.literal(action).describe(`Always \`${action}\` in read-only mode.`) };
  for (const f of spec.required) shape[f] = config.fields[f]!;
  for (const f of spec.optional) shape[f] = config.fields[f]!.optional();
  const inputSchema = z.object(shape);
  return {
    name: config.name,
    title: config.title,
    group: config.group,
    description: `${config.description}\n\nActions (read-only mode):\n- \`${action}\`: ${spec.summary}`,
    inputSchema,
    annotations: spec.annotations,
    run: ((client: Wuapi, args: Record<string, unknown>) => spec.run(client, args)) as ToolDefinition["run"],
    actions: { names: [action], specs: { [action]: spec }, actionSchema: inputSchema },
  };
}
