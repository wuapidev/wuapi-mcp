import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOT_EXPOSED, OPERATION_TOOLS } from "../src/operations.js";
import { TOOLS } from "../src/tools.js";

// Every operation of the public REST API is reachable through a tool, or is
// listed in NOT_EXPOSED with its reason. The spec lives in the monorepo
// (apps/wuapi/public/openapi.json); the public mirror of this package does not
// have it, so there the spec half is skipped and the table is still checked
// against the tools.

const SPEC = new URL("../../../apps/wuapi/public/openapi.json", import.meta.url);
const METHODS = ["get", "post", "put", "patch", "delete"];

function operationIds(): string[] {
  const spec = JSON.parse(readFileSync(SPEC, "utf8")) as { paths: Record<string, Record<string, { operationId?: string }>> };
  return Object.values(spec.paths).flatMap((ops) => METHODS.flatMap((m) => (ops[m]?.operationId ? [ops[m]!.operationId!] : [])));
}

describe("API coverage", () => {
  it("maps every operation to a tool or action that exists", () => {
    const tools = new Map(TOOLS.map((t) => [t.name, t]));
    for (const [op, targets] of Object.entries(OPERATION_TOOLS)) {
      expect(targets.length, op).toBeGreaterThan(0);
      for (const target of targets) {
        const [name, action] = target.split(".");
        const t = tools.get(name!);
        expect(t, `${op} -> ${target}`).toBeDefined();
        if (action) expect(t!.actions?.names, `${op} -> ${target}`).toContain(action);
        else expect(t!.actions, `${op} -> ${target}: name the action`).toBeUndefined();
      }
    }
  });

  it("reaches every action and every tool from some operation", () => {
    const targets = new Set(Object.values(OPERATION_TOOLS).flat());
    const toolNames = new Set([...targets].map((t) => t.split(".")[0]));
    for (const t of TOOLS) {
      expect(toolNames.has(t.name), t.name).toBe(true);
      for (const a of t.actions?.names ?? []) expect(targets.has(`${t.name}.${a}`), `${t.name}.${a}`).toBe(true);
    }
  });

  it("gives a reason for every operation left out", () => {
    for (const [op, reason] of Object.entries(NOT_EXPOSED)) {
      expect(OPERATION_TOOLS[op], op).toBeUndefined();
      expect(reason.length, op).toBeGreaterThan(20);
    }
  });

  it.skipIf(!existsSync(SPEC))("covers exactly the operations of openapi.json", () => {
    const ops = operationIds();
    expect(ops.length).toBeGreaterThan(100);
    const known = new Set([...Object.keys(OPERATION_TOOLS), ...Object.keys(NOT_EXPOSED)]);
    expect(ops.filter((op) => !known.has(op)), "operations with no tool").toEqual([]);
    expect([...known].filter((op) => !ops.includes(op)), "table entries not in the spec").toEqual([]);
  });
});
