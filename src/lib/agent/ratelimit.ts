import { config } from "@/lib/config";

/**
 * In-process sliding-window rate limiter, keyed by client IP. Deliberately
 * dependency-free: on a single serverless instance this is enough to blunt abuse
 * of the public demo. For a multi-region production deployment you'd swap the
 * Map for Upstash Redis behind the same interface — the call site wouldn't
 * change. Stating that tradeoff is the point.
 */

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();

export interface RateResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

export function rateLimit(key: string, rpm = config.rateLimitRpm): RateResult {
  const now = Date.now();
  const windowMs = 60_000;
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: rpm - 1, resetInMs: windowMs };
  }

  if (existing.count >= rpm) {
    return { allowed: false, remaining: 0, resetInMs: existing.resetAt - now };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: rpm - existing.count,
    resetInMs: existing.resetAt - now,
  };
}

/** Best-effort client key from proxy headers (Vercel sets x-forwarded-for). */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "anonymous";
}

/** Periodically drop expired windows so the Map can't grow unbounded. */
export function sweepRateLimiter(): void {
  const now = Date.now();
  for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
}
