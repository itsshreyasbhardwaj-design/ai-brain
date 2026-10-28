/**
 * Dashboard assembly.
 *
 * Each widget returns either real rows or an explicit empty state carrying the
 * reason it is empty and the action that would fill it. There is no third
 * option: a widget never renders a zero, a placeholder or a sample value that
 * could be mistaken for data.
 */

import type { BrainConfiguration, Id, ModuleKey } from '../domain/types.ts';
import type { Store } from '../db/repositories.ts';
import { nowIso, relativeLabel, daysBetween } from '../util/time.ts';
import { ResourceEngine, VERDICT_LABELS } from './resources.ts';
import { formatMoney, monthlyMinor, recommendFor } from './passport.ts';
import { WIDGET_CATALOG } from './profiles.ts';
import { CONNECTORS } from '../connectors/registry.ts';

export interface WidgetRow {
  primary: string;
  secondary?: string;
  href?: string;
  badge?: string;
  /** Rendered with the uncertainty treatment in the UI. */
  uncertain?: boolean;
}

export interface Widget {
  key: string;
  label: string;
  span: number;
  rows: WidgetRow[];
  /** Headline figure, when the widget has one. */
  headline?: { value: string; caption: string };
  /** Present only when there is nothing to show. */
  empty?: { reason: string; action: string; href?: string };
  footnote?: string;
}

export interface DashboardData {
  widgets: Widget[];
  generatedAt: string;
  /** Counts used by the shell chrome. */
  counts: {
    projects: number;
    pendingReview: number;
    openTasks: number;
    knowledge: number;
    connections: number;
    staleConnections: number;
  };
}

export class DashboardEngine {
  private readonly store: Store;
  private readonly resources: ResourceEngine;

  constructor(store: Store) {
    this.store = store;
    this.resources = new ResourceEngine(store);
  }

  build(workspaceId: Id, config: BrainConfiguration | null): DashboardData {
    const modules: ModuleKey[] = config?.modules ?? this.store.modules.enabledKeys(workspaceId);
    const layout = config?.dashboardLayout ?? { columns: 12, widgets: [] };

    const widgets: Widget[] = [];
    for (const w of layout.widgets) {
      if (!w.visible) continue;
      const meta = WIDGET_CATALOG[w.key];
      if (meta?.requires && !modules.includes(meta.requires)) continue;
      const built = this.widget(workspaceId, w.key, w.span, config);
      if (built) widgets.push(built);
    }

    const accounts = this.store.accounts.list(workspaceId);
    return {
      widgets,
      generatedAt: nowIso(),
      counts: {
        projects: this.store.projects.list(workspaceId, { limit: 10_000 }).length,
        pendingReview: this.store.projects.list(workspaceId, { reviewState: ['pending-review'], limit: 1000 }).length,
        openTasks: this.store.tasks.list(workspaceId, { status: ['todo', 'doing', 'blocked'] }).length,
        knowledge: this.store.knowledge.total(workspaceId),
        connections: accounts.filter((a) => a.status === 'active').length,
        staleConnections: accounts.filter(
          (a) => a.status === 'error' || (a.lastSyncAt && daysBetween(a.lastSyncAt, nowIso()) > 7),
        ).length,
      },
    };
  }

