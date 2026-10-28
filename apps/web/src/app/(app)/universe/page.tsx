import { requireContext, engines } from '@/lib/server';
import { Universe, type UniverseData, type UniverseNode, type UniverseEdge } from '@/components/universe';
import { relativeLabel, daysBetween, nowIso } from '@ai-brain/core';

export const metadata = { title: 'Universe' };

/**
 * The 3D Personal Intelligence Universe.
 *
 * The graph is assembled here, on the server, from real records only. Domains
 * come from project categories, edges come from stored relationships plus
 * explicit containment, and node weight comes from recorded activity. Nothing
 * is connected to make the picture look fuller.
 */
export default async function UniversePage() {
  const ctx = await requireContext();
  const projects = ctx.store.projects.list(ctx.workspace.id, {
    reviewState: ['confirmed', 'pending-review'],
    limit: 500,
    includeArchived: false,
  });
  const relationships = ctx.store.relationships.list(ctx.workspace.id);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const nodes: UniverseNode[] = [{
    id: 'core',
    label: ctx.config?.displayName ?? ctx.workspace.name,
    kind: 'core',
    domain: 'core',
    weight: 1,
    lifecycle: 'active',
    unconfirmed: false,
    detail: [],
  }];
  const edges: UniverseEdge[] = [];

  const domains = [...new Set(projects.map((p) => p.category))].sort();
  for (const domain of domains) {
    nodes.push({
      id: `domain:${domain}`,
      label: domain,
      kind: 'domain',
      domain,
      weight: 0.5,
      lifecycle: 'active',
      unconfirmed: false,
      detail: [`${projects.filter((p) => p.category === domain).length} project(s)`],
    });
    edges.push({ from: 'core', to: `domain:${domain}`, kind: 'contains', certain: true });
  }

  // Weight is recorded activity, normalised across the workspace so the
  // busiest project is the largest rather than an arbitrary absolute scale.
  const activityCounts = new Map<string, number>();
  let maxActivity = 1;
  for (const p of projects) {
    const n = ctx.store.activity.recent(ctx.workspace.id, { projectId: p.id, since, limit: 500 }).length;
    activityCounts.set(p.id, n);
    if (n > maxActivity) maxActivity = n;
  }

  for (const p of projects) {
    const activity = activityCounts.get(p.id) ?? 0;
    const openTasks = ctx.store.tasks.list(ctx.workspace.id, { projectId: p.id, status: ['todo', 'doing', 'blocked'] }).length;
    const knowledge = ctx.store.knowledge.list(ctx.workspace.id, { projectId: p.id, limit: 1000 }).length;

    nodes.push({
      id: p.id,
      label: p.name,
      kind: 'project',
      domain: p.category,
      weight: activity / maxActivity,
      lifecycle: p.lifecycle,
      unconfirmed: p.reviewState === 'pending-review',
      href: `/projects/${p.slug}`,
      detail: [
        p.description || 'no description recorded',
        `${activity} activity event(s) in 30 days`,
        `${openTasks} open task(s) · ${knowledge} knowledge record(s)`,
        `last activity ${relativeLabel(p.lastActivityAt)}`,
        ...(p.lastActivityAt && daysBetween(p.lastActivityAt, nowIso()) > 60 ? ['quiet for over 60 days'] : []),
      ],
    });
    // Containment: a project belongs to its category.
    edges.push({ from: `domain:${p.category}`, to: p.id, kind: 'contains', certain: true });
  }

  const known = new Set(nodes.map((n) => n.id));
  for (const rel of relationships) {
    if (!known.has(rel.fromProjectId) || !known.has(rel.toProjectId)) continue;
    edges.push({
      from: rel.fromProjectId,
      to: rel.toProjectId,
      kind: rel.kind,
      // Only an observed relationship is drawn as solid.
      certain: rel.confidence === 'observed',
    });
  }

  const data: UniverseData = {
    nodes,
    edges,
    generatedAt: nowIso(),
    emptyReason: 'You have no projects yet, so there is nothing to place.',
  };

  return (
    <div>
      <header className="mb-5">
        <h1 className="display-sm">Universe</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Your {projects.length} project(s) across {domains.length} domain(s), with the relationships that
          are actually recorded. Nothing here is connected for visual effect.
        </p>
      </header>
      <Universe data={data} />
    </div>
  );
}
