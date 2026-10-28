/**
 * The sync runner.
 *
 * Owns everything that must happen the same way for every connector:
 * decrypting the credential, applying the privacy preferences, writing source
 * records idempotently, handing candidates to the discovery engine, attaching
 * activity and metrics to the right project, and recording a SyncRun that
 * reports what actually happened — including what it skipped and why.
 *
 * A run is idempotent. Running it twice over unchanged data writes nothing the
 * second time, and the stats say so (`sourcesWritten: 0`), which is what makes
 * the freshness display on the integrations page meaningful.
 */

import type {
  ConnectedAccount, ConnectorKey, Id, SyncRun, SyncStats, BrainConfiguration,
} from '../domain/types.ts';
import type { Store } from '../db/repositories.ts';
import { emptyStats } from '../db/repositories.ts';
import { DiscoveryEngine } from '../engines/discovery.ts';
import { KnowledgeEngine } from '../engines/knowledge.ts';
import type { ConnectorAdapter, ConnectorContext, FetchResult } from './types.ts';
import { GitHubConnector } from './github.ts';
import { LocalDirectoryConnector } from './local-directory.ts';
import { claudeCodeConnector, codexConnector, type InterpretedAgentEvent } from './agent-events.ts';
import { decryptSecret } from '../security/secrets.ts';
import { contentHash } from '../util/id.ts';
import { nowIso } from '../util/time.ts';
import { CONNECTORS } from './registry.ts';

export const ADAPTERS: Partial<Record<ConnectorKey, ConnectorAdapter>> = {
  github: new GitHubConnector(),
  'local-directory': new LocalDirectoryConnector(),
  'claude-code': claudeCodeConnector,
  codex: codexConnector,
};

export function adapterFor(key: ConnectorKey): ConnectorAdapter | null {
  return ADAPTERS[key] ?? null;
}

export interface SyncOptions {
  trigger: SyncRun['trigger'];
  /** Decrypts the stored credential. Absent means run without credentials. */
  appSecret?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  maxItems?: number;
  /** Overrides the workspace's automation level for this run. */
  automationLevel?: BrainConfiguration['automationLevel'];
}

export interface SyncOutcome {
  run: SyncRun;
  stats: SyncStats;
  warnings: string[];
  /** Projects that need the user to confirm them. */
  queuedForReview: Array<{ id: Id; name: string; score: number; reason: string }>;
  hasMore: boolean;
}

export class SyncRunner {
  private readonly store: Store;
  private readonly discovery: DiscoveryEngine;
  private readonly knowledge: KnowledgeEngine;

  constructor(store: Store) {
    this.store = store;
    this.discovery = new DiscoveryEngine(store);
    this.knowledge = new KnowledgeEngine(store);
  }

