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
  // A renamed (sanitized) parameter still reaches LearnWorlds under its raw name.
  if (p.argName && p.argName !== p.name) {
    base.description = [base.description, `Sent to LearnWorlds as "${p.name}".`]
      .filter(Boolean)
      .join(" ");
  }
  return base;
}

function buildInputSchema(op: Operation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of op.parameters) {
    const key = p.argName ?? p.name;
    properties[key] = paramToSchema(p);
    if (p.required) required.push(key);
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

type Category = "read" | "write" | "delete";

function categoryFor(op: Operation): Category {
  if (op.method === "delete") return "delete";
  if (op.method === "get") return "read";
  return "write";
}

/**
 * The safety banner prefixed to every tool description, using the shared
 * 🟢 / 🟡 / 🔴 convention. POST is flagged as "creates data" (not idempotent —
 * may duplicate) and PUT/PATCH as "updates data" so the model knows the risk.
 */
function safetyBanner(op: Operation, category: Category): string {
  if (category === "read") return "🟢 READ-ONLY";
  if (category === "delete") return "🔴 DESTRUCTIVE · deletes";
  return op.method === "post" ? "🟡 WRITE · creates data" : "🟡 WRITE · updates data";
}

/**
 * Auth, rate-limit and retry facts that hold for every tool. Stated once per
 * description because an agent cannot see the transport layer that provides
 * them, and "does this need credentials?" is otherwise a guess.
 */
const RESILIENCE_NOTE =
  "Auth (admin API token + Lw-Client id) is injected server-side, never by the model; " +
  "calls are throttled to stay under LearnWorlds' 30-per-10s cap and retried on 429/5xx.";

const normalizeWords = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);

/**
 * Merge `summary` and `description` without repeating the same sentence twice.
 * Most LearnWorlds operations restate the summary as their first description
 * sentence ("Reset user progress" / "Resets the user's progress on …"), so the
 * summary is dropped whenever the longer description already carries it.
 */
function purposeText(op: Operation): string {
  const summary = (op.summary ?? "").trim().replace(/[.\s]+$/, "");
  const description = (op.description ?? "").trim();
  if (!description) return summary;
  if (!summary) return description;

  const descWords = normalizeWords(description);
  const summaryWords = normalizeWords(summary).filter((w) => w.length > 2 && !FILLER_WORDS.has(w));
  if (summaryWords.length > 0 && description.length >= summary.length) {
    const stem = (w: string) => w.slice(0, Math.max(4, w.length - 2));
    // Every meaningful word already appears downstream → the summary is redundant.
    if (summaryWords.every((w) => descWords.some((d) => d.startsWith(stem(w))))) return description;
  }
  return `${summary}. ${description}`;
}

/** What calling this tool does to the school, plus the auth/rate-limit facts. */
function behaviorLine(op: Operation, category: Category): string {
  const effect =
    category === "read"
      ? "read-only lookup against the live school; creates, changes and deletes nothing."
      : category === "delete"
        ? "permanently removes the addressed record from the live school — no undo from this server."
        : op.method === "post"
          ? "creates a record or triggers an action in the live school. Not idempotent: a repeated call can duplicate the effect."
          : "replaces the fields you send on an existing record in the live school. Idempotent: repeating it leaves the same state.";
  return `Behavior: ${effect} ${RESILIENCE_NOTE}`;
}

