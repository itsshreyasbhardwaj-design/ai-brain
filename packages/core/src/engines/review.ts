/**
 * The Four Cs framework and the review engine.
 *
 * C1 Context      — how complete, current and traceable the knowledge base is
 * C2 Connections  — which authorized sources are connected and actually working
 * C3 Capabilities — what this installation can genuinely do right now
 * C4 Cadence      — whether the user is actually reviewing their own system
 *
 * Each assessment reports what it measured and what it could not measure. A
 * dimension with nothing to go on returns `measurable: false` instead of a
 * flattering default — an empty system should look empty, not healthy.
 */

import type {
  BrainConfiguration, Cadence, Id, Iso, ModuleKey, Report,
} from '../domain/types.ts';
import type { Store } from '../db/repositories.ts';
import { nowIso, periodFor, daysBetween, relativeLabel } from '../util/time.ts';
import { CONNECTORS } from '../connectors/registry.ts';
import { KnowledgeEngine } from './knowledge.ts';
import { ResourceEngine } from './resources.ts';
import { formatMoney } from './passport.ts';

export type Grade = 'strong' | 'workable' | 'thin' | 'empty' | 'unknown';

export interface Assessment {
  key: 'context' | 'connections' | 'capabilities' | 'cadence';
  label: string;
  grade: Grade;
  /** Whether there was enough data to judge at all. */
  measurable: boolean;
  /** Each measurement, with the number it came from. */
  findings: string[];
  /** What this assessment could not see. */
  gaps: string[];
  /** Concrete next actions, highest value first. */
  actions: string[];
}

export interface FourCs {
  context: Assessment;
  connections: Assessment;
  capabilities: Assessment;
  cadence: Assessment;
  generatedAt: Iso;
}

export interface ReviewBody {
  cadence: Cadence;
  periodStart: Iso;
  periodEnd: Iso;
  /** Only things that actually happened, each with a count. */
  verifiedProgress: string[];
  recentChanges: string[];
  currentGoals: Array<{ title: string; status: string; progress: number }>;
  bottlenecks: string[];
  decisions: Array<{ title: string; decidedAt: string; status: string }>;
  resourceUtilisation: string[];
  dataQuality: string[];
  topActions: string[];
  fourCs: FourCs;
}

export class ReviewEngine {
  private readonly store: Store;
  private readonly knowledge: KnowledgeEngine;
  private readonly resources: ResourceEngine;

  constructor(store: Store) {
    this.store = store;
    this.knowledge = new KnowledgeEngine(store);
    this.resources = new ResourceEngine(store);
  }

  /* ------------------------------ Four Cs ------------------------------ */

  fourCs(workspaceId: Id, config: BrainConfiguration | null): FourCs {
    return {
      context: this.assessContext(workspaceId),
      connections: this.assessConnections(workspaceId),
      capabilities: this.assessCapabilities(workspaceId, config),
      cadence: this.assessCadence(workspaceId, config),
      generatedAt: nowIso(),
    };
  }

