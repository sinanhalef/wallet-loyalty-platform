// Excerpt from the private production repository, included for illustration.
// It is not runnable on its own: imports refer to modules that are not published here.

/**
 * A small fixed-window rate limiter for public endpoints.
 *
 * Enrollment is unauthenticated by necessity — a customer at the counter has no
 * account — so it is the one route anyone on the internet can drive. Each call
 * writes two Firestore documents, which makes it worth a cheap brake.
 *
 * Deliberately in-memory, and therefore per-instance: Cloud Run may run several
 * containers, so the effective limit is this number times the instance count.
 * It stops a script hammering one URL, not a distributed effort. If enrollment
 * abuse ever becomes real, this moves to Firestore or Cloud Armor — but paying
 * a read-write per request to guard against a problem nobody has yet would be
 * the wrong trade.
 */
import type { FastifyRequest } from 'fastify';

/**
 * The address Google's front end saw, which a client cannot choose.
 *
 * Every limiter here keys on `req.ip`, and with `trustProxy: true` that is the
 * *leftmost* `X-Forwarded-For` entry. Through bubizden.co that is right:
 * Hosting discards whatever the client sent and writes the real address
 * (tested on production twice, HANDOFF §25 and 20 Sep 2026). But the raw
 * `*.run.app` URL is also public — Hosting rewrites need ingress `all` — and
 * there the client's own header survives on the left, so rotating it bought a
 * fresh bucket per request: unlimited shops from `/signup`, unlimited
 * customers in a live café from `/enroll`.
 *
 * Cloud Run always *appends* the peer it accepted the connection from, so the
 * rightmost entry is the one thing in that header nobody downstream typed.
 * It cannot replace `req.ip` — through Hosting it is Hosting's proxy, shared
 * by every customer, and `trustProxy: 1` would put a whole café in one bucket
 * on launch day. So it is a second, much looser limit beside the first:
 * invisible to real traffic through either door, and a ceiling on anyone
 * rotating headers at the side one.
 */
export function edgeKey(req: FastifyRequest): string {
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[header.length - 1] : header;
  const last = raw?.split(',').pop()?.trim();
  return last || req.socket?.remoteAddress || req.ip || 'unknown';
}

export interface RateLimiterOptions {
  /** Requests allowed per window, per key. */
  max: number;
  windowMs: number;
  now?: () => number;
}

export class RateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(options: RateLimiterOptions) {
    this.#max = options.max;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Returns false when the caller has exhausted its window. */
  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.#now();
    const entry = this.#hits.get(key);

    if (!entry || now >= entry.resetAt) {
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      this.#sweep(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    entry.count += 1;
    if (entry.count > this.#max) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Whether the caller has used up its window, without counting this call.
   *
   * For the pattern where the thing being limited is *failures*, not
   * requests: the caller asks this before doing the work, records a failure
   * with `check` after, and a key that has failed `max` times in the window
   * is refused before it costs anything. Successful requests never touch the
   * counter, so a busy legitimate client is never throttled.
   */
  exhausted(key: string): { blocked: boolean; retryAfterSeconds: number } {
    const now = this.#now();
    const entry = this.#hits.get(key);
    if (!entry || now >= entry.resetAt || entry.count < this.#max) {
      return { blocked: false, retryAfterSeconds: 0 };
    }
    return { blocked: true, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }

  /**
   * Drops expired entries so a long-lived instance does not accumulate one map
   * entry per IP that ever visited. Amortised over calls rather than on a
   * timer, which would hold the event loop open.
   */
  #sweep(now: number): void {
    if (this.#hits.size < 1000) return;
    for (const [key, entry] of this.#hits) {
      if (now >= entry.resetAt) this.#hits.delete(key);
    }
  }
}
