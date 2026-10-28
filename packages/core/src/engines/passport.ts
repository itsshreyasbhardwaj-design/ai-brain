/**
 * Project Passports.
 *
 * A passport is assembled from stored records at read time, never cached as
 * prose. Sections are chosen by project category, so a client engagement does
 * not carry an empty "CI" block and a library does not carry "Invoices".
 *
 * Two rules hold everywhere in this file:
 *   - a section with no backing records renders as empty, never as a zero or a
 *     plausible-looking guess;
 *   - every section reports where its content came from and when that was last
 *     confirmed, which is what the UI shows next to the heading.
 */

import type {
  Id, PassportRow, PassportSection, PassportSectionKey, Project, ProjectCategory,
  ProjectPassport, SourceRef, Origin, Confidence,
} from '../domain/types.ts';
import type { Store } from '../db/repositories.ts';
import { nowIso, relativeLabel } from '../util/time.ts';

/** Which sections each category gets, in display order. */
const SECTIONS_BY_CATEGORY: Record<ProjectCategory, PassportSectionKey[]> = {
  software: ['identity', 'objectives', 'activity', 'repositories', 'ci', 'dependencies', 'deployments', 'decisions', 'documents', 'resources', 'risks', 'history', 'recommendations'],
  product: ['identity', 'objectives', 'activity', 'performance', 'decisions', 'documents', 'resources', 'risks', 'history', 'recommendations'],
  business: ['identity', 'objectives', 'activity', 'financials', 'performance', 'decisions', 'documents', 'resources', 'risks', 'history', 'recommendations'],
  client: ['identity', 'objectives', 'activity', 'financials', 'documents', 'resources', 'decisions', 'risks', 'history', 'recommendations'],
  content: ['identity', 'objectives', 'activity', 'performance', 'documents', 'resources', 'risks', 'history', 'recommendations'],
  research: ['identity', 'objectives', 'activity', 'documents', 'decisions', 'performance', 'risks', 'history', 'recommendations'],
  personal: ['identity', 'objectives', 'activity', 'documents', 'decisions', 'resources', 'risks', 'history', 'recommendations'],
  study: ['identity', 'objectives', 'activity', 'documents', 'risks', 'history', 'recommendations'],
  other: ['identity', 'objectives', 'activity', 'documents', 'decisions', 'resources', 'risks', 'history', 'recommendations'],
};

const SECTION_TITLES: Record<PassportSectionKey, string> = {
  identity: 'Identity',
  objectives: 'Objectives',
  activity: 'Activity',
  resources: 'Resources',
  documents: 'Documents',
  decisions: 'Decisions',
  performance: 'Performance',
  risks: 'Risks',
  history: 'History',
  recommendations: 'Recommendations',
  repositories: 'Repositories',
  architecture: 'Architecture',
  dependencies: 'Dependencies',
  ci: 'Continuous integration',
  tests: 'Tests',
  security: 'Security',
  deployments: 'Deployments',
  financials: 'Financials',
};

export class PassportEngine {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  build(workspaceId: Id, projectId: Id): ProjectPassport | null {
    const project = this.store.projects.byId(workspaceId, projectId);
    if (!project) return null;

    const keys = SECTIONS_BY_CATEGORY[project.category] ?? SECTIONS_BY_CATEGORY.other;
    const sections = keys.map((k) => this.section(workspaceId, project, k));

    // Completeness counts only sections that something has actually populated.
    const populated = sections.filter((s) => s.rows.length > 0).length;
    return {
      projectId,
      project,
      sections,
      completeness: sections.length === 0 ? 0 : Math.round((populated / sections.length) * 100),
      generatedAt: nowIso(),
    };
  }

