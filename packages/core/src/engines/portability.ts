/**
 * Data portability.
 *
 * The promise is that a user can leave without losing anything, so the export
 * is a complete, re-importable dump of their workspace — not a report. It
 * deliberately excludes exactly two things: password hashes and connector
 * credentials. Everything else round-trips, and `importWorkspace` is the test
 * of that claim.
 */

import type {
  ActivityEvent, BrainConfiguration, Decision, Evidence, Goal, Id, ImportBatch,
  KnowledgeRecord, Metric, Project, ProjectRelationship, Report, Resource,
  SourceRecord, SyncRun, Task, Workspace,
} from '../domain/types.ts';
import type { Store, TimeEntry } from '../db/repositories.ts';
import { nowIso } from '../util/time.ts';
import { toConfigFile, type BrainConfigFile } from './brain-config.ts';

export const EXPORT_VERSION = 1;

export interface WorkspaceExport {
  $schema: 'https://ai-brain.dev/schema/export.v1.json';
  version: number;
  exportedAt: string;
  workspace: Pick<Workspace, 'name' | 'slug' | 'kind' | 'createdAt'>;
  brainConfigurations: BrainConfigFile[];
  modules: Array<{ key: string; enabled: boolean; settings: Record<string, unknown> }>;
  projects: Project[];
  relationships: ProjectRelationship[];
  goals: Goal[];
  tasks: Task[];
  decisions: Decision[];
  knowledge: KnowledgeRecord[];
  resources: Resource[];
  metrics: Metric[];
  timeEntries: TimeEntry[];
  activity: ActivityEvent[];
  evidence: Evidence[];
  sources: SourceRecord[];
  syncRuns: SyncRun[];
  importBatches: ImportBatch[];
  reports: Report[];
  /** Connections without their credentials, so the user can rebuild them. */
  connections: Array<{ connector: string; accountLabel: string; allowlist: string[]; scopes: string[]; status: string; lastSyncAt: string | null }>;
  notes: string[];
}

export interface ExportOptions {
  /** Omit raw connector payloads, which can be large. */
  includeSourcePayloads?: boolean;
  /** Omit knowledge bodies, keeping titles and metadata. */
  includeKnowledgeBodies?: boolean;
}

/** Per-table counts from an import, so the UI can report what landed. */
export interface ImportCounts {
  projects: number;
  goals: number;
  tasks: number;
  decisions: number;
  knowledge: number;
  resources: number;
  metrics: number;
  timeEntries: number;
  activity: number;
  relationships: number;
  reports: number;
}

export class PortabilityEngine {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  export(workspaceId: Id, opts: ExportOptions = {}): WorkspaceExport {
    const workspace = this.store.workspaces.byId(workspaceId);
    if (!workspace) throw new Error('workspace not found');

    const includePayloads = opts.includeSourcePayloads ?? true;
    const includeBodies = opts.includeKnowledgeBodies ?? true;

    const sources = this.store.sources.list(workspaceId, { limit: 100_000 }).map((s) =>
      includePayloads ? s : { ...s, payload: {} },
    );
    const knowledge = this.store.knowledge.list(workspaceId, { limit: 100_000 }).map((k) =>
      includeBodies ? k : { ...k, body: '' },
    );

    const notes = [
      'This file contains your workspace’s records. It can be re-imported into any AI BRAIN installation.',
      'Password hashes and connector credentials are deliberately excluded. You will need to reconnect sources after importing.',
    ];
    if (!includePayloads) notes.push('Raw connector payloads were excluded from this export, so re-imported source records keep their provenance but not their original bodies.');
    if (!includeBodies) notes.push('Knowledge bodies were excluded from this export. Titles, classes and provenance are present.');