  private assessContext(workspaceId: Id): Assessment {
    const stats = this.knowledge.stats(workspaceId);
    const projects = this.store.projects.list(workspaceId, { limit: 1000 });
    const findings: string[] = [];
    const gaps: string[] = [];
    const actions: string[] = [];

    if (stats.total === 0 && projects.length === 0) {
      return {
        key: 'context', label: 'Context', grade: 'empty', measurable: false,
        findings: ['Nothing has been recorded yet.'],
        gaps: ['No projects, no knowledge records.'],
        actions: ['Add your first project, or import a folder of notes.'],
      };
    }

    findings.push(`${stats.total} knowledge record(s) across ${Object.entries(stats.byClass).filter(([, v]) => v > 0).length} of the 5 classes.`);
    findings.push(`${projects.length} project(s), ${projects.filter((p) => p.lifecycle === 'active').length} marked active.`);

    const traceable = stats.total === 0 ? 0 : Math.round((stats.withSource / stats.total) * 100);
    findings.push(`${traceable}% of knowledge records are linked to a source record.`);
    if (traceable < 50 && stats.total > 5) {
      gaps.push('Most knowledge has no source link, so claims cannot be traced back.');
      actions.push('Import notes through a connector or attach sources, so records carry provenance.');
    }

    if (stats.stale > 0) {
      gaps.push(`${stats.stale} record(s) have not been confirmed in over 180 days.`);
      actions.push(`Review the ${stats.stale} stale record(s) and supersede what is out of date.`);
    }
    if (stats.contradictions > 0) {
      gaps.push(`${stats.contradictions} record(s) conflict with another record.`);
      actions.push('Resolve conflicting records so the assistant is not given both versions.');
    }
    if (stats.generated > 0) {
      findings.push(`${stats.generated} record(s) are model-generated and labelled as such.`);
    }

    const withoutDescription = projects.filter((p) => p.description.trim() === '').length;
    if (withoutDescription > 0) {
      gaps.push(`${withoutDescription} project(s) have no description.`);
    }
    const pending = projects.filter((p) => p.reviewState === 'pending-review').length;
    if (pending > 0) actions.unshift(`Review ${pending} discovered project(s) waiting for approval.`);

    const emptyClasses = (Object.entries(stats.byClass) as Array<[string, number]>).filter(([, v]) => v === 0).map(([k]) => k);
    if (emptyClasses.length > 0 && stats.total > 0) {
      gaps.push(`No records yet in: ${emptyClasses.join(', ')}.`);
    }

    const grade: Grade =
      stats.total >= 50 && traceable >= 50 && stats.contradictions === 0 ? 'strong'
      : stats.total >= 10 ? 'workable'
      : 'thin';

    return { key: 'context', label: 'Context', grade, measurable: true, findings, gaps, actions: actions.slice(0, 5) };
  }

  private assessConnections(workspaceId: Id): Assessment {
    const accounts = this.store.accounts.list(workspaceId);
    const findings: string[] = [];
    const gaps: string[] = [];
    const actions: string[] = [];

    if (accounts.length === 0) {
      return {
        key: 'connections', label: 'Connections', grade: 'empty', measurable: false,
        findings: ['No sources are connected.'],
        gaps: ['Every record will be one you entered by hand.'],
        actions: ['Connect GitHub with a read-only token to discover repositories automatically.',
                  'Or import a folder of Markdown notes — no account needed.'],
      };
    }

    for (const acc of accounts) {
      const run = this.store.syncRuns.latestFor(workspaceId, acc.id);
      const def = CONNECTORS[acc.connector];
      const freshness = acc.lastSyncAt ? relativeLabel(acc.lastSyncAt) : 'never synced';
      findings.push(`${def?.label ?? acc.connector} (${acc.accountLabel}): ${acc.status}, last sync ${freshness}.`);

      if (acc.status === 'error') {
        gaps.push(`${def?.label ?? acc.connector} is failing: ${acc.lastError ?? 'unknown error'}`);
        actions.push(`Fix or reconnect ${def?.label ?? acc.connector}.`);
      }
      if (acc.status === 'revoked') {
        gaps.push(`${def?.label ?? acc.connector} has been revoked; its records are frozen at the last sync.`);
      }
      if (acc.status === 'active' && !acc.lastSyncAt) {
        actions.push(`Run the first sync for ${def?.label ?? acc.connector}.`);
      }
      if (acc.lastSyncAt && daysBetween(acc.lastSyncAt, nowIso()) > 7) {
        gaps.push(`${def?.label ?? acc.connector} has not synced for ${daysBetween(acc.lastSyncAt, nowIso())} days.`);
      }
      if (run?.status === 'partial') {
        gaps.push(`The last ${def?.label ?? acc.connector} sync completed only partially.`);
      }
      if (acc.allowlist.length === 0 && def?.mode !== 'manual-export') {
        findings.push(`${def?.label ?? acc.connector} has no allowlist, so its full authorized scope is read.`);
      }
      if (def?.mode === 'manual-export') {
        gaps.push(`${def.label} depends on files you export yourself; it is not a live connection.`);
      }
    }

    const active = accounts.filter((a) => a.status === 'active').length;
    const grade: Grade = gaps.length === 0 && active === accounts.length ? 'strong' : active > 0 ? 'workable' : 'thin';
    return { key: 'connections', label: 'Connections', grade, measurable: true, findings, gaps, actions: actions.slice(0, 5) };
  }

