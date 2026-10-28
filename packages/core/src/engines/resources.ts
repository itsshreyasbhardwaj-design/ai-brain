/**
 * Personal Resource Optimization Engine.
 *
 * Everything here is computed from records the user entered or a connector
 * observed. There is no imputation: when nothing has been recorded, the result
 * carries `hasData: false` and the UI says so rather than rendering a zero that
 * looks like a measurement.
 *
 * Two deliberate omissions, both from the brief:
 *   - elapsed time in an application is never treated as productive work, so
 *     only explicitly logged time counts;
 *   - nothing here can cancel a subscription or take any outward action. It
 *     reports, the user decides.
 */

import type { Id, Iso, Project, Resource, ResourceKind } from '../domain/types.ts';
import type { Store } from '../db/repositories.ts';
import type { TimeEntry } from '../db/repositories.ts';
import { isoDay, nowIso, daysBetween } from '../util/time.ts';
import { formatMoney, monthlyMinor } from './passport.ts';

export interface TimeReport {
  hasData: boolean;
  windowDays: number;
  totalMinutes: number;
  byProject: Array<{ projectId: Id | null; projectName: string; minutes: number; share: number }>;
  byKind: Record<TimeEntry['kind'], number>;
  /** Days with at least one logged focus block of 60+ minutes. */
  deepWorkDays: number;
  /** Days in the window with nothing logged at all. */
  daysWithoutLogs: number;
  /** Set when logged commitments exceed the window's working hours. */
  overcommitment: { committedMinutes: number; capacityMinutes: number; overBy: number } | null;
  notes: string[];
}

export interface CostReport {
  hasData: boolean;
  currency: string;
  monthlyRecurringMinor: number;
  yearlyRecurringMinor: number;
  oneOffMinor: number;
  byKind: Array<{ kind: ResourceKind; monthlyMinor: number; count: number }>;
  byProject: Array<{ projectId: Id | null; projectName: string; monthlyMinor: number }>;
  /** Items whose cost is unusually large relative to the rest. */
  anomalies: Array<{ resource: Resource; reason: string }>;
  /** Budgets the user set, compared against recorded spend. */
  budgets: Array<{ name: string; limitMinor: number; spentMinor: number; overBy: number }>;
  notes: string[];
}

export interface ToolInventory {
  hasData: boolean;
  tools: Array<{
    resource: Resource;
    monthlyMinor: number;
    /** Projects this tool is attached to. */
    attachedProjects: number;
    /** Days since the user last confirmed it is still in use. */
    daysSinceConfirmed: number | null;
    flags: string[];
  }>;
  /** Groups of tools that appear to do the same job. */
  possibleOverlaps: Array<{ group: string; names: string[] }>;
  unconfirmed: number;
  notes: string[];
}

export type AllocationVerdict =
  | 'advancing'
  | 'blocked'
  | 'needs-attention'
  | 'consuming-without-progress'
  | 'dormant'
  | 'worth-more-investment'
  | 'candidate-to-pause'
  | 'insufficient-data';

export interface AllocationRow {
  project: Project;
  verdict: AllocationVerdict;
  /** The rules that fired, in plain language. Shown instead of a score. */
  because: string[];
  loggedMinutes: number;
  monthlyCostMinor: number;
  activity30d: number;
  openTasks: number;
  blockedTasks: number;
  daysSinceActivity: number | null;
}

/** Working-hours assumption used only for the overcommitment warning. */
const DEFAULT_CAPACITY_MINUTES_PER_DAY = 6 * 60;

export class ResourceEngine {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  timeReport(workspaceId: Id, windowDays = 7): TimeReport {
    const from = isoDay(new Date(Date.now() - windowDays * 86_400_000));
    const entries = this.store.time.list(workspaceId, { fromDay: from });
    const notes: string[] = [];

    if (entries.length === 0) {
      notes.push('No time has been logged in this window, so no time analysis is possible.');
      return {
        hasData: false, windowDays, totalMinutes: 0, byProject: [],
        byKind: { focus: 0, meeting: 0, admin: 0, break: 0 },
        deepWorkDays: 0, daysWithoutLogs: windowDays, overcommitment: null, notes,
      };
    }

