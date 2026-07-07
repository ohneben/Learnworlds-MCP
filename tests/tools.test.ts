import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOpenApi } from "../src/openapi.js";
import { operationsToTools } from "../src/tools.js";

const specPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "spec",
  "learnworlds-openapi.yaml",
);

const { operations } = loadOpenApi(specPath);
const tools = operationsToTools(operations);

const countByMethod = (method: string) => operations.filter((o) => o.method === method).length;

describe("operationsToTools", () => {
  it("produces exactly one tool per operation", () => {
    expect(tools.length).toBe(operations.length);
  });

  it("gives every tool a unique, MCP-legal name", () => {
    const names = new Set<string>();
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
    }
  });

  it("categorizes tools by HTTP method (GET → read, DELETE → destructive)", () => {
    const read = tools.filter((t) => t.annotations.readOnlyHint).length;
    const destructive = tools.filter((t) => t.annotations.destructiveHint).length;
    const write = tools.length - read - destructive;

    expect(read).toBe(countByMethod("get"));
    expect(destructive).toBe(countByMethod("delete"));
    expect(write).toBe(countByMethod("post") + countByMethod("put") + countByMethod("patch"));
    expect(read + write + destructive).toBe(94);
  });

  it("prefixes every description with a 🟢 / 🟡 / 🔴 safety banner", () => {
    for (const t of tools) {
      expect(t.description).toMatch(/^(🟢 READ-ONLY|🟡 WRITE|🔴 DESTRUCTIVE)/);
    }
  });

  it("keeps read/delete annotations mutually exclusive and correct", () => {
    for (const t of tools) {
      if (t.operation.method === "get") {
        expect(t.annotations.readOnlyHint).toBe(true);
        expect(t.annotations.destructiveHint).toBe(false);
      }
      if (t.operation.method === "delete") {
        expect(t.annotations.destructiveHint).toBe(true);
        expect(t.annotations.readOnlyHint).toBe(false);
      }
    }
  });

  it("builds a closed object input schema for every tool", () => {
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });
});