  private assessCapabilities(workspaceId: Id, config: BrainConfiguration | null): Assessment {
    const enabled: ModuleKey[] = config?.modules ?? this.store.modules.enabledKeys(workspaceId);
    const accounts = this.store.accounts.list(workspaceId).filter((a) => a.status === 'active');
    const connectedKeys = new Set(accounts.map((a) => a.connector));
    const findings: string[] = [];
    const gaps: string[] = [];
    const actions: string[] = [];

    findings.push(`${enabled.length} module(s) enabled: ${enabled.join(', ') || 'none'}.`);
    findings.push(
      config?.privacy.allowRemoteAi
        ? 'Remote AI is allowed, so an AI provider can be used for explanations.'
        : 'Remote AI is off. Everything works, but explanations are rule-based rather than written by a model.',
    );

    // A module with no data source is honestly reported as not yet useful.
    if (enabled.includes('developer') && !connectedKeys.has('github') && !connectedKeys.has('local-directory')) {
      gaps.push('Developer Intelligence is on, but no code source is connected, so it has nothing to show.');
      actions.push('Connect GitHub or authorize a local directory to populate Developer Intelligence.');
    }
    if (enabled.includes('resources')) {
      const summary = this.resources.summary(workspaceId);
      if (!summary.hasAnyData) {
        gaps.push('Resource Optimization is on, but no time or cost has been recorded.');
        actions.push('Log a cost or some time to make the resource reports meaningful.');
      } else {
        findings.push(`Resources: ${formatMoney(summary.monthlyCostMinor, summary.currency)}/month recorded, ${(summary.weeklyMinutes / 60).toFixed(1)} h logged this week.`);
      }
    }
    if (enabled.includes('business')) {
      const metrics = this.store.metrics.latest(workspaceId, null);
      if (metrics.length === 0) {
        gaps.push('Business Intelligence is on, but no metrics have been recorded.');
      }
    }
    if (enabled.includes('assistant')) {
      const tokens = this.store.tokens.list(workspaceId).filter((t) => !t.revokedAt);
      findings.push(tokens.length > 0
        ? `${tokens.length} access token(s) issued, so external AI assistants can read this brain over MCP.`
        : 'No access tokens issued yet, so no external assistant can read this brain.');
      if (tokens.length === 0) actions.push('Issue a scoped access token to let Claude Code or another MCP client read your brain.');
    }

    const roadmap = Object.values(CONNECTORS).filter((c) => c.status === 'roadmap').map((c) => c.label);
    if (roadmap.length > 0) gaps.push(`Not available in this release: ${roadmap.join(', ')}.`);

    const grade: Grade = gaps.length <= 1 ? 'strong' : gaps.length <= 3 ? 'workable' : 'thin';
    return { key: 'capabilities', label: 'Capabilities', grade, measurable: true, findings, gaps, actions: actions.slice(0, 5) };
  }