/** Only the parameter facts the input schema cannot express on its own. */
function parametersLine(op: Operation): string | undefined {
  const notes: string[] = [];

  if (op.requestBodySchema) {
    notes.push(
      "the whole JSON payload goes in the single `body` argument, forwarded verbatim" +
        (op.requestBodyRequired ? "" : " (the spec leaves `body` optional, but this endpoint expects one)"),
    );
  }

  const queryNames = new Set(op.parameters.filter((p) => p.in === "query").map((p) => p.name));
  if (queryNames.has("page")) {
    notes.push(
      queryNames.has("items_per_page")
        ? "results are paged — walk them with `page` and size each page with `items_per_page`"
        : "results are paged — walk them with `page`",
    );
  }

  const renamed = op.parameters.filter((p) => p.argName && p.argName !== p.name);
  if (renamed.length > 0) {
    notes.push(
      `${renamed.map((p) => `\`${p.argName}\``).join(", ")} ${renamed.length === 1 ? "reaches" : "reach"} LearnWorlds under the original spec name`,
    );
  }

  if (notes.length === 0) return undefined;
  return `Parameters: ${notes.join("; ")}.`;
}

/** Result shape and failure modes — the server returns text, not a typed schema. */
function returnsLine(category: Category): string {
  const success =
    category === "delete"
      ? "`HTTP 200`/`204`, with a body that is usually empty on success."
      : "`HTTP <status>` followed by the LearnWorlds JSON response body.";
  return (
    `Returns: ${success} A non-2xx reply surfaces as a tool error with that status and the API error ` +
    "payload — 401 bad/expired token, 403 not permitted, 404 no such record, 422 rejected input."
  );
}

/** When to reach for this tool, when not to, and what sits next to it. */
function usageLine(op: Operation, category: Category, tag: string, siblings: string[]): string {
  const guidance =
    category === "read"
      ? "safe to call speculatively for lookups and reporting. Not for changing anything — use the matching 🟡 write tool."
      : category === "delete"
        ? "only after the user confirms the removal. To merely revoke access or deactivate, use the matching 🟡 update or unenroll tool instead."
        : op.method === "post"
          ? "only when the user asked to create this. Check with a 🟢 read tool that the target exists and the record is not already there."
          : "only when the user asked to change an existing record. Read it first so you overwrite just the fields you mean to; use the create tool if it does not exist yet.";
  const related = siblings.length > 0 ? ` Related ${tag} tools: ${siblings.join(", ")}.` : "";
  return `Use when: ${guidance}${related}`;
}

/** Up to five same-tag tools, nearest endpoint path first, as alternatives. */
function siblingNames(op: Operation, name: string, sameTag: Array<{ name: string; op: Operation }>): string[] {
  const segments = (path: string) => path.split("/").filter(Boolean);
  const mine = segments(op.path);
  const sharedPrefix = (other: Operation) => {
    const theirs = segments(other.path);
    let i = 0;
    while (i < mine.length && i < theirs.length && mine[i] === theirs[i]) i++;
    return i;
  };
  return sameTag
    .filter((t) => t.name !== name)
    .sort((a, b) => sharedPrefix(b.op) - sharedPrefix(a.op) || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((t) => t.name);
}

function buildDescription(
  op: Operation,
  category: Category,
  name: string,
  sameTag: Array<{ name: string; op: Operation }>,
): string {
  const tag = op.tags[0] ?? "General";
  const purpose = purposeText(op);
  const trimmedPurpose = purpose.length > 600 ? `${purpose.slice(0, 600)}…` : purpose;

  const body = [
    behaviorLine(op, category),
    parametersLine(op),
    returnsLine(category),
    usageLine(op, category, tag, siblingNames(op, name, sameTag)),
  ].filter((line): line is string => Boolean(line));

  return [
    `${safetyBanner(op, category)} · ${op.method.toUpperCase()} ${op.path}`,
    trimmedPurpose,
    body.join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
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
  const named: Array<{ name: string; op: Operation }> = [];

  // Pass 1 — assign every tool its final name, so pass 2 can cross-reference
  // siblings by name inside the descriptions.
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
    named.push({ name, op });
  }

  const byTag = new Map<string, Array<{ name: string; op: Operation }>>();
  for (const entry of named) {
    const tag = entry.op.tags[0] ?? "General";
    const bucket = byTag.get(tag) ?? [];
    bucket.push(entry);
    byTag.set(tag, bucket);
  }

  // Pass 2 — build the schema, annotations and description for each tool.
  return named.map(({ name, op }) => {
    const category = categoryFor(op);
    const tag = op.tags[0] ?? "General";
    return {
      name,
      description: buildDescription(op, category, name, byTag.get(tag) ?? []),
      inputSchema: buildInputSchema(op),
      annotations: buildAnnotations(op, op.summary?.trim() || op.operationId),
      operation: op,
    };
  });
}
