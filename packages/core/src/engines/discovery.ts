/**
 * Universal Project Intelligence Engine.
 *
 * Connectors do not create projects. They emit `ProjectCandidate`s, and this
 * engine decides what each one means: whether it is already known, whether it
 * is a rename, a fork, a monorepo member or a genuinely new project, and
 * whether it is certain enough to register without asking.
 *
 * The matching rules are ordered by how much they can be trusted:
 *   1. stable provider identifier  — decisive
 *   2. a previously recorded alias — decisive
 *   3. identical normalised name   — strong, but still scored
 *   4. name similarity alone       — never decisive on its own
 *
 * Rule 4 existing at all is why every candidate carries a score and why
 * anything below the auto-register threshold lands in a review queue instead of
 * silently merging two unrelated projects.
 */

import type {
  ConnectorKey, Confidence, Id, Iso, Lifecycle, Project, ProjectCategory, RelationshipKind,
} from '../domain/types.ts';
import type { Store } from '../db/repositories.ts';
import { slugify } from '../util/id.ts';
import { nowIso } from '../util/time.ts';

/** What a connector reports about one thing that might be a project. */
export interface ProjectCandidate {
  connector: ConnectorKey;
  /** Stable upstream id, e.g. a GitHub repository node id. Never a name. */
  externalId: string;
  name: string;
  description?: string;
  /** Prior names, e.g. from a repository rename event. */
  aliases?: string[];
  category?: ProjectCategory;
  lifecycle?: Lifecycle;
  tags?: string[];
  url?: string;
  locator: string;
  /**
   * The source record this candidate came from, once it has been written.
   * Connectors leave this null: they do not know the row id, and the sync
   * runner fills it in. A missing id must never become a dangling reference.
   */
  sourceId: Id | null;
  lastActivityAt?: Iso | null;
  /** Set when the connector knows this belongs to a larger project. */
  parentExternalId?: string;
  /** Set when the connector knows this is a fork or deployment of something. */
  relatedExternalIds?: Array<{ externalId: string; kind: RelationshipKind }>;
  /** Connector-level certainty, 0-1. Folded into the final score. */
  connectorConfidence?: number;
}

export type DiscoveryOutcome =
  | 'created'
  | 'updated'
  | 'queued-for-review'
  | 'unchanged'
  | 'skipped-rejected';

export interface DiscoveryResult {
  outcome: DiscoveryOutcome;
  project: Project | null;
  score: number;
  /** Which rule decided the outcome. Surfaced in the review queue UI. */
  reason: string;
  matchedExisting: Project | null;
}

export interface DiscoveryOptions {
  /** 'automatic' registers high-confidence candidates; 'review' queues them. */
  automationLevel: 'manual' | 'review' | 'automatic';
  /** Score at or above which a new project may auto-register. */
  autoRegisterThreshold?: number;
  /** Score at or above which an existing project is treated as the same thing. */
  mergeThreshold?: number;
}

export const DEFAULT_AUTO_REGISTER_THRESHOLD = 0.75;
export const DEFAULT_MERGE_THRESHOLD = 0.8;

/** Stable key for a candidate: what makes it the *same thing* across syncs. */
export function sourceKeyFor(connector: ConnectorKey, externalId: string): string {
  return `${connector}:${externalId}`;
}