  private assessCadence(workspaceId: Id, config: BrainConfiguration | null): Assessment {
    const reports = this.store.reports.list(workspaceId, 20);
    const target = config?.reportingCadence ?? 'weekly';
    const findings: string[] = [];
    const gaps: string[] = [];
    const actions: string[] = [];

    if (reports.length === 0) {
      return {
        key: 'cadence', label: 'Cadence', grade: 'empty', measurable: false,
        findings: [`Target cadence is ${target}, but no review has been run yet.`],
        gaps: ['Nothing has been reviewed, so nothing has been caught.'],
        actions: ['Run your first review. It takes one click and needs no AI provider.'],
      };
    }

    const last = reports[0]!;
    const sinceLast = daysBetween(last.createdAt, nowIso());
    findings.push(`${reports.length} review(s) on record; the last was ${relativeLabel(last.createdAt)}.`);
    findings.push(`Target cadence: ${target}.`);

    const expectedGap: Record<Cadence, number> = { daily: 1, weekly: 7, monthly: 31, quarterly: 92, manual: Number.MAX_SAFE_INTEGER };
    const allowed = expectedGap[target];
    if (sinceLast > allowed * 1.5) {
      gaps.push(`The last review was ${sinceLast} days ago, which is behind a ${target} cadence.`);
      actions.push('Run a review now to catch up.');
    }

    const decisions = this.store.decisions.list(workspaceId, { limit: 50 });
    if (decisions.length === 0) {
      gaps.push('No decisions have been recorded, so reviews cannot show what changed and why.');
    } else {
      findings.push(`${decisions.length} decision(s) recorded.`);
      const withoutOutcome = decisions.filter((d) => d.status === 'accepted' && d.outcome.trim() === '').length;
      if (withoutOutcome > 0) {
        gaps.push(`${withoutOutcome} accepted decision(s) have no outcome recorded.`);
        actions.push('Record outcomes on past decisions so you can tell which ones worked.');
      }
    }

    const grade: Grade = sinceLast <= allowed ? 'strong' : sinceLast <= allowed * 2 ? 'workable' : 'thin';
    return { key: 'cadence', label: 'Cadence', grade, measurable: true, findings, gaps, actions: actions.slice(0, 5) };
  }

  /* ------------------------------ Reviews ------------------------------ */

