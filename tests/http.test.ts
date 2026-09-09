import { describe, expect, it } from "vitest";
import {
  bearerFrom,
  hostAllowlist,
  isLoopbackHost,
  loadHttpConfig,
  MIN_TOKEN_LENGTH,
  parseByteSize,
  positiveNumber,
  startupRefusal,
  tokenMatches,
  hostAllowed,
  weakTokenWarning,
} from "../src/http.js";

const base = (over: NodeJS.ProcessEnv = {}) =>
  loadHttpConfig({ ...over } as NodeJS.ProcessEnv);

describe("isLoopbackHost", () => {
  it("recognises the loopback spellings", () => {
    for (const h of ["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });
  it("treats a wildcard or routable bind as non-loopback", () => {
    for (const h of ["0.0.0.0", "::", "192.168.0.10"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("startupRefusal", () => {
  it("refuses a non-loopback bind without a token", () => {
    const msg = startupRefusal(base({ HOST: "0.0.0.0" }));
    expect(msg).toBeDefined();
    expect(msg).toContain("MCP_AUTH_TOKEN");
  });

  it("defaults to 0.0.0.0, so a bare `http` start with no token refuses", () => {
    expect(startupRefusal(base())).toBeDefined();
  });

  it("allows a non-loopback bind once a token is set", () => {
    expect(
      startupRefusal(base({ HOST: "0.0.0.0", MCP_AUTH_TOKEN: "s3cret" }))
    ).toBeUndefined();
  });

  it("allows a loopback bind without a token", () => {
    expect(startupRefusal(base({ HOST: "127.0.0.1" }))).toBeUndefined();
  });

  it("honours the explicit MCP_ALLOW_INSECURE override", () => {
    expect(
      startupRefusal(base({ HOST: "0.0.0.0", MCP_ALLOW_INSECURE: "1" }))
    ).toBeUndefined();
  });
});

describe("hostAllowlist", () => {
  it("uses MCP_ALLOWED_HOSTS verbatim when set", () => {
    expect(
      hostAllowlist(
        base({ MCP_ALLOWED_HOSTS: "mcp.example.com, localhost", MCP_AUTH_TOKEN: "t" })
      )
    ).toEqual(["mcp.example.com", "localhost"]);
  });

  it("skips the check when a token is set (the token defeats rebinding)", () => {
    expect(
      hostAllowlist(base({ HOST: "0.0.0.0", MCP_AUTH_TOKEN: "t" }))
    ).toBeUndefined();
  });

  it("restricts a token-less loopback server to localhost names", () => {
    expect(hostAllowlist(base({ HOST: "127.0.0.1" }))).toEqual([
      "localhost",
      "127.0.0.1",
      "[::1]",
    ]);
  });
});

describe("tokenMatches", () => {
  it("accepts the exact token", () => {
    expect(tokenMatches("abc123", "abc123")).toBe(true);
  });
  it("rejects a wrong token", () => {
    expect(tokenMatches("abc124", "abc123")).toBe(false);
  });
  it("rejects a differing length without throwing", () => {
    expect(tokenMatches("", "abc123")).toBe(false);
    expect(tokenMatches("abc123456789", "abc123")).toBe(false);
  });
});

describe("bearerFrom", () => {
  it("strips the scheme case-insensitively", () => {
    expect(bearerFrom("Bearer tok")).toBe("tok");
    expect(bearerFrom("bearer tok")).toBe("tok");
    expect(bearerFrom(undefined)).toBe("");
  });
});

describe("loadHttpConfig", () => {
  it("keeps the documented defaults", () => {
    const cfg = base();
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(8765);
    expect(cfg.path).toBe("/mcp");
    expect(cfg.sessionTtlMs).toBe(1_800_000);
    expect(cfg.maxSessions).toBe(256);
    expect(cfg.bodyLimitBytes).toBe(25 * 1024 * 1024);
  });
});

describe("positiveNumber", () => {
  it("falls back rather than silently disabling a limit", () => {
    // Number("abc") is NaN and Number("") is 0 — both would turn the idle
    // sweep or the session cap into a no-op.
    expect(positiveNumber("abc", 256)).toBe(256);
    expect(positiveNumber("", 256)).toBe(256);
    expect(positiveNumber("0", 256)).toBe(256);
    expect(positiveNumber("-5", 256)).toBe(256);
    expect(positiveNumber(undefined, 256)).toBe(256);
  });
  it("takes a valid positive value", () => {
    expect(positiveNumber("10", 256)).toBe(10);
  });
});

describe("loadHttpConfig hardening against bad numbers", () => {
  it("keeps the safety limits when the env vars are garbage", () => {
    const cfg = loadHttpConfig({
      MCP_SESSION_TTL: "abc",
      MCP_MAX_SESSIONS: "0",
      PORT: "",
    } as NodeJS.ProcessEnv);
    expect(cfg.sessionTtlMs).toBe(1_800_000);
    expect(cfg.maxSessions).toBe(256);
    expect(cfg.port).toBe(8765);
  });
});

describe("weakTokenWarning", () => {
  it("stays quiet when no token is set (startupRefusal owns that case)", () => {
    expect(weakTokenWarning(base({ HOST: "127.0.0.1" }))).toBeUndefined();
  });

  it("warns about a token that is trivially guessable", () => {
    const msg = weakTokenWarning(base({ MCP_AUTH_TOKEN: "a" }));
    expect(msg).toBeDefined();
    expect(msg).toContain("openssl rand -hex 32");
  });

  it("stays quiet at the minimum length and above", () => {
    const ok = "x".repeat(MIN_TOKEN_LENGTH);
    expect(weakTokenWarning(base({ MCP_AUTH_TOKEN: ok }))).toBeUndefined();
    expect(weakTokenWarning(base({ MCP_AUTH_TOKEN: ok + "x" }))).toBeUndefined();
  });

  it("warns one character below the minimum", () => {
    const short = "x".repeat(MIN_TOKEN_LENGTH - 1);
    expect(weakTokenWarning(base({ MCP_AUTH_TOKEN: short }))).toBeDefined();
  });
});

describe("parseByteSize", () => {
  it("understands the units used in the docs", () => {
    expect(parseByteSize("25mb", 1)).toBe(25 * 1024 * 1024);
    expect(parseByteSize("512kb", 1)).toBe(512 * 1024);
    expect(parseByteSize("1gb", 1)).toBe(1024 ** 3);
    expect(parseByteSize("2048", 1)).toBe(2048);
  });
  it("falls back rather than removing the limit", () => {
    // A typo must not turn the cap into "unlimited", which is what this
    // server did before: a 150 MB body drove RSS from 91 MB to 851 MB.
    for (const bad of ["abc", "", "0", "-5mb", undefined]) {
      expect(parseByteSize(bad as string | undefined, 4242)).toBe(4242);
    }
  });
});

describe("hostAllowed", () => {
  const list = ["localhost", "127.0.0.1", "[::1]"];
  it("accepts an allowed host with or without a port", () => {
    expect(hostAllowed("localhost:8765", list)).toBe(true);
    expect(hostAllowed("127.0.0.1", list)).toBe(true);
  });
  it("rejects a forged host, a missing header and garbage", () => {
    expect(hostAllowed("evil.attacker.example", list)).toBe(false);
    expect(hostAllowed(undefined, list)).toBe(false);
    expect(hostAllowed("http://nope", list)).toBe(false);
  });
});
