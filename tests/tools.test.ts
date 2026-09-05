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

  it("documents behavior, returns and usage in every description", () => {
    for (const t of tools) {
      expect(t.description, `${t.name} is missing a Behavior line`).toContain("\nBehavior: ");
      expect(t.description, `${t.name} is missing a Returns line`).toContain("\nReturns: ");
      expect(t.description, `${t.name} is missing a Use when line`).toContain("\nUse when: ");
      expect(t.description, `${t.name} is missing its endpoint`).toContain(
        `${t.operation.method.toUpperCase()} ${t.operation.path}`,
      );
    }
  });

  it("never repeats the summary when the description already states it", () => {
    const reset = tools.find((t) => t.name === "reset_user_progress");
    expect(reset, "expected a reset_user_progress tool").toBeDefined();
    const purpose = reset!.description.split("\n\n")[1];
    expect(purpose).toBe("Resets the user's progress on a course or learning activity level.");
  });

  it("points each tool at same-tag alternatives without listing itself", () => {
    for (const t of tools) {
      const related = t.description.match(/Related .+ tools: (.+)\.$/m)?.[1];
      if (!related) continue;
      const names = related.split(", ");
      expect(names.length).toBeLessThanOrEqual(5);
      expect(names, `${t.name} lists itself as an alternative`).not.toContain(t.name);
      for (const name of names) {
        expect(tools.some((o) => o.name === name), `unknown sibling ${name}`).toBe(true);
      }
    }
  });

  it("explains the `body` wrapper only for operations that take a request body", () => {
    for (const t of tools) {
      const mentionsBody = t.description.includes("single `body` argument");
      expect(mentionsBody, `${t.name} body hint mismatch`).toBe(Boolean(t.operation.requestBodySchema));
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