  /** Builds a review over the period a cadence covers. Needs no AI provider. */
  buildReview(workspaceId: Id, cadence: Cadence, config: BrainConfiguration | null): ReviewBody {
    const { start, end } = periodFor(cadence === 'manual' ? 'weekly' : cadence);

    const completed = this.store.tasks.completedBetween(workspaceId, start, end);
    const activity = this.store.activity.recent(workspaceId, { since: start, limit: 500 });
    const decisions = this.store.decisions.list(workspaceId, { since: start, limit: 50 });
    const newProjects = this.store.projects.list(workspaceId, { limit: 500 }).filter((p) => p.createdAt >= start);
    const newKnowledge = this.store.knowledge.list(workspaceId, { limit: 1000 }).filter((k) => k.createdAt >= start);
    const goals = this.store.goals.list(workspaceId).filter((g) => g.status === 'active' || g.status === 'at-risk');

    const verifiedProgress: string[] = [];
    if (completed.length) verifiedProgress.push(`${completed.length} task(s) completed.`);
    if (activity.length) {
      const byConnector = new Map<string, number>();
      for (const a of activity) byConnector.set(a.connector, (byConnector.get(a.connector) ?? 0) + 1);
      verifiedProgress.push(
        `${activity.length} activity event(s) recorded (${[...byConnector.entries()].map(([c, n]) => `${c}: ${n}`).join(', ')}).`,
      );
    }
    if (newKnowledge.length) verifiedProgress.push(`${newKnowledge.length} knowledge record(s) added.`);
    if (verifiedProgress.length === 0) {
      verifiedProgress.push('Nothing was recorded in this period. That means nothing was captured, not necessarily that nothing happened.');
    }

    const recentChanges: string[] = [];
    if (newProjects.length) recentChanges.push(`${newProjects.length} new project(s): ${newProjects.slice(0, 5).map((p) => p.name).join(', ')}.`);
    const renamed = activity.filter((a) => a.kind === 'project.renamed');
    if (renamed.length) recentChanges.push(`${renamed.length} project(s) renamed.`);
    const lifecycleChanged = this.store.projects.list(workspaceId, { limit: 500 }).filter((p) => p.updatedAt >= start && p.createdAt < start);
    if (lifecycleChanged.length) recentChanges.push(`${lifecycleChanged.length} existing project(s) updated.`);

    const bottlenecks: string[] = [];
    const allocation = this.resources.allocation(workspaceId);
    for (const row of allocation.filter((r) => r.verdict === 'blocked').slice(0, 5)) {
      bottlenecks.push(`${row.project.name}: ${row.because.join('; ')}.`);
    }
    for (const row of allocation.filter((r) => r.verdict === 'consuming-without-progress').slice(0, 5)) {
      bottlenecks.push(`${row.project.name} is consuming resources without progress — ${row.because.join('; ')}.`);
    }
    const overdue = this.store.tasks.list(workspaceId, { status: ['todo', 'doing'] }).filter((t) => t.dueAt && t.dueAt < end);
    if (overdue.length) bottlenecks.push(`${overdue.length} task(s) are overdue.`);
    if (bottlenecks.length === 0) bottlenecks.push('No blocked projects or overdue tasks recorded.');

    const resourceUtilisation: string[] = [];
    const time = this.resources.timeReport(workspaceId, Math.max(1, daysBetween(start, end)));
    if (time.hasData) {
      resourceUtilisation.push(`${(time.totalMinutes / 60).toFixed(1)} h logged across ${time.byProject.length} project(s).`);
      if (time.byProject[0]) resourceUtilisation.push(`Most time went to ${time.byProject[0].projectName} (${time.byProject[0].share}%).`);
      if (time.overcommitment) resourceUtilisation.push(`Commitments exceed capacity by ${(time.overcommitment.overBy / 60).toFixed(1)} h.`);
    } else {
      resourceUtilisation.push('No time logged in this period.');
    }
    const cost = this.resources.costReport(workspaceId);
    if (cost.hasData) {
      resourceUtilisation.push(`${formatMoney(cost.monthlyRecurringMinor, cost.currency)}/month in recorded recurring costs.`);
      for (const a of cost.anomalies.slice(0, 3)) resourceUtilisation.push(`Cost anomaly: ${a.resource.name} — ${a.reason}.`);
      for (const b of cost.budgets.filter((b) => b.overBy > 0)) {
        resourceUtilisation.push(`Budget "${b.name}" is over by ${formatMoney(b.overBy, cost.currency)}.`);
      }
    } else {
      resourceUtilisation.push('No costs recorded.');
    }

    const fourCs = this.fourCs(workspaceId, config);
    const dataQuality = [...fourCs.context.gaps, ...fourCs.connections.gaps];
    if (dataQuality.length === 0) dataQuality.push('No data-quality problems detected.');

    const topActions = [
      ...fourCs.context.actions, ...fourCs.connections.actions,
      ...fourCs.capabilities.actions, ...fourCs.cadence.actions,
    ].filter((a, i, arr) => arr.indexOf(a) === i).slice(0, 7);
    if (topActions.length === 0) topActions.push('Nothing is flagged. Keep going.');

    return {
      cadence, periodStart: start, periodEnd: end,
      verifiedProgress, recentChanges: recentChanges.length ? recentChanges : ['No structural changes recorded.'],
      currentGoals: goals.map((g) => ({ title: g.title, status: g.status, progress: g.progress })),
      bottlenecks,
      decisions: decisions.map((d) => ({ title: d.title, decidedAt: d.decidedAt, status: d.status })),
      resourceUtilisation, dataQuality, topActions, fourCs,
    };
  }

  /** Builds a review and stores it, which also advances the cadence clock. */
  runReview(workspaceId: Id, cadence: Cadence, config: BrainConfiguration | null): { report: Report; body: ReviewBody } {
    const body = this.buildReview(workspaceId, cadence, config);
    const report = this.store.reports.create({
      workspaceId, cadence, periodStart: body.periodStart, periodEnd: body.periodEnd,
      body: body as unknown as Record<string, unknown>,
      // Derived from stored records by fixed rules, so it is reproducible.
      origin: 'derived',
    });
    return { report, body };
  }
}

export const GRADE_LABELS: Record<Grade, string> = {
  strong: 'Strong',
  workable: 'Workable',
  thin: 'Thin',
  empty: 'Nothing recorded',
  unknown: 'Unknown',
};