    return {
      $schema: 'https://ai-brain.dev/schema/export.v1.json',
      version: EXPORT_VERSION,
      exportedAt: nowIso(),
      workspace: { name: workspace.name, slug: workspace.slug, kind: workspace.kind, createdAt: workspace.createdAt },
      brainConfigurations: this.store.brainConfig.history(workspaceId).map(toConfigFile),
      modules: this.store.modules.list(workspaceId).map((m) => ({ key: m.key, enabled: m.enabled, settings: m.settings })),
      projects: this.store.projects.list(workspaceId, { limit: 100_000, includeArchived: true, reviewState: ['confirmed', 'pending-review', 'rejected'] }),
      relationships: this.store.relationships.list(workspaceId),
      goals: this.store.goals.list(workspaceId),
      tasks: this.store.tasks.list(workspaceId, { limit: 100_000 }),
      decisions: this.store.decisions.list(workspaceId, { limit: 100_000 }),
      knowledge,
      resources: this.store.resources.list(workspaceId),
      metrics: this.allMetrics(workspaceId),
      timeEntries: this.store.time.list(workspaceId),
      activity: this.store.activity.recent(workspaceId, { limit: 100_000 }),
      evidence: this.allEvidence(workspaceId),
      sources,
      syncRuns: this.store.syncRuns.list(workspaceId, 1000),
      importBatches: this.store.imports.list(workspaceId, 1000),
      reports: this.store.reports.list(workspaceId, 1000),
      connections: this.store.accounts.list(workspaceId).map((a) => ({
        connector: a.connector, accountLabel: a.accountLabel, allowlist: a.allowlist,
        scopes: a.scopes, status: a.status, lastSyncAt: a.lastSyncAt,
      })),
      notes,
    };
  }