    const totalMinutes = entries.reduce((a, e) => a + e.minutes, 0);
    const byKind: Record<TimeEntry['kind'], number> = { focus: 0, meeting: 0, admin: 0, break: 0 };
    const projectTotals = new Map<string, number>();
    const perDayFocus = new Map<string, number>();
    const daysSeen = new Set<string>();

    for (const e of entries) {
      byKind[e.kind] += e.minutes;
      const key = e.projectId ?? '';
      projectTotals.set(key, (projectTotals.get(key) ?? 0) + e.minutes);
      daysSeen.add(e.occurredOn);
      if (e.kind === 'focus') perDayFocus.set(e.occurredOn, (perDayFocus.get(e.occurredOn) ?? 0) + e.minutes);
    }

    const byProject = [...projectTotals.entries()]
      .map(([pid, minutes]) => ({
        projectId: pid === '' ? null : pid,
        projectName: pid === '' ? 'Unassigned' : this.store.projects.byId(workspaceId, pid)?.name ?? 'Deleted project',
        minutes,
        share: Math.round((minutes / totalMinutes) * 100),
      }))
      .sort((a, b) => b.minutes - a.minutes);

    const deepWorkDays = [...perDayFocus.values()].filter((m) => m >= 60).length;

    // Overcommitment compares logged work against the window's capacity, and
    // against estimates on tasks still open and due inside the window.
    const capacityMinutes = windowDays * DEFAULT_CAPACITY_MINUTES_PER_DAY;
    const dueSoon = this.store.tasks
      .list(workspaceId, { status: ['todo', 'doing'] })
      .filter((t) => t.dueAt && daysBetween(nowIso(), t.dueAt) <= windowDays && t.estimateMinutes);
    const committedMinutes = totalMinutes + dueSoon.reduce((a, t) => a + (t.estimateMinutes ?? 0), 0);
    const overcommitment = committedMinutes > capacityMinutes
      ? { committedMinutes, capacityMinutes, overBy: committedMinutes - capacityMinutes }
      : null;

    if (overcommitment) {
      notes.push(
        `Logged time plus estimates on tasks due in the next ${windowDays} days comes to ` +
        `${(committedMinutes / 60).toFixed(1)} h against about ${(capacityMinutes / 60).toFixed(0)} h of capacity.`,
      );
    }
    if (byKind.break === 0) {
      notes.push('No recovery time is logged in this window. That is a gap in the record, not a judgement about your week.');
    }
    if (byProject.length > 5) {
      notes.push(`Time went to ${byProject.length} different projects in ${windowDays} days.`);
    }
    notes.push('Only explicitly logged time is counted. Time spent with an app open is not treated as work.');

    return {
      hasData: true, windowDays, totalMinutes, byProject, byKind, deepWorkDays,
      daysWithoutLogs: Math.max(0, windowDays - daysSeen.size), overcommitment, notes,
    };
  }

