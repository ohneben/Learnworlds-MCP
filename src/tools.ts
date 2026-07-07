import type { JsonSchema, Operation, ParameterSpec } from "./openapi.js";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  operation: Operation;
}

const MCP_TOOL_NAME_MAX = 64;

// Filler words to strip when deriving names from human summaries.
const FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "all",
  "of",
  "for",
  "by",
  "to",
  "from",
  "in",
  "on",
  "with",
  "and",
  "or",
]);

function snakeCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function nameFromSummary(summary: string): string {
  const words = summary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !FILLER_WORDS.has(w));
  return words.join("_");
}

function fallbackNameFromOperationId(operationId: string): string {
  // Normalise existing hyphenated id to snake_case so it matches the new style.
  return snakeCase(operationId);
}

function paramToSchema(p: ParameterSpec): JsonSchema {
  const base: Record<string, unknown> = { ...(p.schema ?? { type: "string" }) };
  if (p.description && !base.description) base.description = p.description;
  return base;
}

function buildInputSchema(op: Operation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of op.parameters) {
    properties[p.name] = paramToSchema(p);
    if (p.required) required.push(p.name);
  }

  if (op.requestBodySchema) {
    properties.body = {
      description: "Request body (application/json).",
      ...op.requestBodySchema,
    };
    if (op.requestBodyRequired) required.push("body");
  }

  const schema: Record<string, unknown> = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = required;
  return schema;
}

function categoryFor(op: Operation): "read" | "write" | "delete" {
  if (op.method === "delete") return "delete";
  if (op.method === "get") return "read";
  return "write";
}

/**
 * The safety banner prefixed to every tool description, using the shared
 * 🟢 / 🟡 / 🔴 convention. POST is flagged as "creates data" (not idempotent —
 * may duplicate) and PUT/PATCH as "updates data" so the model knows the risk.
 */
function safetyBanner(op: Operation, category: "read" | "write" | "delete"): string {
  if (category === "read") return "🟢 READ-ONLY";
  if (category === "delete") return "🔴 DESTRUCTIVE · deletes";
  return op.method === "post" ? "🟡 WRITE · creates data" : "🟡 WRITE · updates data";
}

function buildDescription(op: Operation, category: "read" | "write" | "delete"): string {
  const lines: string[] = [];
  const tag = op.tags[0] ?? "General";
  lines.push(`${safetyBanner(op, category)} · ${tag} · ${op.method.toUpperCase()} ${op.path}`);
  if (op.summary) lines.push(op.summary);
  if (op.description) {
    const desc = op.description.trim();
    lines.push(desc.length > 600 ? desc.slice(0, 600) + "…" : desc);
  }
  return lines.join("\n\n");
}

function buildAnnotations(op: Operation, title: string): ToolAnnotations {
  const isRead = op.method === "get";
  const isIdempotent = op.method === "get" || op.method === "put" || op.method === "delete";
  const isDestructive = op.method === "delete";
  return {
    title,
    readOnlyHint: isRead,
    destructiveHint: isDestructive,
    idempotentHint: isIdempotent,
    openWorldHint: true,
  };
}

export function operationsToTools(operations: Operation[]): ToolDefinition[] {
  const used = new Set<string>();
  const tools: ToolDefinition[] = [];

  for (const op of operations) {
    let baseName = op.summary ? nameFromSummary(op.summary) : "";
    if (!baseName) baseName = fallbackNameFromOperationId(op.operationId);
    if (baseName.length === 0) baseName = "tool";
    if (baseName.length > MCP_TOOL_NAME_MAX) baseName = baseName.slice(0, MCP_TOOL_NAME_MAX);

    // Resolve collisions by trying tag prefix, then numeric suffix.
    let name = baseName;
    if (used.has(name) && op.tags[0]) {
      const tagSlug = snakeCase(op.tags[0]);
      const candidate = `${tagSlug}_${baseName}`.slice(0, MCP_TOOL_NAME_MAX);
      if (!used.has(candidate)) name = candidate;
    }
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${baseName}_${i}`.slice(0, MCP_TOOL_NAME_MAX))) i++;
      name = `${baseName}_${i}`.slice(0, MCP_TOOL_NAME_MAX);
    }
    used.add(name);

    const category = categoryFor(op);
    const title = op.summary?.trim() || op.operationId;

    tools.push({
      name,
      description: buildDescription(op, category),
      inputSchema: buildInputSchema(op),
      annotations: buildAnnotations(op, title),
      operation: op,
    });
  }

  return tools;
}
