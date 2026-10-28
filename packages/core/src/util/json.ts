/** Tolerant JSON helpers: a corrupt column must not take down a page. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return raw as T;
  try {
    const v = JSON.parse(raw);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function boolInt(v: boolean): number {
  return v ? 1 : 0;
}

export function intBool(v: unknown): boolean {
  return Number(v) === 1;
}
