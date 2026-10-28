/**
 * HTTP helper shared by API connectors.
 *
 * Handles the three things that make unattended syncing survive contact with a
 * real API: retry with exponential backoff and jitter on transient failures,
 * respect for rate-limit headers rather than hammering through them, and a
 * hard ceiling on total wait so a sync cannot hang forever.
 */

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Attempts per request, including the first. */
  maxAttempts?: number;
  /** Longest a single backoff may wait, in ms. */
  maxBackoffMs?: number;
  /** Longest the whole call may spend waiting on rate limits, in ms. */
  maxRateLimitWaitMs?: number;
  /** Injected for tests so they do not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface HttpResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  headers: Headers;
  error?: string;
  retries: number;
  rateLimitWaits: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly opts: Required<Omit<HttpOptions, 'fetchImpl' | 'signal' | 'headers' | 'sleepImpl'>>;
  private readonly baseHeaders: Record<string, string>;
  private readonly signal?: AbortSignal;

  retries = 0;
  rateLimitWaits = 0;

  constructor(options: HttpOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleepImpl ?? defaultSleep;
    this.baseHeaders = options.headers ?? {};
    if (options.signal) this.signal = options.signal;
    this.opts = {
      maxAttempts: options.maxAttempts ?? 4,
      maxBackoffMs: options.maxBackoffMs ?? 8_000,
      maxRateLimitWaitMs: options.maxRateLimitWaitMs ?? 60_000,
    };
  }

  async getJson<T>(url: string, extraHeaders: Record<string, string> = {}): Promise<HttpResult<T>> {
    let lastError = '';
    let rateLimitWaited = 0;

    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      if (this.signal?.aborted) {
        return { ok: false, status: 0, data: null, headers: new Headers(), error: 'aborted', retries: this.retries, rateLimitWaits: this.rateLimitWaits };
      }
      let res: Response;
      try {
        const init: RequestInit = { headers: { ...this.baseHeaders, ...extraHeaders } };
        if (this.signal) init.signal = this.signal;
        res = await this.fetchImpl(url, init);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === this.opts.maxAttempts) break;
        this.retries++;
        await this.sleep(this.backoff(attempt));
        continue;
      }

      // Rate limited. Prefer the server's own reset time over guessing.
      if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
        const waitMs = this.rateLimitWaitMs(res.headers);
        if (rateLimitWaited + waitMs > this.opts.maxRateLimitWaitMs) {
          return {
            ok: false, status: res.status, data: null, headers: res.headers,
            error: `rate limited; reset is further away than the ${Math.round(this.opts.maxRateLimitWaitMs / 1000)}s budget for this run`,
            retries: this.retries, rateLimitWaits: this.rateLimitWaits,
          };
        }
        this.rateLimitWaits++;
        rateLimitWaited += waitMs;
        await this.sleep(waitMs);
        continue;
      }

      if (res.status >= 500 && attempt < this.opts.maxAttempts) {
        this.retries++;
        await this.sleep(this.backoff(attempt));
        continue;
      }

      if (!res.ok) {
        let detail = '';
        try {
          const body = (await res.json()) as { message?: string };
          detail = body?.message ? `: ${body.message}` : '';
        } catch {
          /* non-JSON error body */
        }
        return {
          ok: false, status: res.status, data: null, headers: res.headers,
          error: `HTTP ${res.status}${detail}`, retries: this.retries, rateLimitWaits: this.rateLimitWaits,
        };
      }

      try {
        const data = (await res.json()) as T;
        return { ok: true, status: res.status, data, headers: res.headers, retries: this.retries, rateLimitWaits: this.rateLimitWaits };
      } catch (err) {
        return {
          ok: false, status: res.status, data: null, headers: res.headers,
          error: `invalid JSON response: ${err instanceof Error ? err.message : String(err)}`,
          retries: this.retries, rateLimitWaits: this.rateLimitWaits,
        };
      }
    }

    return {
      ok: false, status: 0, data: null, headers: new Headers(),
      error: lastError || 'request failed', retries: this.retries, rateLimitWaits: this.rateLimitWaits,
    };
  }

  private backoff(attempt: number): number {
    const base = Math.min(this.opts.maxBackoffMs, 400 * 2 ** (attempt - 1));
    return Math.round(base * (0.7 + Math.random() * 0.6)); // jitter
  }

  private rateLimitWaitMs(headers: Headers): number {
    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return Math.min(this.opts.maxRateLimitWaitMs, Math.max(1000, secs * 1000));
    }
    const reset = headers.get('x-ratelimit-reset');
    if (reset) {
      const resetMs = Number(reset) * 1000 - Date.now();
      if (Number.isFinite(resetMs) && resetMs > 0) return Math.min(this.opts.maxRateLimitWaitMs, resetMs + 1000);
    }
    return 5_000;
  }
}

/** Follows RFC 5988 `Link` headers, which is how GitHub paginates. */
export function nextPageUrl(headers: Headers): string | null {
  const link = headers.get('link');
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}
