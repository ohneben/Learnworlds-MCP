#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callOperation } from "./client.js";
import { loadConfig } from "./config.js";
import { loadOpenApi } from "./openapi.js";
import { operationsToTools, type ToolDefinition } from "./tools.js";
import {
  bearerFrom,
  hostAllowed,
  hostAllowlist,
  loadHttpConfig,
  startupRefusal,
  tokenMatches,
  weakTokenWarning,
} from "./http.js";

const FALLBACK_VERSION = "unknown";

/**
 * The version reported over MCP. It comes from package.json, which CI stamps
 * from the release tag and writes back to main, so the number is never
 * maintained by hand and never drifts from what was actually published.
 */
function readPackageVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as {
      version?: string;
    };
    return pkg.version ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

function buildServer(tools: ToolDefinition[], config: ReturnType<typeof loadConfig>): Server {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const server = new Server(
    { name: "learnworlds-mcp", version: readPackageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }
    try {
      const result = await callOperation(config, tool.operation, args ?? {});
      const summary = `HTTP ${result.status} ${result.ok ? "OK" : "ERROR"}`;
      const formatted =
        typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2);
      return {
        isError: !result.ok,
        content: [{ type: "text", text: `${summary}\n${formatted}` }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Tool execution failed: ${message}` }],
      };
    }
  });

  return server;
}

/** Thrown by readBody when the request exceeds the configured limit. */
class BodyTooLarge extends Error {}

/**
 * Reads the request body, refusing anything over `limitBytes`. Without the
 * limit the whole request is buffered in memory: a single 150 MB request drove
 * RSS from 91 MB to 851 MB, and with no token set anyone could send it.
 */
async function readBody(
  req: IncomingMessage,
  limitBytes: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) {
      // Stop reading but leave the socket alive: the caller still has to write
      // the 413, and destroying here means the client only sees a dropped
      // connection instead of a usable error.
      req.pause();
      throw new BodyTooLarge(`Request body exceeds ${limitBytes} bytes`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function runStdio(tools: ToolDefinition[], config: ReturnType<typeof loadConfig>) {
  const server = buildServer(tools, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`learnworlds-mcp (stdio) ready: ${tools.length} tools registered.`);
}

async function runHttp(tools: ToolDefinition[], config: ReturnType<typeof loadConfig>) {
  const cfg = loadHttpConfig();

  const refusal = startupRefusal(cfg);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  const weak = weakTokenWarning(cfg);
  if (weak) console.error(`learnworlds-mcp: ${weak}`);
  if (!cfg.authToken && cfg.allowInsecure) {
    console.error(
      "learnworlds-mcp: WARNING - MCP_ALLOW_INSECURE is set and no " +
        "MCP_AUTH_TOKEN is configured. Anyone who can reach this port has " +
        "full access to the LearnWorlds school data.",
    );
  }

  const allowlist = hostAllowlist(cfg);

  type Session = {
    server: Server;
    transport: StreamableHTTPServerTransport;
    lastSeen: number;
    /** Open SSE streams; a session serving one is in use, however quiet. */
    streams: number;
  };
  const sessions = new Map<string, Session>();

  const drop = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void Promise.resolve(s.transport.close()).catch(() => {});
  };

  // Sessions were previously only removed on transport close. Worse, a POST
  // carrying an unknown session id built a full Server plus transport before
  // the 400 was returned, so a random UUID per request leaked ~86 KB with no
  // token and no initialize needed.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - cfg.sessionTtlMs;
    for (const [id, s] of sessions) {
      if (s.streams === 0 && s.lastSeen < cutoff) drop(id);
    }
  }, 60_000);
  sweep.unref();

  const evictOldest = () => {
    let victim: string | undefined;
    let oldest = Infinity;
    let victimStreaming = true;
    for (const [id, s] of sessions) {
      const streaming = s.streams > 0;
      if (victimStreaming && !streaming) {
        victim = id;
        oldest = s.lastSeen;
        victimStreaming = false;
        continue;
      }
      if (streaming === victimStreaming && s.lastSeen < oldest) {
        victim = id;
        oldest = s.lastSeen;
      }
    }
    if (victim) drop(victim);
  };

  const send = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const rpcError = (code: number, message: string) => ({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }

    // 1. DNS-rebinding protection, on every route: /health used to answer with
    //    any Host header and hand out the server name and tool count.
    if (allowlist && !hostAllowed(req.headers.host, allowlist)) {
      send(res, 403, rpcError(-32000, `Invalid Host: ${req.headers.host ?? "(missing)"}`));
      return;
    }

    // Liveness only. Behind the Host check, in front of the auth gate so a
    // platform health check needs no token.
    if (req.method === "GET" && req.url === "/health") {
      send(res, 200, { status: "ok", server: "learnworlds-mcp", tools: tools.length });
      return;
    }

    if (!req.url.startsWith(cfg.path)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Not found. MCP endpoint is ${cfg.path}`);
      return;
    }

    // 2. Shared secret, still before the body is read.
    if (cfg.authToken && !tokenMatches(bearerFrom(req.headers.authorization), cfg.authToken)) {
      send(res, 401, rpcError(-32001, "Unauthorized"));
      return;
    }

    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      // 3. Body first, so an initialize can be recognised without allocating.
      let body: unknown;
      if (req.method === "POST") {
        try {
          body = await readBody(req, cfg.bodyLimitBytes);
        } catch (err) {
          if (err instanceof BodyTooLarge) {
            send(res, 413, rpcError(-32600, `Request body exceeds the configured limit of ${cfg.bodyLimitBytes} bytes`));
            // Only now drop what is still in flight; the client has its answer.
            res.on("finish", () => req.destroy());
            return;
          }
          throw err;
        }
      }

      let session: Session | undefined;

      if (sessionId) {
        session = sessions.get(sessionId);
        if (!session) {
          // 404, not 400: clients only re-initialize on 404, and nothing is
          // allocated for a session id we do not know.
          send(res, 404, rpcError(-32001, "Session not found"));
          return;
        }
        session.lastSeen = Date.now();
      } else if (req.method === "POST" && isInitializeRequest(body)) {
        if (sessions.size >= cfg.maxSessions) evictOldest();
        const server = buildServer(tools, config);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId) => {
            sessions.set(newId, { server, transport, lastSeen: Date.now(), streams: 0 });
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };
        await server.connect(transport);
        session = { server, transport, lastSeen: Date.now(), streams: 0 };
      } else {
        send(res, 400, rpcError(-32000, "Bad Request: no valid session ID provided."));
        return;
      }

      // A GET is the SSE stream and stays open; count it so the idle sweep
      // leaves the session alone while it is genuinely in use.
      if (req.method === "GET" && sessionId) {
        const held = session;
        held.streams += 1;
        res.on("close", () => {
          held.streams = Math.max(0, held.streams - 1);
          held.lastSeen = Date.now();
        });
      }

      await session.transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("Request handling error:", err);
      if (!res.headersSent) {
        send(res, 500, rpcError(-32603, "Internal server error"));
      } else {
        res.end();
      }
    }
  });

  httpServer.listen(cfg.port, cfg.host, () => {
    console.error(
      `learnworlds-mcp (http) ready on http://${cfg.host}:${cfg.port}${cfg.path}  -  ${tools.length} tools registered.`,
    );
    if (allowlist) {
      console.error(`learnworlds-mcp: Host header restricted to ${allowlist.join(", ")}`);
    }
    if (cfg.authToken) console.error("Bearer auth: required (MCP_AUTH_TOKEN set).");
    else console.error("Bearer auth: DISABLED (MCP_AUTH_TOKEN not set).");
  });

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down...`);
    clearInterval(sweep);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main() {
  const config = loadConfig();
  const { operations } = loadOpenApi(config.specPath);
  const tools = operationsToTools(operations);

  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http" || transport === "streamable-http") {
    await runHttp(tools, config);
  } else if (transport === "stdio") {
    await runStdio(tools, config);
  } else {
    throw new Error(`Unknown MCP_TRANSPORT: ${transport}. Use "stdio" or "http".`);
  }
}

main().catch((err) => {
  console.error("Fatal error starting learnworlds-mcp:", err);
  process.exit(1);
});
