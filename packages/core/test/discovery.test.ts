/**
 * Automatic project discovery, identity and deduplication.
 *
 * These are the tests that matter most for the brief's central claim: new
 * projects appear automatically, and existing ones update *without creating
 * duplicates*, through renames, forks, monorepos and multiple connectors.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, daysAgo } from './helpers.ts';
import {
  DiscoveryEngine, candidateConfidence, similarity, sourceKeyFor,
  DEFAULT_AUTO_REGISTER_THRESHOLD, type ProjectCandidate,
} from '../src/engines/discovery.ts';
import { PassportEngine, recommendFor } from '../src/engines/passport.ts';

/**
 * A fixed timestamp, so two calls to `candidate()` really are the same input.
 * Using `daysAgo(1)` here would make every candidate a few milliseconds newer
 * than the last, which legitimately counts as new activity and would make the
 * idempotency test impossible to write.
 */
const FIXED_ACTIVITY = '2026-10-01T12:00:00.000Z';

function candidate(over: Partial<ProjectCandidate> = {}): ProjectCandidate {
  return {
    connector: 'github',
    externalId: 'node_1',
    name: 'ai-brain',
    description: 'A personal intelligence operating system',
    locator: 'octocat/ai-brain',
    sourceId: null,
    lastActivityAt: FIXED_ACTIVITY,
    connectorConfidence: 0.9,
    ...over,
  };
}

describe('discovery: registration', () => {
  test('registers a high-confidence project automatically when automation is on', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const r = d.ingest(f.workspace.id, candidate(), { automationLevel: 'automatic' });
    assert.equal(r.outcome, 'created');
    assert.equal(r.project?.reviewState, 'confirmed');
    assert.ok(r.score >= 0.75, `score was ${r.score}`);
    f.close();
  });

  test('queues the same project for review when automation is "review"', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const r = d.ingest(f.workspace.id, candidate(), { automationLevel: 'review' });
    assert.equal(r.outcome, 'queued-for-review');
    assert.equal(r.project?.reviewState, 'pending-review');
    assert.equal(d.reviewQueue(f.workspace.id).length, 1);
    f.close();
  });

  test('a low-confidence candidate is never auto-registered', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const r = d.ingest(f.workspace.id, candidate({ name: 'tmp', description: '', connectorConfidence: 0.6 }), {
      automationLevel: 'automatic',
    });
    assert.equal(r.outcome, 'queued-for-review');
    assert.ok(r.score < 0.75, `noise-named candidate scored ${r.score}`);
    f.close();
  });

  test('records evidence for every discovered project', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const r = d.ingest(f.workspace.id, candidate(), { automationLevel: 'automatic' });
    const evidence = f.store.evidence.forSubject(f.workspace.id, `project:${r.project!.id}`);
    assert.equal(evidence.length, 1);
    assert.match(evidence[0]!.claim, /discovered from github/);
    f.close();
  });
});