export class DiscoveryEngine {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Runs one candidate through the pipeline. Idempotent for unchanged input. */
  ingest(workspaceId: Id, candidate: ProjectCandidate, opts: DiscoveryOptions): DiscoveryResult {
    const sourceKey = sourceKeyFor(candidate.connector, candidate.externalId);
    // Normalise once, here, so no code path downstream can write an empty
    // string into a foreign key column.
    const sourceId = candidate.sourceId && candidate.sourceId !== '' ? candidate.sourceId : null;

    // 1. Stable identifier: decisive. This is what makes re-syncs idempotent
    //    and what makes a rename an update rather than a duplicate.
    const bySource = this.store.projects.bySourceKey(workspaceId, sourceKey);
    if (bySource) {
      if (bySource.reviewState === 'rejected') {
        return { outcome: 'skipped-rejected', project: bySource, score: 1, reason: 'previously rejected by the user', matchedExisting: bySource };
      }
      const updated = this.applyUpdate(workspaceId, bySource, candidate);
      return {
        outcome: updated.changed ? 'updated' : 'unchanged',
        project: updated.project,
        score: 1,
        reason: 'matched on stable provider identifier',
        matchedExisting: bySource,
      };
    }

    // 2-4. No stable match: score every plausible existing project.
    const scored = this.scoreCandidates(workspaceId, candidate);
    const best = scored[0];
    const mergeThreshold = opts.mergeThreshold ?? DEFAULT_MERGE_THRESHOLD;

    if (best && best.score >= mergeThreshold) {
      // Same project, newly seen through this connector: adopt the source key
      // rather than creating a second record for it.
      if (best.project.reviewState === 'rejected') {
        return { outcome: 'skipped-rejected', project: best.project, score: best.score, reason: 'previously rejected by the user', matchedExisting: best.project };
      }
      const adopted = this.store.projects.update(workspaceId, best.project.id, {
        sourceKey: best.project.sourceKey ?? sourceKey,
        sourceId: best.project.sourceId ?? sourceId,
        aliases: mergeAliases(best.project, candidate),
        origin: best.project.origin === 'manual' ? 'manual' : 'connector',
      });
      if (adopted) {
        this.recordEvidence(workspaceId, adopted.id, candidate, `linked to ${candidate.locator}: ${best.reason}`, 'high');
        const updated = this.applyUpdate(workspaceId, adopted, candidate);
        return {
          outcome: 'updated',
          project: updated.project,
          score: best.score,
          reason: best.reason,
          matchedExisting: best.project,
        };
      }
    }

    // Genuinely new. Whether it registers itself depends on confidence and on
    // the automation level the user chose.
    const score = candidateConfidence(candidate, best?.score ?? 0);
    const threshold = opts.autoRegisterThreshold ?? DEFAULT_AUTO_REGISTER_THRESHOLD;
    const autoRegister = opts.automationLevel === 'automatic' && score >= threshold && !best;
    const reviewState: Project['reviewState'] = autoRegister ? 'confirmed' : 'pending-review';

    const created = this.store.projects.create({
      workspaceId,
      name: candidate.name,
      slug: slugify(candidate.name, 'project'),
      description: candidate.description ?? '',
      category: candidate.category ?? 'other',
      lifecycle: candidate.lifecycle ?? 'active',
      origin: 'connector',
      sourceKey,
      sourceId,
      aliases: dedupe([...(candidate.aliases ?? [])]),
      tags: candidate.tags ?? [],
      reviewState,
      confidence: confidenceFromScore(score),
      matchScore: score,
      lastActivityAt: candidate.lastActivityAt ?? null,
    });

    this.recordEvidence(
      workspaceId, created.id, candidate,
      `discovered from ${candidate.connector} (${candidate.locator})`,
      confidenceFromScore(score),
    );
    this.linkRelations(workspaceId, created, candidate);
    // linkRelations may set parentProjectId, so re-read rather than returning
    // the pre-link snapshot.
    const fresh = this.store.projects.byId(workspaceId, created.id) ?? created;

    return {
      outcome: autoRegister ? 'created' : 'queued-for-review',
      project: fresh,
      score,
      reason: autoRegister
        ? `new project, confidence ${score.toFixed(2)} at or above the ${threshold} auto-register threshold`
        : opts.automationLevel === 'automatic'
          ? `new project, confidence ${score.toFixed(2)} below the ${threshold} auto-register threshold`
          : `automation is set to "${opts.automationLevel}", so new projects wait for approval`,
      matchedExisting: best?.project ?? null,
    };
  }

