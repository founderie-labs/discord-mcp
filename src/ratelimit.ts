// Per-route rate limiting from Discord's X-RateLimit-* headers. Calls on one route run
// in order; a global 429 pauses all routes.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Bucket {
  remaining: number;
  resetAt: number; // epoch ms
}

export class RateLimiter {
  private routeToBucket = new Map<string, string>();
  private buckets = new Map<string, Bucket>();
  private queues = new Map<string, Promise<unknown>>();
  private globalUntil = 0;

  /** Route key: method + path with only major IDs kept. */
  static route(method: string, path: string): string {
    const clean = path.split("?")[0];
    const generic = clean.replace(/\/(\d{5,25})/g, (m, id, offset, full) => {
      const before = full.slice(0, offset);
      return /\/(channels|guilds|webhooks)$/.test(before) ? m : "/:id";
    });
    // Message deletes have their own, separate limit in Discord.
    const del = method === "DELETE" && /\/messages\/:id$/.test(generic) ? ":delete" : "";
    return `${method} ${generic}${del}`;
  }

  /** Run fn when the route's bucket allows, one at a time per route. */
  schedule<T>(route: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(route) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      await this.waitFor(route);
      return fn();
    });
    this.queues.set(route, next);
    return next;
  }

  private async waitFor(route: string) {
    for (;;) {
      const now = Date.now();
      if (this.globalUntil > now) {
        await sleep(this.globalUntil - now);
        continue;
      }
      const hash = this.routeToBucket.get(route);
      const b = hash ? this.buckets.get(hash) : undefined;
      if (b && b.remaining <= 0 && b.resetAt > now) {
        await sleep(b.resetAt - now + 50);
        continue;
      }
      if (b && b.resetAt <= now) this.buckets.delete(hash!);
      return;
    }
  }

  /** Learn from a response's headers. */
  update(route: string, headers: Headers) {
    const hash = headers.get("x-ratelimit-bucket");
    const remaining = headers.get("x-ratelimit-remaining");
    const resetAfter = headers.get("x-ratelimit-reset-after");
    if (!hash || remaining === null || resetAfter === null) return;
    this.routeToBucket.set(route, hash);
    this.buckets.set(hash, {
      remaining: Number(remaining),
      resetAt: Date.now() + Number(resetAfter) * 1000,
    });
  }

  /** Record a 429. Returns how long to wait before retrying. */
  limited(route: string, headers: Headers, body: { retry_after?: number; global?: boolean }): number {
    const wait = Math.min(Math.max((body.retry_after ?? 1) * 1000, 100), 60_000);
    if (body.global || headers.get("x-ratelimit-global")) {
      this.globalUntil = Date.now() + wait;
    } else {
      const hash = headers.get("x-ratelimit-bucket") ?? this.routeToBucket.get(route) ?? route;
      this.routeToBucket.set(route, hash);
      this.buckets.set(hash, { remaining: 0, resetAt: Date.now() + wait });
    }
    return wait;
  }
}