describe('discovery: idempotency and deduplication', () => {
  test('re-ingesting unchanged input creates nothing and changes nothing', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const first = d.ingest(f.workspace.id, candidate(), { automationLevel: 'automatic' });
    const second = d.ingest(f.workspace.id, candidate(), { automationLevel: 'automatic' });
    assert.equal(second.outcome, 'unchanged');
    assert.equal(second.project?.id, first.project?.id);
    assert.equal(f.store.projects.list(f.workspace.id).length, 1);

    // Newer reported activity, however, is a real change.
    const moved = d.ingest(f.workspace.id, candidate({ lastActivityAt: daysAgo(0) }), { automationLevel: 'automatic' });
    assert.equal(moved.outcome, 'updated');
    f.close();
  });

  test('a rename updates in place and keeps the old name as an alias', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    d.ingest(f.workspace.id, candidate({ name: 'old-name' }), { automationLevel: 'automatic' });
    const r = d.ingest(f.workspace.id, candidate({ name: 'new-name' }), { automationLevel: 'automatic' });

    assert.equal(r.outcome, 'updated');
    assert.equal(r.project?.name, 'new-name');
    assert.ok(r.project?.aliases.includes('old-name'), 'old name must be kept as an alias');
    assert.equal(f.store.projects.list(f.workspace.id).length, 1, 'a rename must not create a second project');

    const renameEvent = f.store.activity.recent(f.workspace.id).find((a) => a.kind === 'project.renamed');
    assert.ok(renameEvent, 'a rename should be recorded as activity');
    f.close();
  });

  test('a manually created project is adopted rather than duplicated', () => {
    const f = makeWorkspace();
    const manual = f.store.projects.create({ workspaceId: f.workspace.id, name: 'AI Brain', origin: 'manual' });
    const d = new DiscoveryEngine(f.store);
    const r = d.ingest(f.workspace.id, candidate({ name: 'ai-brain' }), { automationLevel: 'automatic' });

    assert.equal(r.outcome, 'updated');
    assert.equal(r.project?.id, manual.id, 'must attach to the existing manual project');
    assert.equal(r.project?.sourceKey, sourceKeyFor('github', 'node_1'));
    assert.equal(r.project?.origin, 'manual', 'the user’s own record keeps its origin');
    assert.equal(f.store.projects.list(f.workspace.id).length, 1);
    f.close();
  });

  test('two genuinely different projects on the same connector stay separate', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    d.ingest(f.workspace.id, candidate({ externalId: 'node_1', name: 'api-server' }), { automationLevel: 'automatic' });
    const r = d.ingest(f.workspace.id, candidate({ externalId: 'node_2', name: 'api-client' }), { automationLevel: 'automatic' });
    assert.notEqual(r.project?.id, undefined);
    assert.equal(f.store.projects.list(f.workspace.id).length, 2);
    f.close();
  });

  test('name similarity alone never merges two projects', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    // Pre-existing project with a very similar name but a different source.
    d.ingest(f.workspace.id, candidate({ externalId: 'node_1', name: 'data-service' }), { automationLevel: 'automatic' });
    const scored = d.scoreCandidates(f.workspace.id, candidate({ externalId: 'node_2', name: 'data-services' }));
    assert.ok(scored.length > 0, 'similar name should be a candidate');
    assert.ok(scored[0]!.score < 0.8, `similarity score ${scored[0]!.score} must stay under the merge threshold`);

    const r = d.ingest(f.workspace.id, candidate({ externalId: 'node_2', name: 'data-services' }), { automationLevel: 'automatic' });
    assert.equal(r.outcome, 'queued-for-review', 'an ambiguous match must go to a human');
    assert.equal(f.store.projects.list(f.workspace.id).length, 2);
    f.close();
  });

  test('the same project seen through a second connector is linked, not duplicated', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const gh = d.ingest(f.workspace.id, candidate({ connector: 'github', externalId: 'node_1', name: 'ai-brain' }), {
      automationLevel: 'automatic',
    });
    const local = d.ingest(
      f.workspace.id,
      candidate({ connector: 'local-directory', externalId: 'dir:/code/ai-brain', name: 'ai-brain', locator: '/code/ai-brain' }),
      { automationLevel: 'automatic' },
    );
    assert.equal(local.project?.id, gh.project?.id, 'both connectors must resolve to one project');
    assert.equal(f.store.projects.list(f.workspace.id).length, 1);
    f.close();
  });

  test('a rejected project is not resurrected by later syncs', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const r = d.ingest(f.workspace.id, candidate(), { automationLevel: 'review' });
    d.reject(f.workspace.id, r.project!.id);

    const again = d.ingest(f.workspace.id, candidate(), { automationLevel: 'automatic' });
    assert.equal(again.outcome, 'skipped-rejected');
    assert.equal(f.store.projects.list(f.workspace.id).length, 0, 'rejected projects are hidden from listings');
    f.close();
  });

  test('confirming a queued project marks it observed', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const r = d.ingest(f.workspace.id, candidate(), { automationLevel: 'review' });
    const confirmed = d.confirm(f.workspace.id, r.project!.id);
    assert.equal(confirmed?.reviewState, 'confirmed');
    assert.equal(confirmed?.confidence, 'observed');
    assert.equal(confirmed?.matchScore, 1);
    f.close();
  });
});