  async run(workspaceId: Id, accountId: Id, opts: SyncOptions): Promise<SyncOutcome> {
    const account = this.store.accounts.byId(workspaceId, accountId);
    if (!account) throw new Error('connected account not found in this workspace');
    if (account.status === 'revoked') throw new Error('this connection has been revoked; reconnect it before syncing');

    const adapter = adapterFor(account.connector);
    if (!adapter) throw new Error(`no adapter is implemented for "${account.connector}"`);

    const config = this.store.brainConfig.current(workspaceId);
    const run = this.store.syncRuns.start({
      workspaceId,
      connectedAccountId: account.id,
      connector: account.connector,
      trigger: opts.trigger,
      cursorBefore: account.cursor,
    });

    const stats = emptyStats();
    const warnings: string[] = [];
    const queuedForReview: SyncOutcome['queuedForReview'] = [];

    try {
      const ctx = this.contextFor(account, config, opts);
      const result = await adapter.fetch(ctx);
      warnings.push(...result.warnings);
      stats.skippedByPrivacy += result.skippedByPrivacy;
      stats.rateLimitWaits += result.rateLimitWaits;
      stats.retries += result.retries;

      const applied = this.apply(workspaceId, account, result, {
        automationLevel: opts.automationLevel ?? config?.automationLevel ?? 'review',
        allowFileContentImport: config?.privacy.allowFileContentImport ?? true,
        excludedCategories: config?.privacy.excludedCategories ?? [],
      });
      Object.assign(stats, mergeStats(stats, applied.stats));
      queuedForReview.push(...applied.queuedForReview);

      // Retention: drop stored payloads older than the configured window but
      // keep the provenance stub, so claims stay attributable.
      const retentionDays = config?.privacy.sourceRetentionDays ?? 0;
      if (retentionDays > 0) {
        const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
        const pruned = this.store.sources.pruneRetained(workspaceId, cutoff);
        if (pruned > 0) warnings.push(`${pruned} source payload(s) older than ${retentionDays} days were cleared by your retention setting.`);
      }

      const status: SyncRun['status'] = warnings.length > 0 ? 'partial' : 'success';
      this.store.syncRuns.finish(run.id, { status, stats, cursorAfter: result.cursor ?? account.cursor });
      this.store.accounts.update(workspaceId, account.id, {
        lastSyncAt: nowIso(),
        cursor: result.cursor ?? account.cursor,
        status: 'active',
        lastError: warnings.length > 0 ? warnings[0]! : null,
      });
      this.store.audit.log({
        workspaceId, actorUserId: null, action: 'connector.sync',
        subject: `connected_account:${account.id}`,
        detail: { connector: account.connector, status, stats: { ...stats } },
      });

      return {
        run: { ...run, status, stats, cursorAfter: result.cursor ?? account.cursor },
        stats, warnings, queuedForReview, hasMore: result.hasMore,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.syncRuns.finish(run.id, { status: 'failed', stats, error: message });
      this.store.accounts.update(workspaceId, account.id, { status: 'error', lastError: message });
      this.store.audit.log({
        workspaceId, actorUserId: null, action: 'connector.sync.failed',
        subject: `connected_account:${account.id}`, detail: { connector: account.connector, error: message },
      });
      throw err;
    }
  }

  /**
   * Writes one fetch result.
   *
   * Runs inside a single transaction so a crash mid-apply cannot leave a
   * project without its source record or an activity row pointing at nothing.
   */
  apply(
    workspaceId: Id,
    account: ConnectedAccount,
    result: FetchResult,
    opts: { automationLevel: BrainConfiguration['automationLevel']; allowFileContentImport: boolean; excludedCategories: string[] },
  ): { stats: SyncStats; queuedForReview: SyncOutcome['queuedForReview'] } {
    const stats = emptyStats();
    const queuedForReview: SyncOutcome['queuedForReview'] = [];

    return this.store.transaction(() => {
      // 1. Source records first: everything else refers to them.
      const sourceIdByExternalId = new Map<string, Id>();
      for (const s of result.sources) {
        stats.sourcesSeen++;
        const { record, created, changed } = this.store.sources.upsert({
          workspaceId,
          connectedAccountId: account.id,
          connector: account.connector,
          kind: s.kind,
          externalId: s.externalId,
          locator: s.locator,
          url: s.url,
          payload: s.payload,
          payloadHash: contentHash(JSON.stringify(sortedKeys(s.payload))),
          observedAt: s.observedAt,
        });
        sourceIdByExternalId.set(s.externalId, record.id);
        if (created || changed) stats.sourcesWritten++;
      }

      // 2. Candidates through the discovery engine.
      const projectIdBySourceKey = new Map<string, Id>();
      for (const candidate of result.candidates) {
        const sourceId = sourceIdByExternalId.get(candidate.externalId) ?? null;
        const outcome = this.discovery.ingest(
          workspaceId,
          { ...candidate, sourceId },
          { automationLevel: opts.automationLevel },
        );
        if (outcome.project) {
          projectIdBySourceKey.set(`${candidate.connector}:${candidate.externalId}`, outcome.project.id);
        }
        switch (outcome.outcome) {
          case 'created': stats.projectsCreated++; break;
          case 'updated': stats.projectsUpdated++; break;
          case 'queued-for-review':
            stats.projectsQueuedForReview++;
            if (outcome.project) {
              queuedForReview.push({
                id: outcome.project.id, name: outcome.project.name,
                score: outcome.score, reason: outcome.reason,
              });
            }
            break;
          default: break;
        }
      }

      // 3. Activity, attached to a project where one resolved.
      for (const a of result.activity) {
        const projectId = a.projectSourceKey ? projectIdBySourceKey.get(a.projectSourceKey) ?? null : null;
        const sourceId = a.sourceExternalId ? sourceIdByExternalId.get(a.sourceExternalId) ?? null : null;
        const written = this.store.activity.addOnce({
          workspaceId, projectId, connector: account.connector, kind: a.kind,
          summary: a.summary, url: a.url, sourceId, actor: a.actor, occurredAt: a.occurredAt,
        });
        if (written) {
          stats.activityWritten++;
          if (projectId) this.store.projects.touchActivity(workspaceId, projectId, a.occurredAt);
        }
      }

      // 4. Metrics. Only recorded when the value actually moved, so a weekly
      //    sync does not produce a flat line of identical rows.
      for (const m of result.metrics) {
        const projectId = m.projectSourceKey ? projectIdBySourceKey.get(m.projectSourceKey) ?? null : null;
        const previous = this.store.metrics.history(workspaceId, m.key, projectId, 1)[0];
        if (previous && previous.value === m.value) continue;
        this.store.metrics.record({
          workspaceId, projectId, key: m.key, label: m.label, value: m.value,
          unit: m.unit, origin: 'connector', sourceId: null,
          target: m.target ?? null, observedAt: m.observedAt,
        });
        stats.metricsWritten++;
      }

      // 5. Documents into the knowledge base, redacted on the way in.
      if (result.documents.length > 0) {
        if (!opts.allowFileContentImport) {
          stats.skippedByPrivacy += result.documents.length;
        } else {
          for (const doc of result.documents) {
            const projectId = doc.projectId ?? null;
            const outcome = this.knowledge.ingest(
              workspaceId,
              { ...doc, projectId, sourceId: null },
              { allowFileContentImport: true, excludedCategories: opts.excludedCategories },
            );
            if (outcome.status === 'created') stats.sourcesWritten++;
          }
        }
      }

      return { stats, queuedForReview };
    });
  }

  /** Applies one pushed agent event. Same path as a poll, smaller payload. */
  applyAgentEvent(
    workspaceId: Id,
    account: ConnectedAccount,
    event: InterpretedAgentEvent,
    automationLevel: BrainConfiguration['automationLevel'],
  ): { projectId: Id | null; queuedForReview: boolean; projectName: string | null } {
    return this.store.transaction(() => {
      const { record } = this.store.sources.upsert({
        workspaceId,
        connectedAccountId: account.id,
        connector: event.connector,
        kind: 'agent-session',
        externalId: event.externalId,
        locator: event.locator,
        url: null,
        payload: event.payload,
        payloadHash: contentHash(JSON.stringify(sortedKeys(event.payload)), event.occurredAt),
        observedAt: event.occurredAt,
      });

      let projectId: Id | null = null;
      let queuedForReview = false;
      let projectName: string | null = null;

      if (event.candidate) {
        const outcome = this.discovery.ingest(
          workspaceId,
          { ...event.candidate, sourceId: record.id },
          { automationLevel },
        );
        projectId = outcome.project?.id ?? null;
        projectName = outcome.project?.name ?? null;
        queuedForReview = outcome.outcome === 'queued-for-review';
      }

      this.store.activity.addOnce({
        workspaceId, projectId, connector: event.connector, kind: event.kind,
        summary: event.summary, url: null, sourceId: record.id, actor: null,
        occurredAt: event.occurredAt,
      });
      if (projectId) this.store.projects.touchActivity(workspaceId, projectId, event.occurredAt);

      return { projectId, queuedForReview, projectName };
    });
  }

  private contextFor(
    account: ConnectedAccount,
    config: BrainConfiguration | null,
    opts: SyncOptions,
  ): ConnectorContext {
    let credential: string | null = null;
    if (account.credentialCipher) {
      if (!opts.appSecret) throw new Error('APP_SECRET is required to decrypt this connection’s credential');
      try {
        credential = decryptSecret(account.credentialCipher, opts.appSecret);
      } catch {
        throw new Error('stored credential could not be decrypted; APP_SECRET may have changed since it was saved');
      }
    }
    const ctx: ConnectorContext = {
      connector: account.connector,
      accountLabel: account.accountLabel,
      credential,
      allowlist: account.allowlist,
      cursor: account.cursor,
      privacy: {
        excludedPaths: config?.privacy.excludedPaths ?? [],
        excludedCategories: config?.privacy.excludedCategories ?? [],
        allowFileContentImport: config?.privacy.allowFileContentImport ?? true,
      },
    };
    if (opts.signal) ctx.signal = opts.signal;
    if (opts.fetchImpl) ctx.fetchImpl = opts.fetchImpl;
    if (opts.maxItems !== undefined) ctx.maxItems = opts.maxItems;
    return ctx;
  }
}

/** Per-connector health, as shown on the integrations page. */
export interface ConnectionHealth {
  account: ConnectedAccount;
  label: string;
  mode: string;
  limitations: string;
  connectorStatus: string;
  lastRun: SyncRun | null;
  freshnessSeconds: number | null;
  /** Honest completeness statement rather than a progress bar. */
  completeness: string;
}

export function connectionHealth(store: Store, workspaceId: Id): ConnectionHealth[] {
  return store.accounts.list(workspaceId).map((account) => {
    const def = CONNECTORS[account.connector];
    const lastRun = store.syncRuns.latestFor(workspaceId, account.id);
    const sources = store.sources.list(workspaceId, { connector: account.connector, limit: 1 });
    const total = store.db.one<{ c: number }>(
      'SELECT COUNT(*) AS c FROM source_records WHERE workspace_id = ? AND connector = ?',
      [workspaceId, account.connector],
    );
    const freshnessSeconds = account.lastSyncAt
      ? Math.round((Date.now() - new Date(account.lastSyncAt).getTime()) / 1000)
      : null;

    let completeness: string;
    if (!account.lastSyncAt) {
      completeness = 'Never synced. Nothing from this source has been imported.';
    } else if (def?.mode === 'manual-export') {
      completeness = `${Number(total?.c ?? 0)} record(s) from the files you imported. This source does not update on its own.`;
    } else if (lastRun?.status === 'partial') {
      completeness = `${Number(total?.c ?? 0)} record(s). The last run finished partially: ${lastRun.error ?? 'see warnings'}.`;
    } else if (account.allowlist.length === 0) {
      completeness = `${Number(total?.c ?? 0)} record(s), covering everything this credential can see (no allowlist set).`;
    } else {
      completeness = `${Number(total?.c ?? 0)} record(s), covering the ${account.allowlist.length} item(s) you allowlisted.`;
    }

    return {
      account,
      label: def?.label ?? account.connector,
      mode: def?.mode ?? 'unknown',
      limitations: def?.limitations ?? '',
      connectorStatus: def?.status ?? 'unknown',
      lastRun,
      freshnessSeconds,
      completeness,
      ...(sources.length === 0 ? {} : {}),
    };
  });
}

function mergeStats(a: SyncStats, b: SyncStats): SyncStats {
  return {
    sourcesSeen: a.sourcesSeen + b.sourcesSeen,
    sourcesWritten: a.sourcesWritten + b.sourcesWritten,
    projectsCreated: a.projectsCreated + b.projectsCreated,
    projectsUpdated: a.projectsUpdated + b.projectsUpdated,
    projectsQueuedForReview: a.projectsQueuedForReview + b.projectsQueuedForReview,
    activityWritten: a.activityWritten + b.activityWritten,
    metricsWritten: a.metricsWritten + b.metricsWritten,
    skippedByPrivacy: a.skippedByPrivacy + b.skippedByPrivacy,
    rateLimitWaits: a.rateLimitWaits + b.rateLimitWaits,
    retries: a.retries + b.retries,
  };
}

/** Key-sorted clone, so a payload hash does not depend on property order. */
function sortedKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}
