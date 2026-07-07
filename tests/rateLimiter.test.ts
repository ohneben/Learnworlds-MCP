import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/rateLimiter.js";

describe("RateLimiter", () => {
  it("admits a burst up to maxRequests instantly, then throttles", async () => {
    const rl = new RateLimiter(3, 100);
    const start = Date.now();

    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(Date.now() - start).toBeLessThan(50); // three slots are free right away

    await rl.acquire(); // fourth must wait for the oldest to leave the 100ms window
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  it("clamps a non-positive maxRequests to at least one (never deadlocks)", async () => {
    const rl = new RateLimiter(0, 50);
    await rl.acquire();
    expect(true).toBe(true);
  });
});
