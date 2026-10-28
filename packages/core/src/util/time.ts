import type { Iso } from '../domain/types.ts';

export function nowIso(): Iso {
  return new Date().toISOString();
}

export function isoDay(d: Date | Iso = new Date()): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: Iso, days: number): Iso {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function daysBetween(a: Iso, b: Iso): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

export interface Period {
  start: Iso;
  end: Iso;
}

/** The window a given cadence looks back over, ending now. */
export function periodFor(cadence: string, end: Iso = nowIso()): Period {
  const days = cadence === 'daily' ? 1 : cadence === 'weekly' ? 7 : cadence === 'monthly' ? 30 : cadence === 'quarterly' ? 90 : 7;
  return { start: addDays(end, -days), end };
}

/** "3 days ago" style label, for freshness displays. */
export function relativeLabel(iso: Iso | null, now: Iso = nowIso()): string {
  if (!iso) return 'never';
  const mins = Math.round((new Date(now).getTime() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}
