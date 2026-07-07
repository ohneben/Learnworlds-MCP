/**
 * A tiny sliding-window rate limiter.
 *
 * LearnWorlds enforces a public-API limit of 30 requests / 10 seconds and answers
 * with HTTP 429 once it is exceeded. This limiter self-throttles a little below that
 * ceiling so a burst of tool calls never trips the server-side limit in the first
 * place — retries on 429 (see client.ts) are only a backstop.
 *
 * The implementation keeps the timestamps of recent requests in a window and, once
 * the window is full, awaits until the oldest request ages out. JavaScript's single
 * thread makes the "check length, then record" step atomic (there is no `await`
 * between them), so concurrent callers can never over-fill the window.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly timestamps: number[] = [];

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = Math.max(1, Math.floor(maxRequests));
    this.windowMs = Math.max(1, Math.floor(windowMs));
  }

  /** Resolves as soon as a request slot is free, recording the request. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const windowStart = now - this.windowMs;

      // Drop every timestamp that has aged out of the current window.
      while (this.timestamps.length > 0 && this.timestamps[0] <= windowStart) {
        this.timestamps.shift();
      }

      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }

      // Window is full — wait until the oldest recorded request leaves it.
      const waitMs = this.timestamps[0] - windowStart;
      await sleep(Math.max(waitMs, 1));
    }
  }
}
