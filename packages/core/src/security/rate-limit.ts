/**
 * Fixed-window rate limiter held in process memory.
 *
 * Adequate for the single-process self-hosted deployment this release
 * targets. A Redis-backed limiter is on the roadmap for multi-instance
 * deployments and is noted as such in the docs rather than implied here.
 */
interface Bucket { count: number; resetAt: number }

const buckets = new Map<string, Bucket>();

export interface LimitResult { allowed: boolean; remaining: number; retryAfterSeconds: number }

export function rateLimit(key: string, limit: number, windowSeconds: number, now = Date.now()): LimitResult {
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }
  b.count++;
  if (b.count > limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: limit - b.count, retryAfterSeconds: 0 };
}

export function resetRateLimits(): void {
  buckets.clear();
}