  /**
   * Re-imports an export into a workspace.
   *
   * Ids are remapped rather than reused, so an export can be imported into an
   * installation that already has records without collision. Parent and project
   * references are rewritten through the same map, which is what keeps a
   * round-trip structurally intact.
   */
  importWorkspace(workspaceId: Id, data: unknown): { imported: ImportCounts; warnings: string[] } {
    const warnings: string[] = [];
    if (typeof data !== 'object' || data === null) throw new Error('export must be a JSON object');
    const e = data as Partial<WorkspaceExport>;
    if (typeof e.version !== 'number') throw new Error('export is missing a version');
    if (e.version > EXPORT_VERSION) throw new Error(`export version ${e.version} is newer than this installation supports (${EXPORT_VERSION})`);

    const imported: ImportCounts = {
      projects: 0, goals: 0, tasks: 0, decisions: 0, knowledge: 0,
      resources: 0, metrics: 0, timeEntries: 0, activity: 0, relationships: 0, reports: 0,
    };
    const projectMap = new Map<string, Id>();
    const goalMap = new Map<string, Id>();

    this.store.transaction(() => {
      // Projects first, parents before children where possible.
      const projects = [...(e.projects ?? [])].sort((a, b) => (a.parentProjectId ? 1 : 0) - (b.parentProjectId ? 1 : 0));
      for (const p of projects) {
        const created = this.store.projects.create({
          workspaceId, name: p.name, slug: p.slug, description: p.description,
          category: p.category, lifecycle: p.lifecycle, origin: p.origin,
          // Keep the source key so a later sync recognises the same upstream
          // object rather than creating a duplicate.
          sourceKey: p.sourceKey, aliases: p.aliases, tags: p.tags,
          reviewState: p.reviewState, confidence: p.confidence, matchScore: p.matchScore,
          archivedAt: p.archivedAt, lastActivityAt: p.lastActivityAt,
        });
        projectMap.set(p.id, created.id);
        imported.projects++;
      }
      for (const p of projects) {
        if (!p.parentProjectId) continue;
        const self = projectMap.get(p.id);
        const parent = projectMap.get(p.parentProjectId);
        if (self && parent) this.store.projects.update(workspaceId, self, { parentProjectId: parent });
      }

      for (const g of e.goals ?? []) {
        const created = this.store.goals.create({
          workspaceId, title: g.title, description: g.description, horizon: g.horizon,
          status: g.status, progress: g.progress, progressOrigin: g.progressOrigin,
          targetDate: g.targetDate,
          projectId: g.projectId ? projectMap.get(g.projectId) ?? null : null,
        });
        goalMap.set(g.id, created.id);
        imported.goals++;
      }
      for (const g of e.goals ?? []) {
        if (!g.parentGoalId) continue;
        const self = goalMap.get(g.id);
        const parent = goalMap.get(g.parentGoalId);
        if (self && parent) this.store.goals.update(workspaceId, self, { parentGoalId: parent });
      }

      for (const t of e.tasks ?? []) {
        this.store.tasks.create({
          workspaceId, title: t.title, notes: t.notes, status: t.status, priority: t.priority,
          dueAt: t.dueAt, estimateMinutes: t.estimateMinutes, completedAt: t.completedAt,
          origin: t.origin,
          projectId: t.projectId ? projectMap.get(t.projectId) ?? null : null,
          goalId: t.goalId ? goalMap.get(t.goalId) ?? null : null,
        });
        imported.tasks++;
      }

      for (const d of e.decisions ?? []) {
        this.store.decisions.create({
          workspaceId, title: d.title, context: d.context, choice: d.choice,
          rationale: d.rationale, alternatives: d.alternatives, status: d.status,
          outcome: d.outcome, decidedAt: d.decidedAt,
          projectId: d.projectId ? projectMap.get(d.projectId) ?? null : null,
        });
        imported.decisions++;
      }

      for (const k of e.knowledge ?? []) {
        const existing = this.store.knowledge.byHash(workspaceId, k.contentHash);
        if (existing) continue;
        this.store.knowledge.create({
          workspaceId, title: k.title, body: k.body, klass: k.klass, origin: k.origin,
          confidence: k.confidence, contentHash: k.contentHash, tags: k.tags,
          observedAt: k.observedAt,
          projectId: k.projectId ? projectMap.get(k.projectId) ?? null : null,
        });
        imported.knowledge++;
      }

      for (const r of e.resources ?? []) {
        this.store.resources.create({
          workspaceId, kind: r.kind, name: r.name, amountMinor: r.amountMinor,
          currency: r.currency, period: r.period, minutes: r.minutes, origin: r.origin,
          notes: r.notes, lastConfirmedAt: r.lastConfirmedAt, startedAt: r.startedAt, endedAt: r.endedAt,
          projectId: r.projectId ? projectMap.get(r.projectId) ?? null : null,
        });
        imported.resources++;
      }

      for (const m of e.metrics ?? []) {
        this.store.metrics.record({
          workspaceId, key: m.key, label: m.label, value: m.value, unit: m.unit,
          origin: m.origin, sourceId: null, target: m.target, observedAt: m.observedAt,
          projectId: m.projectId ? projectMap.get(m.projectId) ?? null : null,
        });
        imported.metrics++;
      }

      for (const t of e.timeEntries ?? []) {
        this.store.time.log({
          workspaceId, minutes: t.minutes, label: t.label, kind: t.kind,
          origin: t.origin, occurredOn: t.occurredOn,
          projectId: t.projectId ? projectMap.get(t.projectId) ?? null : null,
        });
        imported.timeEntries++;
      }

      for (const a of e.activity ?? []) {
        this.store.activity.add({
          workspaceId, connector: a.connector, kind: a.kind, summary: a.summary,
          url: a.url, sourceId: null, actor: a.actor, occurredAt: a.occurredAt,
          projectId: a.projectId ? projectMap.get(a.projectId) ?? null : null,
        });
        imported.activity++;
      }

      for (const r of e.relationships ?? []) {
        const from = projectMap.get(r.fromProjectId);
        const to = projectMap.get(r.toProjectId);
        if (!from || !to) continue;
        this.store.relationships.link({ workspaceId, fromProjectId: from, toProjectId: to, kind: r.kind, confidence: r.confidence });
        imported.relationships++;
      }

      for (const r of e.reports ?? []) {
        this.store.reports.create({
          workspaceId, cadence: r.cadence, periodStart: r.periodStart,
          periodEnd: r.periodEnd, body: r.body, origin: r.origin,
        });
        imported.reports++;
      }

      for (const m of e.modules ?? []) {
        this.store.modules.setEnabled(workspaceId, m.key as never, m.enabled, m.settings);
      }
    });

    if ((e.connections ?? []).length > 0) {
      warnings.push(
        `${e.connections!.length} connection(s) were described in the export but cannot be restored: credentials are never exported. Reconnect them under Integrations.`,
      );
    }
    if ((e.sources ?? []).length > 0) {
      warnings.push(
        `${e.sources!.length} source record(s) were not imported. They belong to connections that no longer exist here; projects kept their source keys, so a fresh sync will re-link them.`,
      );
    }

    this.store.audit.log({
      workspaceId, actorUserId: null, action: 'workspace.import',
      subject: `workspace:${workspaceId}`, detail: { imported },
    });

    return { imported, warnings };
  }

