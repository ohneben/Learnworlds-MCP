import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOpenApi } from "../src/openapi.js";

const specPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "spec",
  "learnworlds-openapi.yaml",
);

const { operations } = loadOpenApi(specPath);

describe("loadOpenApi", () => {
  it("parses all 94 operations from the bundled spec", () => {
    expect(operations.length).toBe(94);
  });

  it("gives every operation a method, path and operationId", () => {
    for (const op of operations) {
      expect(op.method).toBeTruthy();
      expect(op.path.startsWith("/")).toBe(true);
      expect(op.operationId.length).toBeGreaterThan(0);
    }
  });

  it("strips the injected auth headers from tool parameters", () => {
    for (const op of operations) {
      const headers = op.parameters
        .filter((p) => p.in === "header")
        .map((p) => p.name.toLowerCase());
      expect(headers).not.toContain("authorization");
      expect(headers).not.toContain("lw-client");
    }
  });

  it("fully dereferences request-body schemas (no dangling $ref keys)", () => {
    const withBody = operations.filter((o) => o.requestBodySchema);
    expect(withBody.length).toBeGreaterThan(0);
    for (const op of withBody) {
      expect(JSON.stringify(op.requestBodySchema)).not.toContain('"$ref"');
    }
  });
});