  costReport(workspaceId: Id): CostReport {
    const all = this.store.resources.list(workspaceId, { activeOnly: true });
    const costed = all.filter((r) => r.amountMinor !== null && r.kind !== 'budget');
    const budgetRows = all.filter((r) => r.kind === 'budget' && r.amountMinor !== null);
    const notes: string[] = [];

    if (costed.length === 0) {
      notes.push('No costs have been recorded. Add a subscription or an infrastructure cost to see this report.');
      return {
        hasData: false, currency: 'USD', monthlyRecurringMinor: 0, yearlyRecurringMinor: 0,
        oneOffMinor: 0, byKind: [], byProject: [], anomalies: [], budgets: [], notes,
      };
    }

    const currency = costed[0]!.currency;
    const mixedCurrency = new Set(costed.map((r) => r.currency)).size > 1;
    if (mixedCurrency) {
      notes.push('Costs are recorded in more than one currency. Totals below are summed without conversion, so treat them as approximate.');
    }

    const monthlyRecurringMinor = costed.reduce((a, r) => a + monthlyMinor(r.amountMinor!, r.period), 0);
    const oneOffMinor = costed.filter((r) => r.period === 'one-off' || r.period === null).reduce((a, r) => a + r.amountMinor!, 0);

    const kindMap = new Map<ResourceKind, { monthlyMinor: number; count: number }>();
    for (const r of costed) {
      const cur = kindMap.get(r.kind) ?? { monthlyMinor: 0, count: 0 };
      cur.monthlyMinor += monthlyMinor(r.amountMinor!, r.period);
      cur.count++;
      kindMap.set(r.kind, cur);
    }

    const projectMap = new Map<string, number>();
    for (const r of costed) {
      const key = r.projectId ?? '';
      projectMap.set(key, (projectMap.get(key) ?? 0) + monthlyMinor(r.amountMinor!, r.period));
    }

    // An anomaly is a recurring item more than three times the median. With
    // fewer than four items there is no meaningful baseline, so none is claimed.
    const recurring = costed.filter((r) => monthlyMinor(r.amountMinor!, r.period) > 0);
    const anomalies: Array<{ resource: Resource; reason: string }> = [];
    if (recurring.length >= 4) {
      const values = recurring.map((r) => monthlyMinor(r.amountMinor!, r.period)).sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)]!;
      for (const r of recurring) {
        const m = monthlyMinor(r.amountMinor!, r.period);
        if (median > 0 && m > median * 3) {
          anomalies.push({ resource: r, reason: `${formatMoney(m, r.currency)}/month is more than 3× the median recurring cost of ${formatMoney(median, currency)}` });
        }
      }
    } else {
      notes.push('Fewer than four recurring costs are recorded, so no cost anomalies are reported yet.');
    }

    const budgets = budgetRows.map((b) => {
      const scope = b.projectId
        ? costed.filter((r) => r.projectId === b.projectId)
        : costed;
      const spentMinor = scope.reduce((a, r) => a + monthlyMinor(r.amountMinor!, r.period), 0);
      return {
        name: b.name, limitMinor: b.amountMinor!, spentMinor,
        overBy: Math.max(0, spentMinor - b.amountMinor!),
      };
    });

    notes.push('Every figure here comes from a cost you recorded. Nothing is estimated or inferred from usage.');

    return {
      hasData: true, currency, monthlyRecurringMinor,
      yearlyRecurringMinor: monthlyRecurringMinor * 12, oneOffMinor,
      byKind: [...kindMap.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.monthlyMinor - a.monthlyMinor),
      byProject: [...projectMap.entries()]
        .map(([pid, m]) => ({
          projectId: pid === '' ? null : pid,
          projectName: pid === '' ? 'Not attached to a project' : this.store.projects.byId(workspaceId, pid)?.name ?? 'Deleted project',
          monthlyMinor: m,
        }))
        .sort((a, b) => b.monthlyMinor - a.monthlyMinor),
      anomalies, budgets, notes,
    };
  }

  toolInventory(workspaceId: Id): ToolInventory {
    const tools = this.store.resources.list(workspaceId, { kind: ['tool', 'subscription', 'ai-api', 'infrastructure'] });
    const notes: string[] = [];
    if (tools.length === 0) {
      notes.push('No tools or subscriptions are recorded yet.');
      return { hasData: false, tools: [], possibleOverlaps: [], unconfirmed: 0, notes };
    }

    const projectCounts = new Map<string, number>();
    for (const t of tools) {
      if (t.projectId) projectCounts.set(t.projectId, (projectCounts.get(t.projectId) ?? 0) + 1);
    }

    const rows = tools.map((resource) => {
      const flags: string[] = [];
      const daysSinceConfirmed = resource.lastConfirmedAt ? daysBetween(resource.lastConfirmedAt, nowIso()) : null;
      if (daysSinceConfirmed === null) flags.push('never confirmed as still in use');
      else if (daysSinceConfirmed > 180) flags.push(`not confirmed for ${daysSinceConfirmed} days`);
      if (resource.projectId === null) flags.push('not attached to any project');
      if (resource.amountMinor === null) flags.push('no cost recorded');
      if (resource.projectId) {
        const p = this.store.projects.byId(workspaceId, resource.projectId);
        if (p?.archivedAt) flags.push('attached to an archived project');
        else if (p && p.lastActivityAt && daysBetween(p.lastActivityAt, nowIso()) > 90) {
          flags.push('attached to a project with no activity for 90+ days');
        }
      }
      return {
        resource,
        monthlyMinor: resource.amountMinor !== null ? monthlyMinor(resource.amountMinor, resource.period) : 0,
        attachedProjects: resource.projectId ? 1 : 0,
        daysSinceConfirmed,
        flags,
      };
    }).sort((a, b) => b.monthlyMinor - a.monthlyMinor);

    // Overlap detection is keyword-based and offered as a question, not a claim.
    const groups: Record<string, RegExp> = {
      'Note-taking': /\b(notion|obsidian|evernote|bear|roam|logseq|craft|apple notes|onenote)\b/i,
      'Design': /\b(figma|sketch|adobe|canva|framer|affinity)\b/i,
      'Project management': /\b(jira|linear|asana|trello|clickup|monday|basecamp|shortcut)\b/i,
      'Hosting': /\b(vercel|netlify|heroku|render|railway|fly\.io|aws|gcp|azure|digitalocean)\b/i,
      'AI provider': /\b(openai|anthropic|claude|gemini|mistral|groq|together|replicate)\b/i,
      'Storage': /\b(dropbox|google drive|icloud|onedrive|box|backblaze)\b/i,
      'Email': /\b(mailchimp|sendgrid|postmark|resend|convertkit|beehiiv|substack)\b/i,
    };
    const possibleOverlaps: Array<{ group: string; names: string[] }> = [];
    for (const [group, re] of Object.entries(groups)) {
      const names = tools.filter((t) => re.test(t.name)).map((t) => t.name);
      if (names.length > 1) possibleOverlaps.push({ group, names });
    }

    const unconfirmed = rows.filter((r) => r.daysSinceConfirmed === null || r.daysSinceConfirmed > 180).length;
    if (possibleOverlaps.length > 0) {
      notes.push('Overlaps below are matched on tool names. They are a question worth asking, not a confirmed duplication.');
    }
    notes.push('This inventory cannot cancel anything. Any change has to be made with the provider directly.');

    return { hasData: true, tools: rows, possibleOverlaps, unconfirmed, notes };
  }

  /**
   * Project allocation intelligence.
   *
   * Returns a verdict per project with the rules that produced it, so the user
   * can disagree with the reasoning rather than with an opaque number.
   */
  allocation(workspaceId: Id): AllocationRow[] {
    const projects = this.store.projects.list(workspaceId, { limit: 500 });
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const fromDay = isoDay(new Date(Date.now() - 30 * 86_400_000));
    const now = nowIso();

    return projects.map((project): AllocationRow => {
      const because: string[] = [];
      const activity30d = this.store.activity.recent(workspaceId, { projectId: project.id, since, limit: 500 }).length;
      const loggedMinutes = this.store.time
        .list(workspaceId, { projectId: project.id, fromDay })
        .reduce((a, e) => a + e.minutes, 0);
      const costs = this.store.resources.list(workspaceId, { projectId: project.id, activeOnly: true });
      const monthlyCostMinor = costs
        .filter((r) => r.amountMinor !== null)
        .reduce((a, r) => a + monthlyMinor(r.amountMinor!, r.period), 0);
      const open = this.store.tasks.list(workspaceId, { projectId: project.id, status: ['todo', 'doing'] });
      const blocked = this.store.tasks.list(workspaceId, { projectId: project.id, status: ['blocked'] });
      const daysSinceActivity = project.lastActivityAt ? daysBetween(project.lastActivityAt, now) : null;
      const completed30d = this.store.tasks.completedBetween(workspaceId, since, now).filter((t) => t.projectId === project.id).length;

      let verdict: AllocationVerdict;

      if (project.archivedAt) {
        verdict = 'dormant';
        because.push('the project is archived');
      } else if (blocked.length > 0 || project.lifecycle === 'blocked') {
        verdict = 'blocked';
        because.push(blocked.length > 0 ? `${blocked.length} task(s) are marked blocked` : 'the project lifecycle is set to blocked');
      } else if (activity30d === 0 && loggedMinutes === 0 && completed30d === 0 && monthlyCostMinor > 0) {
        verdict = 'consuming-without-progress';
        because.push(`${formatMoney(monthlyCostMinor, costs[0]?.currency ?? 'USD')}/month is recorded against it`);
        because.push('no activity, logged time or completed task in the last 30 days');
      } else if (activity30d === 0 && loggedMinutes === 0 && completed30d === 0) {
        if (daysSinceActivity === null && project.createdAt > since) {
          verdict = 'insufficient-data';
          because.push('created recently with nothing recorded against it yet');
        } else {
          verdict = 'candidate-to-pause';
          because.push(daysSinceActivity === null ? 'nothing has ever been recorded against it' : `nothing recorded for ${daysSinceActivity} days`);
          if (project.lifecycle === 'active') because.push('but it is still marked active');
        }
      } else if (open.some((t) => t.dueAt && t.dueAt < now)) {
        verdict = 'needs-attention';
        because.push('it has overdue tasks');
      } else if (activity30d + completed30d >= 10 || loggedMinutes >= 600) {
        verdict = 'advancing';
        because.push(`${activity30d} activity event(s) and ${completed30d} completed task(s) in 30 days`);
        if (loggedMinutes > 0) because.push(`${(loggedMinutes / 60).toFixed(1)} h logged`);
        if (monthlyCostMinor === 0 && open.length > 5) {
          verdict = 'worth-more-investment';
          because.push('it is moving with no recorded cost and a healthy backlog');
        }
      } else {
        verdict = 'advancing';
        because.push(`${activity30d} activity event(s) and ${completed30d} completed task(s) in 30 days`);
      }

      return {
        project, verdict, because, loggedMinutes, monthlyCostMinor,
        activity30d, openTasks: open.length, blockedTasks: blocked.length, daysSinceActivity,
      };
    }).sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]);
  }

  /** Headline numbers for the dashboard's resource widget. */
  summary(workspaceId: Id): {
    monthlyCostMinor: number;
    currency: string;
    weeklyMinutes: number;
    toolCount: number;
    unconfirmedTools: number;
    hasAnyData: boolean;
  } {
    const cost = this.costReport(workspaceId);
    const time = this.timeReport(workspaceId, 7);
    const tools = this.toolInventory(workspaceId);
    return {
      monthlyCostMinor: cost.monthlyRecurringMinor,
      currency: cost.currency,
      weeklyMinutes: time.totalMinutes,
      toolCount: tools.hasData ? tools.tools.length : 0,
      unconfirmedTools: tools.unconfirmed,
      hasAnyData: cost.hasData || time.hasData || tools.hasData,
    };
  }
}

const VERDICT_ORDER: Record<AllocationVerdict, number> = {
  blocked: 0,
  'needs-attention': 1,
  'consuming-without-progress': 2,
  'candidate-to-pause': 3,
  advancing: 4,
  'worth-more-investment': 5,
  'insufficient-data': 6,
  dormant: 7,
};

export const VERDICT_LABELS: Record<AllocationVerdict, string> = {
  advancing: 'Advancing',
  blocked: 'Blocked',
  'needs-attention': 'Needs attention',
  'consuming-without-progress': 'Consuming resources without progress',
  dormant: 'Dormant',
  'worth-more-investment': 'Worth more investment',
  'candidate-to-pause': 'Candidate to pause or archive',
  'insufficient-data': 'Not enough data yet',
};

export type { Iso };