  private section(workspaceId: Id, project: Project, key: PassportSectionKey): PassportSection {
    const build = (
      rows: PassportRow[],
      origin: Origin,
      confidence: Confidence,
      refs: SourceRef[],
      lastVerifiedAt: string | null,
    ): PassportSection => ({
      key, title: SECTION_TITLES[key], rows, origin, confidence, lastVerifiedAt, sourceRefs: refs,
    });

    switch (key) {
      case 'identity': {
        const rows: PassportRow[] = [
          { label: 'Name', value: project.name },
          { label: 'Category', value: project.category },
          { label: 'Lifecycle', value: project.lifecycle },
          { label: 'Created', value: project.createdAt.slice(0, 10) },
          { label: 'Discovered via', value: project.origin === 'connector' ? (project.sourceKey?.split(':')[0] ?? 'connector') : project.origin },
        ];
        if (project.description) rows.splice(1, 0, { label: 'Description', value: project.description });
        if (project.aliases.length) rows.push({ label: 'Also known as', value: project.aliases.join(', ') });
        if (project.tags.length) rows.push({ label: 'Tags', value: project.tags.join(', ') });
        if (project.reviewState === 'pending-review') {
          rows.push({ label: 'Status', value: `awaiting your review (confidence ${project.matchScore.toFixed(2)})`, uncertain: true });
        }
        const parent = project.parentProjectId ? this.store.projects.byId(workspaceId, project.parentProjectId) : null;
        if (parent) rows.push({ label: 'Part of', value: parent.name, href: `/projects/${parent.slug}` });

        const rels = this.store.relationships.forProject(workspaceId, project.id);
        for (const r of rels.slice(0, 8)) {
          const otherId = r.fromProjectId === project.id ? r.toProjectId : r.fromProjectId;
          const other = this.store.projects.byId(workspaceId, otherId);
          if (other) rows.push({ label: r.kind.replace(/-/g, ' '), value: other.name, href: `/projects/${other.slug}`, uncertain: r.confidence !== 'observed' });
        }
        return build(rows, project.origin, project.confidence, this.refsFor(workspaceId, project), project.updatedAt);
      }

      case 'objectives': {
        const goals = this.store.goals.list(workspaceId).filter((g) => g.projectId === project.id);
        const rows = goals.map((g): PassportRow => ({
          label: g.title,
          value: `${g.status} · ${g.progress}% · ${g.horizon}${g.targetDate ? ` · due ${g.targetDate.slice(0, 10)}` : ''}`,
          uncertain: g.progressOrigin === 'generated',
        }));
        return build(rows, 'manual', 'observed', [], goals[0]?.updatedAt ?? null);
      }

      case 'activity': {
        const events = this.store.activity.recent(workspaceId, { projectId: project.id, limit: 15 });
        const rows = events.map((e): PassportRow => ({
          label: e.occurredAt.slice(0, 10),
          value: e.summary,
          ...(e.url ? { href: e.url } : {}),
        }));
        const refs: SourceRef[] = events
          .filter((e) => e.sourceId)
          .slice(0, 5)
          .map((e) => ({ connector: e.connector, locator: e.kind, ...(e.url ? { url: e.url } : {}), observedAt: e.occurredAt }));
        return build(rows, events.some((e) => e.connector !== 'manual') ? 'connector' : 'manual', 'observed', refs, events[0]?.occurredAt ?? null);
      }

      case 'resources': {
        const res = this.store.resources.list(workspaceId, { projectId: project.id });
        const time = this.store.time.list(workspaceId, { projectId: project.id });
        const rows = res.map((r): PassportRow => ({
          label: `${r.kind}: ${r.name}`,
          value: r.amountMinor !== null ? `${formatMoney(r.amountMinor, r.currency)}${r.period ? ` / ${r.period}` : ''}` : r.minutes !== null ? `${r.minutes} min` : r.notes || '—',
        }));
        if (time.length > 0) {
          const total = time.reduce((a, t) => a + t.minutes, 0);
          rows.unshift({ label: 'Time logged', value: `${(total / 60).toFixed(1)} h across ${time.length} entries` });
        }
        return build(rows, 'manual', 'observed', [], res[0]?.updatedAt ?? null);
      }

      case 'documents': {
        const docs = this.store.knowledge.list(workspaceId, { projectId: project.id, limit: 20 });
        const rows = docs.map((k): PassportRow => ({
          label: k.klass,
          value: k.title,
          href: `/knowledge/${k.id}`,
          uncertain: k.origin === 'generated' || k.contradictsId !== null,
        }));
        return build(rows, docs.some((d) => d.origin === 'import') ? 'import' : 'manual', 'observed', [], docs[0]?.observedAt ?? null);
      }

      case 'decisions': {
        const decs = this.store.decisions.list(workspaceId, { projectId: project.id, limit: 20 });
        const rows = decs.map((d): PassportRow => ({
          label: d.decidedAt.slice(0, 10),
          value: `${d.title}${d.status === 'superseded' ? ' (superseded)' : d.status === 'reversed' ? ' (reversed)' : ''}`,
          href: `/decisions/${d.id}`,
        }));
        return build(rows, 'manual', 'observed', [], decs[0]?.decidedAt ?? null);
      }

      case 'performance':
      case 'financials': {
        const wanted = key === 'financials'
          ? (k: string) => /cost|revenue|invoice|spend|budget|margin|mrr|arr/i.test(k)
          : (k: string) => !/cost|revenue|invoice|spend|budget|margin|mrr|arr/i.test(k);
        const metrics = this.store.metrics.latest(workspaceId, project.id).filter((m) => wanted(m.key));
        const rows = metrics.map((m): PassportRow => ({
          label: m.label || m.key,
          value: `${m.value}${m.unit ? ` ${m.unit}` : ''}${m.target !== null ? ` (target ${m.target})` : ''} · ${relativeLabel(m.observedAt)}`,
          uncertain: m.origin === 'generated',
        }));
        if (key === 'financials') {
          const costs = this.store.resources.list(workspaceId, { projectId: project.id, activeOnly: true })
            .filter((r) => r.amountMinor !== null);
          const monthly = costs.reduce((a, r) => a + monthlyMinor(r.amountMinor!, r.period), 0);
          if (costs.length > 0) {
            rows.unshift({ label: 'Recorded recurring cost', value: `${formatMoney(monthly, costs[0]!.currency)} / month across ${costs.length} items` });
          }
        }
        const refs = metrics.filter((m) => m.sourceId).slice(0, 5).map((m): SourceRef => ({
          connector: 'manual', locator: m.key, observedAt: m.observedAt,
        }));
        return build(rows, metrics.some((m) => m.origin === 'connector') ? 'connector' : 'manual', 'observed', refs, metrics[0]?.observedAt ?? null);
      }

      case 'risks': {
        const rows: PassportRow[] = [];
        const blocked = this.store.tasks.list(workspaceId, { projectId: project.id, status: ['blocked'] });
        for (const t of blocked) rows.push({ label: 'Blocked task', value: t.title });
        const overdue = this.store.tasks
          .list(workspaceId, { projectId: project.id, status: ['todo', 'doing'] })
          .filter((t) => t.dueAt && t.dueAt < nowIso());
        for (const t of overdue.slice(0, 10)) rows.push({ label: 'Overdue', value: `${t.title} (due ${t.dueAt!.slice(0, 10)})` });
        const atRisk = this.store.goals.list(workspaceId).filter((g) => g.projectId === project.id && g.status === 'at-risk');
        for (const g of atRisk) rows.push({ label: 'Goal at risk', value: g.title });
        if (project.lifecycle === 'blocked') rows.unshift({ label: 'Lifecycle', value: 'This project is marked as blocked.' });
        const contradictions = this.store.knowledge.list(workspaceId, { projectId: project.id, limit: 100 })
          .filter((k) => k.contradictsId !== null);
        for (const k of contradictions.slice(0, 5)) {
          rows.push({ label: 'Conflicting knowledge', value: k.title, href: `/knowledge/${k.id}`, uncertain: true });
        }
        return build(rows, 'derived', 'observed', [], rows.length ? nowIso() : null);
      }

      case 'history': {
        const evid = this.store.evidence.forSubject(workspaceId, `project:${project.id}`);
        const rows = evid.slice(0, 20).map((e): PassportRow => ({
          label: e.observedAt.slice(0, 10),
          value: e.claim,
          uncertain: e.confidence === 'low' || e.confidence === 'unverified',
        }));
        return build(rows, 'derived', 'observed', [], evid[0]?.observedAt ?? null);
      }

      case 'recommendations': {
        const rows = recommendFor(this.store, workspaceId, project).map((r): PassportRow => ({
          label: r.priority, value: `${r.action} — ${r.because}`,
        }));
        // Derived from stored records by fixed rules, so it is reproducible and
        // needs no model. Marked 'derived', never 'generated'.
        return build(rows, 'derived', 'high', [], rows.length ? nowIso() : null);
      }

      case 'repositories': {
        const repos = this.store.sources.list(workspaceId, { connector: 'github', kind: 'repository', limit: 200 })
          .filter((s) => s.id === project.sourceId || project.sourceKey === `github:${s.externalId}`);
        const rows = repos.map((s): PassportRow => ({
          label: String((s.payload as { full_name?: string }).full_name ?? s.locator),
          value: [
            (s.payload as { language?: string }).language,
            (s.payload as { default_branch?: string }).default_branch,
            (s.payload as { private?: boolean }).private ? 'private' : 'public',
          ].filter(Boolean).join(' · ') || s.locator,
          ...(s.url ? { href: s.url } : {}),
        }));
        const refs = repos.map((s): SourceRef => ({ connector: 'github', locator: s.locator, ...(s.url ? { url: s.url } : {}), observedAt: s.observedAt }));
        return build(rows, 'connector', 'observed', refs, repos[0]?.observedAt ?? null);
      }

      case 'ci':
      case 'tests':
      case 'dependencies':
      case 'security':
      case 'deployments':
      case 'architecture': {
        // These are populated from metrics a connector recorded under a known
        // key. Nothing is inferred: if the connector never reported it, the
        // section stays empty and the UI says which connector would fill it.
        const prefixes: Record<string, RegExp> = {
          ci: /^ci_/, tests: /^test/, dependencies: /^dep/, security: /^(security|vuln)/,
          deployments: /^deploy/, architecture: /^arch/,
        };
        const re = prefixes[key]!;
        const metrics = this.store.metrics.latest(workspaceId, project.id).filter((m) => re.test(m.key));
        const rows = metrics.map((m): PassportRow => ({
          label: m.label || m.key,
          value: `${m.value}${m.unit ? ` ${m.unit}` : ''} · ${relativeLabel(m.observedAt)}`,
          uncertain: m.origin === 'generated',
        }));
        return build(rows, 'connector', 'observed', [], metrics[0]?.observedAt ?? null);
      }

      default:
        return build([], 'derived', 'unverified', [], null);
    }
  }

