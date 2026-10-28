/**
 * Minimal runtime validation.
 *
 * The brief suggests Zod; this is a ~90-line subset covering exactly the
 * shapes the API accepts, which keeps the core package at zero runtime
 * dependencies. The API layer uses it for every request body.
 */

export class ValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

type Src = Record<string, unknown>;

export function str(src: Src, field: string, opts: { max?: number; min?: number; optional?: boolean; default?: string } = {}): string {
  const raw = src[field];
  if (raw == null || raw === '') {
    if (opts.default !== undefined) return opts.default;
    if (opts.optional) return '';
    throw new ValidationError(field, 'is required');
  }
  if (typeof raw !== 'string') throw new ValidationError(field, 'must be a string');
  const v = raw.trim();
  if (opts.min && v.length < opts.min) throw new ValidationError(field, `must be at least ${opts.min} characters`);
  if (v.length > (opts.max ?? 10_000)) throw new ValidationError(field, `must be at most ${opts.max ?? 10_000} characters`);
  return v;
}

export function enumOf<T extends string>(src: Src, field: string, allowed: readonly T[], fallback?: T): T {
  const raw = src[field];
  if (raw == null || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(field, 'is required');
  }
  if (!allowed.includes(raw as T)) {
    throw new ValidationError(field, `must be one of: ${allowed.join(', ')}`);
  }
  return raw as T;
}

export function strArray<T extends string = string>(src: Src, field: string, allowed?: readonly T[]): T[] {
  const raw = src[field];
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ValidationError(field, 'must be an array');
  const out: T[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new ValidationError(field, 'must contain only strings');
    const v = item.trim();
    if (v === '') continue;
    if (allowed && !allowed.includes(v as T)) throw new ValidationError(field, `contains unsupported value: ${v}`);
    if (!out.includes(v as T)) out.push(v as T);
  }
  return out;
}

export function int(src: Src, field: string, opts: { min?: number; max?: number; default?: number; optional?: boolean } = {}): number {
  const raw = src[field];
  if (raw == null || raw === '') {
    if (opts.default !== undefined) return opts.default;
    if (opts.optional) return 0;
    throw new ValidationError(field, 'is required');
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) throw new ValidationError(field, 'must be a number');
  const i = Math.round(n);
  if (opts.min !== undefined && i < opts.min) throw new ValidationError(field, `must be >= ${opts.min}`);
  if (opts.max !== undefined && i > opts.max) throw new ValidationError(field, `must be <= ${opts.max}`);
  return i;
}

export function bool(src: Src, field: string, fallback = false): boolean {
  const raw = src[field];
  if (raw == null) return fallback;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1' || raw === 1) return true;
  if (raw === 'false' || raw === '0' || raw === 0) return false;
  return fallback;
}

export function isoDate(src: Src, field: string, optional = true): string | null {
  const raw = src[field];
  if (raw == null || raw === '') {
    if (optional) return null;
    throw new ValidationError(field, 'is required');
  }
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw new ValidationError(field, 'must be a valid date');
  return d.toISOString();
}

export function email(src: Src, field: string): string {
  const v = str(src, field, { max: 320 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new ValidationError(field, 'must be a valid email address');
  return v;
}

export function obj(src: Src, field: string): Record<string, unknown> {
  const raw = src[field];
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(field, 'must be an object');
  return raw as Record<string, unknown>;
}
