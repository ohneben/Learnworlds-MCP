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

  it("only exposes Anthropic-legal property keys and tool names — one bad key would break the whole client", () => {
    // Regression: the LearnWorlds spec declares a query param `cf_$field_name`,
    // whose `$` Claude's API rejects with
    // "Property keys should match pattern '^[a-zA-Z0-9_.-]{1,64}$'". A single
    // illegal key 400s the whole connect and kills all 94 tools.
    const LEGAL_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;
    const LEGAL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const t of tools) {
      expect(t.name, `illegal tool name ${JSON.stringify(t.name)}`).toMatch(LEGAL_NAME);
      for (const key of Object.keys((t.inputSchema.properties as Record<string, unknown>) ?? {})) {
        expect(key, `${t.name} exposes illegal property key ${JSON.stringify(key)}`).toMatch(LEGAL_KEY);
      }
      const required = (t.inputSchema.required as string[] | undefined) ?? [];
      for (const key of required) {
        expect(key, `${t.name} requires unknown key ${key}`).toMatch(LEGAL_KEY);
      }
    }
  });

  it("sanitizes the get_users cf_$field_name param to a legal key", () => {
    const users = tools.find((t) => t.name === "get_users");
    expect(users, "expected a get_users tool").toBeDefined();
    const keys = Object.keys(users!.inputSchema.properties as Record<string, unknown>);
    expect(keys.some((k) => k.includes("$"))).toBe(false);
  });
});