  private widget(workspaceId: Id, key: string, span: number, config: BrainConfiguration | null): Widget | null {
    const meta = WIDGET_CATALOG[key];
    const label = meta?.label ?? key;
    const base = { key, label, span };

    switch (key) {
      case 'priorities': {
        const tasks = this.store.tasks.list(workspaceId, { status: ['doing', 'todo', 'blocked'], limit: 8 });
        if (tasks.length === 0) {
          return { ...base, rows: [], empty: { reason: 'No open tasks.', action: 'Add a task', href: '/tasks' } };
        }
        const now = nowIso();
        return {
          ...base,
          rows: tasks.map((t): WidgetRow => ({
            primary: t.title,
            secondary: [
              t.status,
              t.dueAt ? (t.dueAt < now ? `overdue ${t.dueAt.slice(0, 10)}` : `due ${t.dueAt.slice(0, 10)}`) : null,
              t.projectId ? this.store.projects.byId(workspaceId, t.projectId)?.name : null,
            ].filter(Boolean).join(' · '),
            href: '/tasks',
            badge: `P${t.priority}`,
          })),
        };
      }

      case 'active-projects': {
        const projects = this.store.projects.list(workspaceId, { lifecycle: ['active'], reviewState: ['confirmed'], limit: 8 });
        if (projects.length === 0) {
          return { ...base, rows: [], empty: { reason: 'No active projects.', action: 'Add a project, or connect GitHub', href: '/projects' } };
        }
        return {
          ...base,
          rows: projects.map((p): WidgetRow => ({
            primary: p.name,
            secondary: `${p.category} · last activity ${relativeLabel(p.lastActivityAt)}`,
            href: `/projects/${p.slug}`,
          })),
        };
      }

      case 'discovered-projects': {
        const pending = this.store.projects.list(workspaceId, { reviewState: ['pending-review'], limit: 8 });
        if (pending.length === 0) {
          return {
            ...base, rows: [],
            empty: { reason: 'Nothing is waiting for review.', action: 'Connect a source to discover projects automatically', href: '/integrations' },
          };
        }
        return {
          ...base,
          headline: { value: String(pending.length), caption: 'awaiting your review' },
          rows: pending.map((p): WidgetRow => ({
            primary: p.name,
            secondary: `confidence ${p.matchScore.toFixed(2)} · from ${p.sourceKey?.split(':')[0] ?? 'unknown source'}`,
            href: `/projects/review`,
            uncertain: true,
          })),
          footnote: 'Discovered automatically. Nothing is treated as yours until you confirm it.',
        };
      }

      case 'recent-activity': {
        const events = this.store.activity.recent(workspaceId, { limit: 8 });
        if (events.length === 0) {
          return {
            ...base, rows: [],
            empty: { reason: 'No activity recorded yet.', action: 'Connect a source, or log work against a project', href: '/integrations' },
          };
        }
        return {
          ...base,
          rows: events.map((e): WidgetRow => ({
            primary: e.summary,
            secondary: `${e.connector} · ${relativeLabel(e.occurredAt)}`,
            ...(e.url ? { href: e.url } : {}),
          })),
        };
      }

      case 'upcoming-commitments': {
        const soon = this.store.tasks
          .list(workspaceId, { status: ['todo', 'doing'], limit: 100 })
          .filter((t) => t.dueAt)
          .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
          .slice(0, 6);
        if (soon.length === 0) {
          return { ...base, rows: [], empty: { reason: 'Nothing has a due date.', action: 'Add a due date to a task', href: '/tasks' } };
        }
        return {
          ...base,
          rows: soon.map((t): WidgetRow => ({
            primary: t.title,
            secondary: `${t.dueAt!.slice(0, 10)} · in ${daysBetween(nowIso(), t.dueAt!)} day(s)`,
            href: '/tasks',
          })),
        };
      }

      case 'resource-usage': {
        const summary = this.resources.summary(workspaceId);
        if (!summary.hasAnyData) {
          return {
            ...base, rows: [],
            empty: { reason: 'No time or cost recorded.', action: 'Record a cost or log some time', href: '/resources' },
          };
        }
        const rows: WidgetRow[] = [
          { primary: `${(summary.weeklyMinutes / 60).toFixed(1)} h logged this week`, secondary: 'only explicitly logged time is counted' },
          { primary: `${formatMoney(summary.monthlyCostMinor, summary.currency)} / month recorded`, secondary: `${summary.toolCount} tool(s) and service(s)` },
        ];
        if (summary.unconfirmedTools > 0) {
          rows.push({ primary: `${summary.unconfirmedTools} tool(s) not confirmed recently`, secondary: 'review whether you still use them', href: '/resources', uncertain: true });
        }
        return { ...base, rows, headline: { value: formatMoney(summary.monthlyCostMinor, summary.currency), caption: 'recorded monthly cost' } };
      }

      case 'financial-summary': {
        const cost = this.resources.costReport(workspaceId);
        if (!cost.hasData) {
          return { ...base, rows: [], empty: { reason: 'No costs recorded.', action: 'Add a subscription or infrastructure cost', href: '/resources' } };
        }
        return {
          ...base,
          headline: { value: formatMoney(cost.monthlyRecurringMinor, cost.currency), caption: 'per month, recorded' },
          rows: cost.byKind.slice(0, 5).map((k): WidgetRow => ({
            primary: k.kind,
            secondary: `${formatMoney(k.monthlyMinor, cost.currency)} / month across ${k.count} item(s)`,
            href: '/resources',
          })),
          footnote: cost.anomalies.length > 0 ? `${cost.anomalies.length} cost anomaly/anomalies flagged.` : undefined,
        };
      }

      case 'business-summary': {
        const metrics = this.store.metrics.latest(workspaceId, null).filter((m) => /revenue|customer|pipeline|burn|runway|mrr|arr/i.test(m.key));
        if (metrics.length === 0) {
          return {
            ...base, rows: [],
            empty: { reason: 'No business metrics recorded.', action: 'Record a metric such as revenue or active customers', href: '/resources' },
          };
        }
        return {
          ...base,
          rows: metrics.slice(0, 6).map((m): WidgetRow => ({
            primary: `${m.label || m.key}: ${m.value}${m.unit ? ` ${m.unit}` : ''}`,
            secondary: `${m.origin} · ${relativeLabel(m.observedAt)}`,
            uncertain: m.origin === 'generated',
          })),
        };
      }

      case 'developer-health': {
        const rows: WidgetRow[] = [];
        const projects = this.store.projects.list(workspaceId, { category: ['software'], limit: 200 });
        if (projects.length === 0) {
          return {
            ...base, rows: [],
            empty: { reason: 'No software projects yet.', action: 'Connect GitHub or authorize a local directory', href: '/integrations' },
          };
        }
        const failing: WidgetRow[] = [];
        for (const p of projects) {
          const ci = this.store.metrics.latest(workspaceId, p.id).find((m) => m.key === 'ci_pass_rate');
          if (ci && ci.value < 100) {
            failing.push({
              primary: `${p.name}: CI at ${ci.value}%`,
              secondary: `observed ${relativeLabel(ci.observedAt)}`,
              href: `/projects/${p.slug}`,
            });
          }
        }
        rows.push(...failing.slice(0, 5));
        const stale = projects.filter((p) => p.lifecycle === 'active' && p.lastActivityAt && daysBetween(p.lastActivityAt, nowIso()) > 45);
        for (const p of stale.slice(0, 4)) {
          rows.push({ primary: `${p.name} is quiet`, secondary: `no activity for ${daysBetween(p.lastActivityAt!, nowIso())} days`, href: `/projects/${p.slug}` });
        }
        if (rows.length === 0) {
          const withCi = projects.filter((p) => this.store.metrics.latest(workspaceId, p.id).some((m) => m.key === 'ci_pass_rate')).length;
          return {
            ...base, rows: [],
            empty: {
              reason: withCi > 0
                ? `All ${withCi} project(s) with CI data are passing and active.`
                : 'No CI data has been observed yet.',
              action: withCi > 0 ? 'Nothing to do' : 'Sync GitHub to collect CI results',
              href: '/integrations',
            },
          };
        }
        return { ...base, rows, footnote: `Across ${projects.length} software project(s).` };
      }

      case 'decisions': {
        const decisions = this.store.decisions.list(workspaceId, { limit: 6 });
        if (decisions.length === 0) {
          return { ...base, rows: [], empty: { reason: 'No decisions recorded.', action: 'Record a decision and why you made it', href: '/decisions' } };
        }
        return {
          ...base,
          rows: decisions.map((d): WidgetRow => ({
            primary: d.title,
            secondary: `${d.decidedAt.slice(0, 10)} · ${d.status}`,
            href: `/decisions/${d.id}`,
          })),
        };
      }

      case 'risks': {
        const allocation = this.resources.allocation(workspaceId);
        const flagged = allocation.filter((r) => ['blocked', 'needs-attention', 'consuming-without-progress'].includes(r.verdict));
        if (flagged.length === 0) {
          return {
            ...base, rows: [],
            empty: {
              reason: allocation.length === 0 ? 'No projects to assess.' : 'No blocked projects, overdue tasks or idle spend.',
              action: allocation.length === 0 ? 'Add a project' : 'Nothing to do',
              href: '/projects',
            },
          };
        }
        return {
          ...base,
          rows: flagged.slice(0, 6).map((r): WidgetRow => ({
            primary: r.project.name,
            secondary: `${VERDICT_LABELS[r.verdict]} — ${r.because[0] ?? ''}`,
            href: `/projects/${r.project.slug}`,
            badge: VERDICT_LABELS[r.verdict],
          })),
        };
      }

      case 'connected-sources': {
        const accounts = this.store.accounts.list(workspaceId);
        if (accounts.length === 0) {
          return {
            ...base, rows: [],
            empty: { reason: 'Nothing is connected.', action: 'Connect a source', href: '/integrations' },
          };
        }
        return {
          ...base,
          rows: accounts.map((a): WidgetRow => {
            const def = CONNECTORS[a.connector];
            return {
              primary: `${def?.label ?? a.connector} — ${a.accountLabel}`,
              secondary: a.status === 'active'
                ? `last sync ${relativeLabel(a.lastSyncAt)}${def?.mode === 'manual-export' ? ' · manual import only' : ''}`
                : `${a.status}${a.lastError ? `: ${a.lastError.slice(0, 80)}` : ''}`,
              href: '/integrations',
              uncertain: a.status !== 'active',
            };
          }),
        };
      }

      case 'knowledge-updates': {
        const recent = this.store.knowledge.list(workspaceId, { limit: 6 });
        if (recent.length === 0) {
          return { ...base, rows: [], empty: { reason: 'Knowledge base is empty.', action: 'Import notes or write a record', href: '/knowledge' } };
        }
        return {
          ...base,
          rows: recent.map((k): WidgetRow => ({
            primary: k.title,
            secondary: `${k.klass} · ${k.origin} · ${relativeLabel(k.observedAt)}`,
            href: `/knowledge/${k.id}`,
            uncertain: k.origin === 'generated' || k.contradictsId !== null,
            ...(k.contradictsId ? { badge: 'conflict' } : {}),
          })),
        };
      }

      case 'goals':
      case 'personal-goals': {
        const goals = this.store.goals.list(workspaceId).filter((g) => g.status === 'active' || g.status === 'at-risk');
        if (goals.length === 0) {
          return { ...base, rows: [], empty: { reason: 'No active goals.', action: 'Set a goal', href: '/goals' } };
        }
        return {
          ...base,
          rows: goals.slice(0, 6).map((g): WidgetRow => ({
            primary: g.title,
            secondary: `${g.progress}% · ${g.horizon}${g.targetDate ? ` · ${g.targetDate.slice(0, 10)}` : ''}`,
            href: '/goals',
            badge: g.status === 'at-risk' ? 'at risk' : undefined,
            uncertain: g.progressOrigin === 'generated',
          })),
        };
      }

      case 'weekly-progress': {
        const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
        const done = this.store.tasks.completedBetween(workspaceId, since, nowIso());
        const activity = this.store.activity.countSince(workspaceId, since);
        const knowledge = this.store.knowledge.list(workspaceId, { limit: 1000 }).filter((k) => k.createdAt >= since).length;
        if (done.length === 0 && activity === 0 && knowledge === 0) {
          return {
            ...base, rows: [],
            empty: { reason: 'Nothing recorded in the last 7 days.', action: 'Complete a task or sync a source', href: '/tasks' },
          };
        }
        return {
          ...base,
          rows: [
            { primary: `${done.length} task(s) completed` },
            { primary: `${activity} activity event(s) recorded` },
            { primary: `${knowledge} knowledge record(s) added` },
          ],
          footnote: 'Counts of what was captured, which is not the same as everything you did.',
        };
      }

      case 'ai-recommendations': {
        const projects = this.store.projects.list(workspaceId, { reviewState: ['confirmed'], limit: 30 });
        const rows: WidgetRow[] = [];
        for (const p of projects) {
          for (const rec of recommendFor(this.store, workspaceId, p).filter((r) => r.priority === 'now')) {
            rows.push({ primary: rec.action, secondary: `${p.name} — ${rec.because}`, href: `/projects/${p.slug}` });
            if (rows.length >= 6) break;
          }
          if (rows.length >= 6) break;
        }
        if (rows.length === 0) {
          return {
            ...base, rows: [],
            empty: {
              reason: projects.length === 0 ? 'No projects to make recommendations from.' : 'Nothing is urgent across your projects.',
              action: projects.length === 0 ? 'Add a project' : 'Nothing to do',
              href: '/projects',
            },
          };
        }
        return {
          ...base, rows,
          footnote: config?.privacy.allowRemoteAi
            ? 'Derived from your records by fixed rules. An AI provider can rephrase these but does not generate them.'
            : 'Derived from your records by fixed rules. No AI provider is involved.',
        };
      }

      default:
        return null;
    }
  }
}

export { monthlyMinor };
