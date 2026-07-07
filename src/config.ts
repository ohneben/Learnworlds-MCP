import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LearnWorldsConfig } from "./client.js";
import { RateLimiter } from "./rateLimiter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerConfig extends LearnWorldsConfig {
  specPath: string;
}

// LearnWorlds enforces 30 requests / 10 s on the public API. We default a little
// under that so bursts of tool calls stay clear of the server-side 429.
const DEFAULT_MAX_REQUESTS = 25;
const DEFAULT_RATE_WINDOW_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `See README.md for setup. Required: LEARNWORLDS_API_TOKEN, LEARNWORLDS_CLIENT_ID, LEARNWORLDS_BASE_URL.`,
    );
  }
  return v.trim();
}

/** Read a non-negative integer env var, falling back to `fallback` when unset/invalid. */
function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function resolveSpecPath(): string {
  const explicit = process.env.LEARNWORLDS_OPENAPI_PATH;
  if (explicit) {
    const abs = resolve(explicit);
    if (!existsSync(abs)) throw new Error(`LEARNWORLDS_OPENAPI_PATH not found: ${abs}`);
    return abs;
  }
  // Bundled spec: dist/ is sibling of spec/ at the package root.
  const bundled = resolve(__dirname, "..", "spec", "learnworlds-openapi.yaml");
  if (existsSync(bundled)) return bundled;
  throw new Error(
    `Could not locate the LearnWorlds OpenAPI spec. Set LEARNWORLDS_OPENAPI_PATH to the YAML file.`,
  );
}

export function loadConfig(): ServerConfig {
  const maxRequests = intEnv("LEARNWORLDS_MAX_REQUESTS", DEFAULT_MAX_REQUESTS);
  const windowMs = intEnv("LEARNWORLDS_RATE_WINDOW_MS", DEFAULT_RATE_WINDOW_MS);

  return {
    baseUrl: requireEnv("LEARNWORLDS_BASE_URL"),
    apiToken: requireEnv("LEARNWORLDS_API_TOKEN"),
    clientId: requireEnv("LEARNWORLDS_CLIENT_ID"),
    specPath: resolveSpecPath(),
    maxRetries: intEnv("LEARNWORLDS_MAX_RETRIES", DEFAULT_MAX_RETRIES),
    timeoutMs: intEnv("LEARNWORLDS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    // A value of 0 disables client-side throttling (retries still cover 429s).
    rateLimiter: maxRequests > 0 ? new RateLimiter(maxRequests, windowMs) : undefined,
  };
}
