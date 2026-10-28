/**
 * Performance characteristics at a size a real user reaches.
 *
 * The thresholds are generous on purpose: this is a regression guard against
 * accidental O(n²) work, not a benchmark. Measured numbers are printed so the
 * README can quote something real rather than an aspiration.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, type Fixture } from './helpers.ts';
import { DashboardEngine } from '../src/engines/dashboard.ts';
import { ResourceEngine } from '../src/engines/resources.ts';
import { ReviewEngine } from '../src/engines/review.ts';
import { AssistantEngine } from '../src/engines/assistant.ts';
import { PassportEngine } from '../src/engines/passport.ts';
import { DiscoveryEngine } from '../src/engines/discovery.ts';
import { buildContextPackage } from '../src/ai/context-package.ts';

const PROJECTS = 300;
const KNOWLEDGE = 3000;
const ACTIVITY = 6000;

function ms(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return Math.round((performance.now() - t0) * 100) / 100;
}

const WORDS = ['storage', 'migration', 'schema', 'deployment', 'pipeline', 'authentication', 'cache', 'index', 'latency', 'rollback', 'telemetry', 'budget'];

describe('performance at realistic scale', () => {
  let f: Fixture;
  const projectIds: string[] = [];

  before(() => {
    f = makeWorkspace({ profile: 'developer' });
    const seedStart = performance.now();

    f.store.transaction(() => {
      for (let i = 0; i < PROJECTS; i++) {
        const p = f.store.projects.create({
          workspaceId: f.workspace.id,
          name: `Project ${i} ${WORDS[i % WORDS.length]}`,
          description: `A project about ${WORDS[i % WORDS.length]} and ${WORDS[(i + 3) % WORDS.length]}`,
          category: i % 3 === 0 ? 'software' : i % 3 === 1 ? 'business' : 'content',
          lifecycle: i % 7 === 0 ? 'paused' : 'active',
          sourceKey: `github:node_${i}`,
          origin: 'connector',
          lastActivityAt: new Date(Date.now() - (i % 120) * 86_400_000).toISOString(),
        });
        projectIds.push(p.id);
      }
      for (let i = 0; i < KNOWLEDGE; i++) {
        f.store.knowledge.create({
          workspaceId: f.workspace.id,
          projectId: projectIds[i % PROJECTS]!,
          title: `Note ${i}: ${WORDS[i % WORDS.length]}`,
          body: `This record discusses ${WORDS[i % WORDS.length]} and ${WORDS[(i + 5) % WORDS.length]}. ` +
                `Entry number ${i} with filler text to give the index something to chew on.`,
          klass: (['fact', 'decision', 'idea', 'action', 'insight'] as const)[i % 5]!,
        });
      }
      for (let i = 0; i < ACTIVITY; i++) {
        f.store.activity.add({
          workspaceId: f.workspace.id,
          projectId: projectIds[i % PROJECTS]!,
          connector: 'github',
          kind: 'commit',
          summary: `commit ${i} touching ${WORDS[i % WORDS.length]}`,
          url: null, sourceId: null, actor: 'octocat',
          occurredAt: new Date(Date.now() - (i % 60) * 3_600_000).toISOString(),
        });
      }
      for (let i = 0; i < 400; i++) {
        f.store.tasks.create({
          workspaceId: f.workspace.id, projectId: projectIds[i % PROJECTS]!,
          title: `Task ${i}`, status: i % 4 === 0 ? 'blocked' : 'todo',
          priority: ((i % 4) + 1) as 1 | 2 | 3 | 4,
        });
      }
      for (let i = 0; i < 120; i++) {
        f.store.resources.create({
          workspaceId: f.workspace.id, projectId: projectIds[i % PROJECTS]!,
          kind: i % 2 === 0 ? 'subscription' : 'infrastructure',
          name: `Service ${i}`, amountMinor: 500 + i * 13, period: 'monthly',
        });
      }
    });

    console.log(
      `    seeded ${PROJECTS} projects, ${KNOWLEDGE} knowledge records, ${ACTIVITY} activity events ` +
      `in ${Math.round(performance.now() - seedStart)}ms`,
    );
  });

  test('full-text search over 3000 records stays fast', () => {
    let hits = 0;
    const t = ms(() => { hits = f.store.knowledge.search(f.workspace.id, 'migration', { limit: 50 }).length; });
    console.log(`    search (3000 records, ${hits} hits): ${t}ms`);
    assert.ok(hits > 0, 'the query should actually match something');
    assert.ok(t < 250, `search took ${t}ms`);
  });

  test('a multi-term search stays fast', () => {
    const t = ms(() => f.store.knowledge.search(f.workspace.id, 'schema migration rollback', { limit: 50 }));
    console.log(`    multi-term search: ${t}ms`);
    assert.ok(t < 250, `search took ${t}ms`);
  });

  test('a filtered search stays fast', () => {
    const t = ms(() => f.store.knowledge.search(f.workspace.id, 'cache', { klass: ['decision'], limit: 50 }));
    console.log(`    filtered search: ${t}ms`);
    assert.ok(t < 250, `search took ${t}ms`);
  });

  test('listing 300 projects stays fast', () => {
    let n = 0;
    const t = ms(() => { n = f.store.projects.list(f.workspace.id, { limit: 500 }).length; });
    console.log(`    project list (${n} rows): ${t}ms`);
    assert.equal(n, PROJECTS);
    assert.ok(t < 200, `list took ${t}ms`);
  });

  test('the dashboard renders at this scale', () => {
    let widgets = 0;
    const t = ms(() => { widgets = new DashboardEngine(f.store).build(f.workspace.id, f.config).widgets.length; });
    console.log(`    dashboard (${widgets} widgets): ${t}ms`);
    assert.ok(widgets > 0);
    assert.ok(t < 3000, `dashboard took ${t}ms`);
  });

  test('allocation across 300 projects stays bounded', () => {
    let rows = 0;
    const t = ms(() => { rows = new ResourceEngine(f.store).allocation(f.workspace.id).length; });
    console.log(`    allocation (${rows} projects): ${t}ms`);
    assert.equal(rows, PROJECTS);
    assert.ok(t < 5000, `allocation took ${t}ms`);
  });

  test('a passport builds quickly for one project', () => {
    const t = ms(() => new PassportEngine(f.store).build(f.workspace.id, projectIds[0]!));
    console.log(`    passport: ${t}ms`);
    assert.ok(t < 500, `passport took ${t}ms`);
  });

  test('a review over the whole workspace completes', () => {
    const t = ms(() => new ReviewEngine(f.store).buildReview(f.workspace.id, 'weekly', f.config));
    console.log(`    weekly review: ${t}ms`);
    assert.ok(t < 8000, `review took ${t}ms`);
  });

  test('the assistant answers at this scale', () => {
    const a = new AssistantEngine(f.store);
    const t = ms(() => a.ask(f.workspace.id, 'What needs my attention today?', f.config));
    console.log(`    assistant answer: ${t}ms`);
    assert.ok(t < 3000, `answer took ${t}ms`);
  });

  test('discovery stays sub-linear-ish against a large existing pool', () => {
    const d = new DiscoveryEngine(f.store);
    const t = ms(() =>
      d.ingest(f.workspace.id, {
        connector: 'github', externalId: 'node_new_one', name: 'brand new project',
        description: 'A project that does not exist yet', locator: 'octocat/new',
        sourceId: null, lastActivityAt: new Date().toISOString(), connectorConfidence: 0.9,
      }, { automationLevel: 'review' }),
    );
    console.log(`    discovery against ${PROJECTS} existing projects: ${t}ms`);
    assert.ok(t < 1000, `discovery took ${t}ms`);
  });

  test('a context package builds at this scale', () => {
    let size = 0;
    const t = ms(() => {
      size = JSON.stringify(buildContextPackage(f.store, f.workspace.id, f.config, { maxKnowledge: 100 })).length;
    });
    console.log(`    context package (${Math.round(size / 1024)} KB): ${t}ms`);
    assert.ok(t < 10_000, `context package took ${t}ms`);
  });

  test('inserting 500 more activity events is fast', () => {
    const t = ms(() => {
      f.store.transaction(() => {
        for (let i = 0; i < 500; i++) {
          f.store.activity.add({
            workspaceId: f.workspace.id, projectId: projectIds[i % PROJECTS]!,
            connector: 'github', kind: 'commit', summary: `burst ${i}`,
            url: null, sourceId: null, actor: null, occurredAt: new Date().toISOString(),
          });
        }
      });
    });
    console.log(`    500 activity inserts in one transaction: ${t}ms (${Math.round(500 / (t / 1000))}/s)`);
    assert.ok(t < 3000, `inserts took ${t}ms`);
  });

  test('recent activity over 6500 events is indexed', () => {
    let n = 0;
    const t = ms(() => { n = f.store.activity.recent(f.workspace.id, { limit: 50 }).length; });
    console.log(`    recent activity (${n} of ${ACTIVITY + 500}): ${t}ms`);
    assert.equal(n, 50);
    assert.ok(t < 150, `query took ${t}ms`);
  });
});
