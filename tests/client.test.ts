import { describe, it, expect, vi } from "vitest";
import { callOperation, __test, type LearnWorldsConfig } from "../src/client.js";
import type { Operation } from "../src/openapi.js";

function makeOp(partial: Partial<Operation> = {}): Operation {
  return {
    operationId: "test",
    method: "get",
    path: "/v2/courses/{id}",
    tags: [],
    parameters: [],
    requestBodyRequired: false,
    ...partial,
  } as Operation;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const baseCfg: LearnWorldsConfig = {
  baseUrl: "https://school.learnworlds.com/admin/api",
  apiToken: "tok",
  clientId: "cid",
  maxRetries: 2,
  timeoutMs: 1000,
};

describe("callOperation", () => {
  it("templates path params and injects auth headers", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://school.learnworlds.com/admin/api/v2/courses/abc");
      const headers = init!.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok");
      expect(headers["Lw-Client"]).toBe("cid");
      return jsonResponse({ ok: true });
    });
    const op = makeOp({ parameters: [{ name: "id", in: "path", required: true }] });
    const res = await callOperation({ ...baseCfg, fetchImpl: fetchImpl as typeof fetch }, op, { id: "abc" });
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("serializes scalar and exploded-array query params", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calledUrl = String(url);
      return jsonResponse({});
    });
    const op = makeOp({
      path: "/v2/users",
      parameters: [
        { name: "page", in: "query", required: false },
        { name: "tags", in: "query", required: false, explode: true },
      ],
    });
    await callOperation({ ...baseCfg, fetchImpl: fetchImpl as typeof fetch }, op, {
      page: 2,
      tags: ["a", "b"],
    });
    expect(calledUrl).toContain("page=2");
    expect(calledUrl).toContain("tags=a");
    expect(calledUrl).toContain("tags=b");
  });

  it("retries on 429 then succeeds, honoring Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "rate" }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    const op = makeOp({ path: "/v2/courses", parameters: [] });
    const res = await callOperation({ ...baseCfg, fetchImpl: fetchImpl as typeof fetch }, op, {});
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and returns the last error response", async () => {
    // Each call yields a fresh Response (real fetch never reuses one).
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    const op = makeOp({ path: "/v2/courses", parameters: [] });
    const res = await callOperation(
      { ...baseCfg, maxRetries: 1, fetchImpl: fetchImpl as typeof fetch },
      op,
      {},
    );
    expect(res.status).toBe(500);
    expect(res.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial attempt + 1 retry
  });

  it("serializes a JSON body for write operations", async () => {
    let sentBody = "";
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sentBody = String(init!.body);
      return jsonResponse({}, 201);
    });
    const op = makeOp({
      method: "post",
      path: "/v2/users",
      parameters: [],
      requestBodySchema: { type: "object" },
      requestBodyRequired: true,
      requestBodyContentType: "application/json",
    });
    await callOperation({ ...baseCfg, fetchImpl: fetchImpl as typeof fetch }, op, {
      body: { email: "x@y.z" },
    });
    expect(JSON.parse(sentBody)).toEqual({ email: "x@y.z" });
  });

  it("aborts and reports a timeout for a hung request", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const op = makeOp({ path: "/v2/courses", parameters: [] });
    await expect(
      callOperation({ ...baseCfg, maxRetries: 0, timeoutMs: 20, fetchImpl: fetchImpl as typeof fetch }, op, {}),
    ).rejects.toThrow(/timed out/);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds into milliseconds", () => {
    expect(__test.parseRetryAfter("2")).toBe(2000);
  });

  it("returns undefined for missing or unparseable values", () => {
    expect(__test.parseRetryAfter(null)).toBeUndefined();
    expect(__test.parseRetryAfter("not-a-date")).toBeUndefined();
  });
});