describe('discovery: relationships', () => {
  test('monorepo members attach to their parent', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const parent = d.ingest(
      f.workspace.id,
      candidate({ connector: 'local-directory', externalId: 'dir:/code/mono', name: 'mono', locator: '/code/mono' }),
      { automationLevel: 'automatic' },
    );
    const child = d.ingest(
      f.workspace.id,
      candidate({
        connector: 'local-directory', externalId: 'dir:/code/mono/packages/core',
        name: 'core', locator: '/code/mono/packages/core', parentExternalId: 'dir:/code/mono',
      }),
      { automationLevel: 'automatic' },
    );
    assert.equal(child.project?.parentProjectId, parent.project?.id);
    const rels = f.store.relationships.forProject(f.workspace.id, child.project!.id);
    assert.ok(rels.some((r) => r.kind === 'monorepo-member'));
    f.close();
  });

  test('a fork is recorded as a relationship to its parent', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const upstream = d.ingest(f.workspace.id, candidate({ externalId: 'node_up', name: 'upstream' }), { automationLevel: 'automatic' });
    const fork = d.ingest(
      f.workspace.id,
      candidate({ externalId: 'node_fork', name: 'my-fork', relatedExternalIds: [{ externalId: 'node_up', kind: 'fork-of' }] }),
      { automationLevel: 'automatic' },
    );
    const rels = f.store.relationships.forProject(f.workspace.id, fork.project!.id);
    assert.ok(rels.some((r) => r.kind === 'fork-of' && r.toProjectId === upstream.project!.id));
    f.close();
  });
});

describe('discovery: merge', () => {
  test('merging moves records and leaves a duplicate-of link', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const a = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Project A' });
    const b = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Project A copy' });
    f.store.tasks.create({ workspaceId: f.workspace.id, projectId: b.id, title: 'A task' });
    f.store.knowledge.create({ workspaceId: f.workspace.id, projectId: b.id, title: 'A note' });

    const result = d.merge(f.workspace.id, b.id, a.id);
    assert.ok(result && result.moved >= 2, `expected records to move, moved=${result?.moved}`);

    assert.equal(f.store.tasks.list(f.workspace.id, { projectId: a.id }).length, 1);
    assert.equal(f.store.knowledge.list(f.workspace.id, { projectId: a.id }).length, 1);
    const merged = f.store.projects.byId(f.workspace.id, b.id);
    assert.equal(merged?.reviewState, 'rejected');
    assert.ok(merged?.archivedAt);
    assert.ok(f.store.projects.byId(f.workspace.id, a.id)?.aliases.includes('Project A copy'));
    f.close();
  });

  test('merging a project into itself is refused', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const a = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Solo' });
    assert.equal(d.merge(f.workspace.id, a.id, a.id), null);
    f.close();
  });
});

describe('scoring', () => {
  test('noise names fall below the auto-register threshold', () => {
    // The threshold is the thing that matters: a repo called "test" must never
    // register itself, however much other metadata it carries.
    assert.ok(candidateConfidence(candidate({ name: 'test' }), 0) < DEFAULT_AUTO_REGISTER_THRESHOLD);
    assert.ok(candidateConfidence(candidate({ name: 'untitled' }), 0) < DEFAULT_AUTO_REGISTER_THRESHOLD);
    assert.ok(candidateConfidence(candidate({ name: 'ai-brain' }), 0) > DEFAULT_AUTO_REGISTER_THRESHOLD);
  });

  test('an ambiguous near-match reduces confidence', () => {
    const alone = candidateConfidence(candidate(), 0);
    const ambiguous = candidateConfidence(candidate(), 0.7);
    assert.ok(ambiguous < alone, `${ambiguous} should be below ${alone}`);
  });

  test('similarity is symmetric and bounded', () => {
    assert.equal(similarity('abc', 'abc'), 1);
    assert.equal(similarity('', 'abc'), 0);
    assert.equal(similarity('kitten', 'sitting'), similarity('sitting', 'kitten'));
    assert.ok(similarity('data-service', 'data-services') > 0.9);
  });
});

