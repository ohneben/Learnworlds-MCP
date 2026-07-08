import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ParameterSpec {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema?: JsonSchema;
  explode?: boolean;
  /**
   * The key this parameter is exposed under in the tool's input schema.
   * Anthropic's API only accepts property keys matching `^[a-zA-Z0-9_.-]{1,64}$`,
   * but the LearnWorlds spec declares a query param `cf_$field_name` whose `$`
   * is illegal — one such key would make an MCP client reject the ENTIRE tool
   * list. Always set on loaded operations; equals `name` when already legal.
   */
  argName?: string;
}

export interface Operation {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: ParameterSpec[];
  requestBodySchema?: JsonSchema;
  requestBodyRequired: boolean;
  requestBodyContentType?: string;
}

export type JsonSchema = Record<string, unknown> | null | undefined;

interface OpenApiDoc {
  paths?: Record<string, PathItem>;
  components?: {
    parameters?: Record<string, ParameterSpec>;
    schemas?: Record<string, JsonSchema>;
    requestBodies?: Record<string, RequestBodyObject>;
    responses?: Record<string, unknown>;
  };
}

interface PathItem {
  parameters?: Array<ParameterSpec | RefObject>;
  [method: string]: unknown;
}

interface RefObject {
  $ref: string;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<ParameterSpec | RefObject>;
  requestBody?: RequestBodyObject | RefObject;
}

interface RequestBodyObject {
  required?: boolean;
  description?: string;
  content?: Record<string, { schema?: JsonSchema }>;
}

function isRef(value: unknown): value is RefObject {
  return typeof value === "object" && value !== null && "$ref" in value && typeof (value as RefObject).$ref === "string";
}

function resolveRef<T>(doc: OpenApiDoc, ref: string): T | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref.slice(2).split("/");
  let cursor: unknown = doc;
  for (const seg of segments) {
    if (cursor && typeof cursor === "object" && seg in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cursor as T;
}

function dereferenceSchema(doc: OpenApiDoc, schema: JsonSchema, seen: Set<string> = new Set()): JsonSchema {
  if (!schema || typeof schema !== "object") return schema;
  if (isRef(schema)) {
    const ref = (schema as unknown as RefObject).$ref;
    if (seen.has(ref)) {
      return { description: `Recursive reference to ${ref}` };
    }
    const resolved = resolveRef<JsonSchema>(doc, ref);
    if (!resolved) return { description: `Unresolved $ref: ${ref}` };
    return dereferenceSchema(doc, resolved, new Set([...seen, ref]));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === "object" ? dereferenceSchema(doc, item as JsonSchema, seen) : item,
      );
    } else if (v && typeof v === "object") {
      out[k] = dereferenceSchema(doc, v as JsonSchema, seen);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function resolveParameter(doc: OpenApiDoc, p: ParameterSpec | RefObject): ParameterSpec | undefined {
  if (isRef(p)) {
    const resolved = resolveRef<ParameterSpec>(doc, p.$ref);
    return resolved ? { ...resolved, required: resolved.required ?? false } : undefined;
  }
  return { ...p, required: p.required ?? p.in === "path" };
}

function resolveRequestBody(doc: OpenApiDoc, body: RequestBodyObject | RefObject): RequestBodyObject | undefined {
  if (isRef(body)) return resolveRef<RequestBodyObject>(doc, body.$ref);
  return body;
}

const HEADERS_TO_SKIP = new Set(["authorization", "lw-client", "content-type", "accept"]);

/** Anthropic's constraint on tool input-schema property keys. */
export const TOOL_ARG_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;

const sanitizeArgKey = (name: string): string =>
  name.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "").slice(0, 64) || "param";

/**
 * Give every parameter a schema-legal `argName`, unique within the operation.
 * Names already matching {@link TOOL_ARG_KEY} pass through unchanged; the rest
 * (e.g. `cf_$field_name`) are sanitized so a single illegal key can't make an
 * MCP client reject the whole tool list.
 */
export function assignArgNames(params: ParameterSpec[]): ParameterSpec[] {
  const used = new Set<string>();
  return params.map((p) => {
    const base = TOOL_ARG_KEY.test(p.name) ? p.name : sanitizeArgKey(p.name);
    let argName = base;
    let i = 2;
    while (used.has(argName)) argName = `${base.slice(0, 60)}_${i++}`;
    used.add(argName);
    return { ...p, argName };
  });
}

export function loadOpenApi(yamlPath: string): { operations: Operation[]; doc: OpenApiDoc } {
  const raw = readFileSync(yamlPath, "utf8");
  const doc = parseYaml(raw) as OpenApiDoc;
  const operations: Operation[] = [];
  if (!doc.paths) return { operations, doc };

  for (const [path, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem) continue;
    const pathLevelParams: ParameterSpec[] = (pathItem.parameters ?? [])
      .map((p) => resolveParameter(doc, p))
      .filter((p): p is ParameterSpec => Boolean(p));

    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as OperationObject | undefined;
      if (!op || typeof op !== "object") continue;

      const opParams: ParameterSpec[] = (op.parameters ?? [])
        .map((p) => resolveParameter(doc, p))
        .filter((p): p is ParameterSpec => Boolean(p));

      // Merge path-level params with operation-level params; operation-level overrides by (name + in).
      const merged = new Map<string, ParameterSpec>();
      for (const p of pathLevelParams) merged.set(`${p.in}:${p.name}`, p);
      for (const p of opParams) merged.set(`${p.in}:${p.name}`, p);

      const allParams = [...merged.values()].filter(
        (p) => !(p.in === "header" && HEADERS_TO_SKIP.has(p.name.toLowerCase())),
      );

      let requestBodySchema: JsonSchema | undefined;
      let requestBodyRequired = false;
      let requestBodyContentType: string | undefined;
      if (op.requestBody) {
        const rb = resolveRequestBody(doc, op.requestBody);
        if (rb?.content) {
          const jsonEntry = rb.content["application/json"] ?? Object.values(rb.content)[0];
          if (jsonEntry?.schema) {
            requestBodySchema = dereferenceSchema(doc, jsonEntry.schema);
            requestBodyContentType = "application/json" in rb.content ? "application/json" : Object.keys(rb.content)[0];
            requestBodyRequired = rb.required ?? false;
          }
        }
      }

      const operationId =
        op.operationId ?? `${method}-${path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

      operations.push({
        operationId,
        method,
        path,
        summary: op.summary,
        description: op.description,
        tags: op.tags ?? [],
        parameters: assignArgNames(
          allParams.map((p) => ({
            ...p,
            schema: p.schema ? dereferenceSchema(doc, p.schema) : undefined,
          })),
        ),
        requestBodySchema,
        requestBodyRequired,
        requestBodyContentType,
      });
    }
  }

  return { operations, doc };
}