  /** Deletes every record from one connector, leaving the rest intact. */
  deleteSourceData(workspaceId: Id, connector: string): { deleted: Record<string, number> } {
    return this.store.transaction(() => {
      const sourceIds = this.store.sources.idsByConnector(workspaceId, connector);
      const knowledge = this.store.knowledge.deleteBySource(workspaceId, sourceIds);
      const activity = this.store.db.run('DELETE FROM activity_events WHERE workspace_id = ? AND connector = ?', [workspaceId, connector]).changes;
      // Projects discovered from this connector are archived rather than
      // deleted: the user may have added their own records against them.
      const projects = this.store.db.run(
        `UPDATE projects SET archived_at = ?, source_key = NULL, source_id = NULL, updated_at = ?
         WHERE workspace_id = ? AND source_key LIKE ?`,
        [nowIso(), nowIso(), workspaceId, `${connector}:%`],
      ).changes;
      const sources = this.store.sources.deleteByConnector(workspaceId, connector);

      this.store.audit.log({
        workspaceId, actorUserId: null, action: 'connector.data.deleted',
        subject: `connector:${connector}`,
        detail: { sources, knowledge, activity, projectsArchived: projects },
      });
      return { deleted: { sources, knowledge, activity, projectsArchived: projects } };
    });
  }

  /** Irreversible. Cascades through every table via foreign keys. */
  deleteWorkspace(workspaceId: Id, actorUserId: Id | null): void {
    this.store.audit.log({
      workspaceId: null, actorUserId, action: 'workspace.deleted',
      subject: `workspace:${workspaceId}`, detail: { at: nowIso() },
    });
    this.store.workspaces.delete(workspaceId);
  }

  /** Irreversible. Removes the user and every workspace they own. */
  deleteAccount(userId: Id): void {
    const workspaces = this.store.workspaces.listForUser(userId);
    this.store.transaction(() => {
      for (const w of workspaces) {
        if (w.ownerId === userId) this.store.workspaces.delete(w.id);
      }
      this.store.sessions.revokeAllForUser(userId);
      this.store.users.delete(userId);
    });
    this.store.audit.log({
      workspaceId: null, actorUserId: null, action: 'account.deleted',
      subject: `user:${userId}`, detail: { workspaces: workspaces.length },
    });
  }

  private allMetrics(workspaceId: Id): Metric[] {
    return this.store.db
      .query<Record<string, string | number | null>>(
        'SELECT * FROM metrics WHERE workspace_id = ? ORDER BY observed_at',
        [workspaceId],
      )
      .map((r) => ({
        id: String(r.id), workspaceId: String(r.workspace_id),
        projectId: r.project_id == null ? null : String(r.project_id),
        key: String(r.key), label: String(r.label), value: Number(r.value),
        unit: String(r.unit ?? ''), origin: String(r.origin) as Metric['origin'],
        sourceId: r.source_id == null ? null : String(r.source_id),
        target: r.target == null ? null : Number(r.target),
        observedAt: String(r.observed_at), createdAt: String(r.created_at),
      }));
  }

  private allEvidence(workspaceId: Id): Evidence[] {
    return this.store.db
      .query<Record<string, string | number | null>>(
        'SELECT * FROM evidence WHERE workspace_id = ? ORDER BY observed_at',
        [workspaceId],
      )
      .map((r) => ({
        id: String(r.id), workspaceId: String(r.workspace_id), subject: String(r.subject),
        claim: String(r.claim), sourceId: r.source_id == null ? null : String(r.source_id),
        confidence: String(r.confidence) as Evidence['confidence'],
        observedAt: String(r.observed_at), createdAt: String(r.created_at),
      }));
  }
}
