import type { Operation } from "./openapi.js";
import type { RateLimiter } from "./rateLimiter.js";

export interface LearnWorldsConfig {
  baseUrl: string;
  apiToken: string;
  clientId: string;
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Max automatic retries on 429 / 5xx / network errors. Default 3. */
  maxRetries?: number;
  /** Per-attempt request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Optional client-side rate limiter shared across all calls. */
  rateLimiter?: RateLimiter;
}

export interface CallResult {
  status: number;
  ok: boolean;
  contentType: string | null;
  body: unknown;
  rawBody: string;
  /** Number of retries performed before this response was returned. */
  attempts: number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/** Exponential backoff with full jitter, capped, so retries don't thunder. */
function backoffDelay(attempt: number, base = 500, cap = 8000): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

function expandPath(path: string, args: Record<string, unknown>, pathParamNames: Set<string>): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    if (!(name in args)) {
      throw new Error(`Missing required path parameter "${name}".`);
    }
    pathParamNames.add(name);
    const v = args[name];
    if (v === null || v === undefined) {
      throw new Error(`Path parameter "${name}" cannot be null/undefined.`);
    }
    return encodeURIComponent(String(v));
  });
}

function buildQueryString(
  op: Operation,
  args: Record<string, unknown>,
  consumed: Set<string>,
): string {
  const usp = new URLSearchParams();
  for (const p of op.parameters) {
    if (p.in !== "query") continue;
    if (consumed.has(p.name)) continue;
    const value = args[p.name];
    if (value === undefined || value === null) continue;
    consumed.add(p.name);
    if (Array.isArray(value)) {
      const explode = p.explode !== false;
      if (explode) {
        for (const v of value) usp.append(p.name, String(v));
      } else {
        usp.append(p.name, value.map((v) => String(v)).join(","));
      }
    } else if (typeof value === "object") {
      usp.append(p.name, JSON.stringify(value));
    } else {
      usp.append(p.name, String(value));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

function collectExtraHeaders(
  op: Operation,
  args: Record<string, unknown>,
  consumed: Set<string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const p of op.parameters) {
    if (p.in !== "header") continue;
    if (consumed.has(p.name)) continue;
    const value = args[p.name];
    if (value === undefined || value === null) continue;
    consumed.add(p.name);
    headers[p.name] = String(value);
  }
  return headers;
}

/**
 * Perform a single HTTP request with a timeout, retrying on transient failures
 * (429 / 5xx / network errors) with jittered exponential backoff. Honors the
 * server's `Retry-After` header when present. Rate-limit slots are acquired per
 * attempt so retries also stay within the configured budget.
 */
async function fetchWithResilience(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  cfg: LearnWorldsConfig,
): Promise<{ response: Response; attempts: number }> {
  const maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (cfg.rateLimiter) await cfg.rateLimiter.acquire();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        const wait = parseRetryAfter(response.headers.get("retry-after")) ?? backoffDelay(attempt);
        // Drain the body so the underlying socket can be reused, then retry.
        await response.text().catch(() => undefined);
        await sleep(wait);
        continue;
      }

      return { response, attempts: attempt };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      lastError = isAbort ? new Error(`Request timed out after ${timeoutMs}ms.`) : err;
      if (attempt < maxRetries) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error("Request failed after exhausting retries.");
}

export async function callOperation(
  cfg: LearnWorldsConfig,
  op: Operation,
  rawArgs: unknown,
): Promise<CallResult> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const fetchImpl = cfg.fetchImpl ?? fetch;

  const consumed = new Set<string>();
  const pathParamNames = new Set<string>();

  const expandedPath = expandPath(op.path, args, pathParamNames);
  for (const name of pathParamNames) consumed.add(name);

  const query = buildQueryString(op, args, consumed);
  const extraOpHeaders = collectExtraHeaders(op, args, consumed);

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: cfg.apiToken.startsWith("Bearer ") ? cfg.apiToken : `Bearer ${cfg.apiToken}`,
    "Lw-Client": cfg.clientId,
    ...extraOpHeaders,
    ...(cfg.extraHeaders ?? {}),
  };

  let body: string | undefined;
  if (op.requestBodySchema && args.body !== undefined) {
    headers["Content-Type"] = op.requestBodyContentType ?? "application/json";
    body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }

  const url = `${cfg.baseUrl.replace(/\/+$/, "")}${expandedPath}${query}`;

  const { response, attempts } = await fetchWithResilience(
    fetchImpl,
    url,
    { method: op.method.toUpperCase(), headers, body },
    cfg,
  );

  const rawBody = await response.text();
  const contentType = response.headers.get("content-type");
  let parsedBody: unknown = rawBody;
  if (contentType && contentType.includes("application/json") && rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }

  return {
    status: response.status,
    ok: response.ok,
    contentType,
    body: parsedBody,
    rawBody,
    attempts,
  };
}

// Exposed for unit tests.
export const __test = { parseRetryAfter, backoffDelay, RETRYABLE_STATUS };
