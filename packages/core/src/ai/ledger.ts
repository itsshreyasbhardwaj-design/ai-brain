/**
 * Database-backed AI spend ledger.
 *
 * Every paid call writes a metric row, so AI cost is visible in the same place
 * as every other resource number and survives a restart. The budget check in
 * provider.ts reads from here, which means the cap holds across processes
 * rather than per request handler.
 */

import type { Id } from '../domain/types.ts';
import type { Store } from '../db/repositories.ts';
import type { ProviderKind, UsageLedger } from './provider.ts';
import { nowIso } from '../util/time.ts';

export const AI_SPEND_METRIC = 'ai_spend_minor';

export class DbLedger implements UsageLedger {
  private readonly store: Store;
  private readonly workspaceId: Id;

  constructor(store: Store, workspaceId: Id) {
    this.store = store;
    this.workspaceId = workspaceId;
  }

  spentThisMonthMinor(): number {
    const start = monthStartIso();
    const row = this.store.db.one<{ total: number | null }>(
      `SELECT SUM(value) AS total FROM metrics
       WHERE workspace_id = ? AND key = ? AND observed_at >= ?`,
      [this.workspaceId, AI_SPEND_METRIC, start],
    );
    return Math.round(Number(row?.total ?? 0));
  }

  record(costMinor: number, provider: ProviderKind, model: string): void {
    if (costMinor <= 0) return;
    this.store.metrics.record({
      workspaceId: this.workspaceId,
      projectId: null,
      key: AI_SPEND_METRIC,
      label: `AI spend (${provider}${model ? `/${model}` : ''})`,
      value: costMinor,
      unit: 'minor',
      origin: 'derived',
      sourceId: null,
      target: null,
      observedAt: nowIso(),
    });
  }

  /** Call-by-call history for the AI usage panel. */
  history(limit = 50): Array<{ at: string; costMinor: number; label: string }> {
    return this.store.db
      .query<{ observed_at: string; value: number; label: string }>(
        `SELECT observed_at, value, label FROM metrics
         WHERE workspace_id = ? AND key = ? ORDER BY observed_at DESC LIMIT ?`,
        [this.workspaceId, AI_SPEND_METRIC, limit],
      )
      .map((r) => ({ at: String(r.observed_at), costMinor: Number(r.value), label: String(r.label) }));
  }

  callsThisMonth(): number {
    const row = this.store.db.one<{ c: number }>(
      'SELECT COUNT(*) AS c FROM metrics WHERE workspace_id = ? AND key = ? AND observed_at >= ?',
      [this.workspaceId, AI_SPEND_METRIC, monthStartIso()],
    );
    return Number(row?.c ?? 0);
  }
}

function monthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