  private refsFor(workspaceId: Id, project: Project): SourceRef[] {
    if (!project.sourceId) return [];
    const src = this.store.sources.byId(workspaceId, project.sourceId);
    if (!src) return [];
    return [{ connector: src.connector, locator: src.locator, ...(src.url ? { url: src.url } : {}), observedAt: src.observedAt }];
  }
}

export interface Recommendation {
  priority: 'now' | 'soon' | 'later';
  action: string;
  because: string;
}

/**
 * Evidence-backed next actions.
 *
 * Deliberately a set of transparent rules rather than a score: the brief asks
 * for frameworks the user can audit, not a number they have to trust.
 */
export function recommendFor(store: Store, workspaceId: Id, project: Project): Recommendation[] {
  const out: Recommendation[] = [];
  const now = nowIso();

  if (project.reviewState === 'pending-review') {
    out.push({ priority: 'now', action: 'Confirm or reject this discovered project', because: `it was found automatically with confidence ${project.matchScore.toFixed(2)} and has not been reviewed` });
  }

  const blocked = store.tasks.list(workspaceId, { projectId: project.id, status: ['blocked'] });
  if (blocked.length > 0) {
    out.push({ priority: 'now', action: `Unblock "${blocked[0]!.title}"`, because: `${blocked.length} task${blocked.length > 1 ? 's are' : ' is'} marked blocked` });
  }

  const overdue = store.tasks
    .list(workspaceId, { projectId: project.id, status: ['todo', 'doing'] })
    .filter((t) => t.dueAt && t.dueAt < now);
  if (overdue.length > 0) {
    out.push({ priority: 'now', action: `Reschedule or finish ${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}`, because: `the earliest was due ${overdue[0]!.dueAt!.slice(0, 10)}` });
  }

  const staleDays = project.lastActivityAt
    ? Math.round((Date.now() - new Date(project.lastActivityAt).getTime()) / 86_400_000)
    : null;
  if (project.lifecycle === 'active' && staleDays !== null && staleDays > 30) {
    out.push({ priority: 'soon', action: 'Pause, archive or restart this project', because: `it is marked active but nothing has happened for ${staleDays} days` });
  }
  if (project.lifecycle === 'active' && staleDays === null) {
    out.push({ priority: 'later', action: 'Record what is happening here', because: 'no activity has ever been recorded for this project' });
  }

  const goals = store.goals.list(workspaceId).filter((g) => g.projectId === project.id);
  if (goals.length === 0) {
    out.push({ priority: 'soon', action: 'Give this project a goal', because: 'it has no objective recorded, so progress cannot be judged' });
  }

  const costs = store.resources.list(workspaceId, { projectId: project.id, activeOnly: true }).filter((r) => r.amountMinor !== null);
  const monthly = costs.reduce((a, r) => a + monthlyMinor(r.amountMinor!, r.period), 0);
  if (monthly > 0 && staleDays !== null && staleDays > 60) {
    out.push({ priority: 'now', action: `Review ${formatMoney(monthly, costs[0]!.currency)}/month of recorded cost`, because: `this project still has recurring costs but has been inactive for ${staleDays} days` });
  }

  if (store.knowledge.list(workspaceId, { projectId: project.id, limit: 1 }).length === 0) {
    out.push({ priority: 'later', action: 'Write down one thing you know about this project', because: 'it has no knowledge records, so there is no context for an assistant to use' });
  }

  const order = { now: 0, soon: 1, later: 2 };
  return out.sort((a, b) => order[a.priority] - order[b.priority]).slice(0, 8);
}

export function monthlyMinor(amountMinor: number, period: 'one-off' | 'monthly' | 'yearly' | null): number {
  if (period === 'monthly') return amountMinor;
  if (period === 'yearly') return Math.round(amountMinor / 12);
  return 0; // one-off and unknown periods are not recurring spend
}

export function formatMoney(minor: number, currency = 'USD'): string {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: major % 1 === 0 ? 0 : 2 }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}