describe('project passports', () => {
  test('sections differ by category', () => {
    const f = makeWorkspace();
    const engine = new PassportEngine(f.store);
    const software = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Lib', category: 'software' });
    const client = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Acme', category: 'client' });

    const softKeys = engine.build(f.workspace.id, software.id)!.sections.map((s) => s.key);
    const clientKeys = engine.build(f.workspace.id, client.id)!.sections.map((s) => s.key);

    assert.ok(softKeys.includes('ci'), 'software passports include CI');
    assert.ok(!clientKeys.includes('ci'), 'client passports do not include CI');
    assert.ok(clientKeys.includes('financials'), 'client passports include financials');
    f.close();
  });

  test('an empty section reports nothing rather than a zero', () => {
    const f = makeWorkspace();
    const engine = new PassportEngine(f.store);
    const p = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Fresh', category: 'software' });
    const passport = engine.build(f.workspace.id, p.id)!;

    const ci = passport.sections.find((s) => s.key === 'ci')!;
    assert.equal(ci.rows.length, 0);
    assert.equal(ci.lastVerifiedAt, null, 'nothing has verified this section');
    f.close();
  });

  test('completeness reflects only populated sections', () => {
    const f = makeWorkspace();
    const engine = new PassportEngine(f.store);
    const p = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Partial', category: 'software' });
    const before = engine.build(f.workspace.id, p.id)!.completeness;

    f.store.goals.create({ workspaceId: f.workspace.id, projectId: p.id, title: 'Ship it' });
    f.store.decisions.create({ workspaceId: f.workspace.id, projectId: p.id, title: 'Use SQLite' });
    const after = engine.build(f.workspace.id, p.id)!.completeness;

    assert.ok(after > before, `completeness should rise (${before} -> ${after})`);
    f.close();
  });

  test('passport sections carry their provenance', () => {
    const f = makeWorkspace();
    const d = new DiscoveryEngine(f.store);
    const { record } = f.store.sources.upsert({
      workspaceId: f.workspace.id, connectedAccountId: null, connector: 'github',
      kind: 'repository', externalId: 'node_1', locator: 'octocat/ai-brain',
      url: 'https://github.com/octocat/ai-brain', payload: { full_name: 'octocat/ai-brain' },
      payloadHash: 'h1', observedAt: daysAgo(1),
    });
    const r = d.ingest(f.workspace.id, candidate({ sourceId: record.id }), { automationLevel: 'automatic' });

    const engine = new PassportEngine(f.store);
    const identity = engine.build(f.workspace.id, r.project!.id)!.sections.find((s) => s.key === 'identity')!;
    assert.equal(identity.origin, 'connector');
    assert.ok(identity.sourceRefs.length > 0, 'identity must cite its source');
    assert.equal(identity.sourceRefs[0]!.locator, 'octocat/ai-brain');
    f.close();
  });

  test('recommendations are evidence-backed and prioritised', () => {
    const f = makeWorkspace();
    const p = f.store.projects.create({
      workspaceId: f.workspace.id, name: 'Stale', lifecycle: 'active', lastActivityAt: daysAgo(120),
    });
    f.store.tasks.create({ workspaceId: f.workspace.id, projectId: p.id, title: 'Blocked thing', status: 'blocked' });

    const recs = recommendFor(f.store, f.workspace.id, p);
    assert.ok(recs.length > 0);
    assert.equal(recs[0]!.priority, 'now', 'blocked work comes first');
    assert.ok(recs.every((r) => r.because.length > 0), 'every recommendation states its reason');
    assert.ok(recs.some((r) => r.because.includes('120 days')), 'staleness is quantified');
    f.close();
  });
});