  /** Scores existing projects against a candidate, best first. */
  scoreCandidates(workspaceId: Id, candidate: ProjectCandidate): Array<{ project: Project; score: number; reason: string }> {
    const pool = this.store.projects.dedupCandidates(workspaceId, candidate.name, candidate.aliases ?? []);
    const out: Array<{ project: Project; score: number; reason: string }> = [];
    const candNames = [candidate.name, ...(candidate.aliases ?? [])];

    for (const project of pool) {
      let score = 0;
      const reasons: string[] = [];

      // Rule 2: a recorded alias is as good as an identifier.
      const aliasHit = candNames.some((cn) =>
        project.aliases.some((a) => slugify(a) === slugify(cn)),
      );
      if (aliasHit) { score = Math.max(score, 0.9); reasons.push('matched a recorded alias'); }

      // Rule 3: identical normalised name.
      if (candNames.some((cn) => slugify(cn) === slugify(project.name) || slugify(cn) === project.slug)) {
        score = Math.max(score, 0.85);
        reasons.push('identical normalised name');
      }

      // Rule 4: similarity alone. Capped below the merge threshold on purpose,
      // so it can never merge two projects by itself.
      const sim = Math.max(...candNames.map((cn) => similarity(slugify(cn), slugify(project.name))));
      if (sim >= 0.82) {
        score = Math.max(score, 0.55 + (sim - 0.82) * 0.5);
        reasons.push(`name similarity ${sim.toFixed(2)}`);
      }

      // A project with no source key is likelier to be the manual record of
      // the same thing the connector just found.
      if (score > 0 && project.sourceKey === null) {
        score = Math.min(1, score + 0.05);
        reasons.push('existing project has no linked source');
      }
      // Two different source keys on the same connector mean two real things.
      if (project.sourceKey?.startsWith(`${candidate.connector}:`)) {
        score = Math.min(score, 0.5);
        reasons.push('already linked to a different record on this connector');
      }

      if (score > 0) out.push({ project, score: round(score), reason: reasons.join('; ') });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /** Applies connector-reported changes without clobbering the user's edits. */
  private applyUpdate(workspaceId: Id, project: Project, candidate: ProjectCandidate): { project: Project; changed: boolean } {
    const sourceId = candidate.sourceId && candidate.sourceId !== '' ? candidate.sourceId : null;
    const patch: Partial<Project> = {};
    const renamed = project.name !== candidate.name;

    // A rename keeps the old name as an alias, so future syncs and the user's
    // own searches still resolve it.
    if (renamed) {
      patch.name = candidate.name;
      patch.aliases = dedupe([...project.aliases, project.name, ...(candidate.aliases ?? [])]);
    } else if ((candidate.aliases ?? []).some((a) => !project.aliases.includes(a))) {
      patch.aliases = mergeAliases(project, candidate);
    }

    // Only fill a description the user has not written themselves.
    if (candidate.description && project.description.trim() === '') patch.description = candidate.description;
    if (candidate.category && project.category === 'other') patch.category = candidate.category;
    if (candidate.lastActivityAt && (!project.lastActivityAt || candidate.lastActivityAt > project.lastActivityAt)) {
      patch.lastActivityAt = candidate.lastActivityAt;
    }
    if (candidate.tags?.length) {
      const tags = dedupe([...project.tags, ...candidate.tags]);
      if (tags.length !== project.tags.length) patch.tags = tags;
    }
    if (project.sourceId === null && sourceId !== null) patch.sourceId = sourceId;

    if (Object.keys(patch).length === 0) return { project, changed: false };

    const updated = this.store.projects.update(workspaceId, project.id, patch) ?? project;
    if (renamed) {
      this.store.activity.add({
        workspaceId, projectId: project.id, connector: candidate.connector,
        kind: 'project.renamed', summary: `Renamed from "${project.name}" to "${candidate.name}"`,
        url: candidate.url ?? null, sourceId, actor: null,
        occurredAt: candidate.lastActivityAt ?? nowIso(),
      });
      this.recordEvidence(workspaceId, project.id, candidate, `renamed from "${project.name}"`, 'observed');
    }
    this.linkRelations(workspaceId, updated, candidate);
    return { project: this.store.projects.byId(workspaceId, project.id) ?? updated, changed: true };
  }

  /** Links monorepo, fork and deployment relations the connector reported. */
  private linkRelations(workspaceId: Id, project: Project, candidate: ProjectCandidate): void {
    if (candidate.parentExternalId) {
      const parent = this.store.projects.bySourceKey(workspaceId, sourceKeyFor(candidate.connector, candidate.parentExternalId));
      if (parent && parent.id !== project.id) {
        this.store.projects.update(workspaceId, project.id, { parentProjectId: parent.id });
        this.store.relationships.link({
          workspaceId, fromProjectId: project.id, toProjectId: parent.id,
          kind: 'monorepo-member', confidence: 'observed',
        });
      }
    }
    for (const rel of candidate.relatedExternalIds ?? []) {
      const other = this.store.projects.bySourceKey(workspaceId, sourceKeyFor(candidate.connector, rel.externalId));
      if (other && other.id !== project.id) {
        this.store.relationships.link({
          workspaceId, fromProjectId: project.id, toProjectId: other.id,
          kind: rel.kind, confidence: 'observed',
        });
      }
    }
  }

  private recordEvidence(workspaceId: Id, projectId: Id, candidate: ProjectCandidate, claim: string, confidence: Confidence): void {
    this.store.evidence.add({
      workspaceId, subject: `project:${projectId}`, claim,
      sourceId: candidate.sourceId && candidate.sourceId !== '' ? candidate.sourceId : null,
      confidence, observedAt: nowIso(),
    });
  }

  /** Approves a queued project. */
  confirm(workspaceId: Id, projectId: Id): Project | null {
    return this.store.projects.update(workspaceId, projectId, {
      reviewState: 'confirmed',
      confidence: 'observed',
      matchScore: 1,
    });
  }

  /** Rejects a queued project; later syncs will not resurrect it. */
  reject(workspaceId: Id, projectId: Id): Project | null {
    return this.store.projects.update(workspaceId, projectId, { reviewState: 'rejected' });
  }

  /** Merges a duplicate into a target, moving its records across. */
  merge(workspaceId: Id, duplicateId: Id, targetId: Id): { moved: number } | null {
    if (duplicateId === targetId) return null;
    const dup = this.store.projects.byId(workspaceId, duplicateId);
    const target = this.store.projects.byId(workspaceId, targetId);
    if (!dup || !target) return null;

    return this.store.transaction(() => {
      let moved = 0;
      for (const table of ['knowledge_records', 'tasks', 'goals', 'decisions', 'activity_events', 'resources', 'metrics', 'time_entries']) {
        moved += this.store.db.run(
          `UPDATE ${table} SET project_id = ? WHERE workspace_id = ? AND project_id = ?`,
          [targetId, workspaceId, duplicateId],
        ).changes;
      }
      this.store.projects.update(workspaceId, targetId, {
        aliases: dedupe([...target.aliases, dup.name, ...dup.aliases]),
        sourceKey: target.sourceKey ?? dup.sourceKey,
        lastActivityAt:
          dup.lastActivityAt && (!target.lastActivityAt || dup.lastActivityAt > target.lastActivityAt)
            ? dup.lastActivityAt
            : target.lastActivityAt,
      });
      this.store.relationships.link({
        workspaceId, fromProjectId: duplicateId, toProjectId: targetId,
        kind: 'duplicate-of', confidence: 'observed',
      });
      this.store.projects.update(workspaceId, duplicateId, {
        reviewState: 'rejected', archivedAt: nowIso(), parentProjectId: targetId,
      });
      return { moved };
    });
  }

  reviewQueue(workspaceId: Id): Project[] {
    return this.store.projects.list(workspaceId, { reviewState: ['pending-review'], limit: 200 });
  }
}

/* ---------------------------------------------------------------- */
/* Scoring helpers                                                   */
/* ---------------------------------------------------------------- */

/**
 * Confidence that a candidate is a real, distinct project worth registering.
 * Starts from what the connector knows and is reduced by anything that looks
 * like noise (a scratch directory, a template, a name that collides).
 */
export function candidateConfidence(candidate: ProjectCandidate, bestExistingScore: number): number {
  let score = candidate.connectorConfidence ?? 0.8;

  if (candidate.description && candidate.description.trim().length > 12) score += 0.08;
  if (candidate.lastActivityAt) score += 0.06;
  if (candidate.url) score += 0.03;

  const noise = /^(test|tmp|temp|scratch|untitled|new-?project|example|demo|foo|bar|playground|sandbox|dotfiles|\.)/i;
  if (noise.test(candidate.name.trim())) score -= 0.35;
  if (candidate.name.trim().length <= 2) score -= 0.3;
  if (/\b(template|boilerplate|starter|fork)\b/i.test(candidate.name)) score -= 0.12;

  // An ambiguous near-match to something that already exists should not
  // auto-register; let a human look at it.
  if (bestExistingScore > 0.5) score -= 0.25;

  return round(Math.max(0, Math.min(1, score)));
}

export function confidenceFromScore(score: number): Confidence {
  if (score >= 0.9) return 'observed';
  if (score >= 0.75) return 'high';
  if (score >= 0.5) return 'medium';
  if (score > 0) return 'low';
  return 'unverified';
}

/** Normalised Levenshtein similarity in [0,1]. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  // Two-row dynamic programming; inputs here are short slugs.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

function mergeAliases(project: Project, candidate: ProjectCandidate): string[] {
  return dedupe([...project.aliases, ...(candidate.aliases ?? []), candidate.name].filter((a) => a !== project.name));
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = slugify(x);
    if (k === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out.slice(0, 30);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
