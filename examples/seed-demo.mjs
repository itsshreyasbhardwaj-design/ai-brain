#!/usr/bin/env node
/**
 * Demo data.
 *
 * Fills a workspace with clearly fictional records so the interface can be seen
 * populated without connecting anything. Two safeguards, because sample data
 * masquerading as real data is exactly the failure this project is built to
 * avoid:
 *
 *   1. every record it creates is tagged `[demo]`;
 *   2. it refuses to run against a database that already holds records it did
 *      not create.
 *
 *   node examples/seed-demo.mjs --db ./data/demo.db
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dbArg = args.indexOf('--db');
const dbPath = resolve(root, dbArg >= 0 ? args[dbArg + 1] : './data/demo.db');

const { openDb } = await import(resolve(root, 'packages/core/src/db/client.ts'));
const { Store } = await import(resolve(root, 'packages/core/src/db/repositories.ts'));
const { AuthService } = await import(resolve(root, 'packages/core/src/engines/auth.ts'));

const db = openDb({ path: dbPath });
const store = new Store(db);
const auth = new AuthService(store);

const DEMO_TAG = 'demo';
const EMAIL = 'demo@ai-brain.local';
const PASSWORD = 'demo-password-not-for-real-use';

let workspace;
let user;

if (auth.needsSetup()) {
  const created = auth.register({
    email: EMAIL,
    displayName: 'Demo User',
    password: PASSWORD,
    workspaceName: 'Demo Brain',
    onboarding: {
      profile: 'developer',
      intents: ['stop losing track of my repositories', 'know what my tools cost'],
      automationLevel: 'review',
    },
  });
  workspace = created.workspace;
  user = created.user;
  console.log(`Created a demo account: ${EMAIL} / ${PASSWORD}`);
} else {
  user = store.users.byEmail(EMAIL);
  if (!user) {
    console.error(
      `${dbPath} already has an account that is not the demo one.\n` +
      `This script will not add fictional records to a real brain.\n` +
      `Point it at a separate file:  node examples/seed-demo.mjs --db ./data/demo.db`,
    );
    db.close();
    process.exit(1);
  }
  workspace = store.workspaces.listForUser(user.id)[0];
  const existing = store.projects.list(workspace.id, { limit: 1000 });
  const foreign = existing.filter((p) => !p.tags.includes(DEMO_TAG));
  if (foreign.length > 0) {
    console.error(`${dbPath} contains ${foreign.length} project(s) this script did not create. Refusing to touch it.`);
    db.close();
    process.exit(1);
  }
  console.log('Demo account already exists; topping up its data.');
}

const ws = workspace.id;
const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const dayOnly = (n) => day(n).slice(0, 10);

store.transaction(() => {
  const projects = [
    { name: 'Lumen CLI', category: 'software', description: 'A fictional command line tool for the demo data', lifecycle: 'active', activity: 1 },
    { name: 'Harbour API', category: 'software', description: 'A fictional service, busy and healthy', lifecycle: 'active', activity: 0 },
    { name: 'Atlas Redesign', category: 'client', description: 'A fictional client engagement', lifecycle: 'blocked', activity: 9 },
    { name: 'Field Notes', category: 'content', description: 'A fictional writing project', lifecycle: 'paused', activity: 48 },
    { name: 'Thermal Study', category: 'research', description: 'A fictional research thread', lifecycle: 'active', activity: 14 },
  ].map((p) =>
    store.projects.create({
      workspaceId: ws, name: p.name, description: p.description,
      category: p.category, lifecycle: p.lifecycle,
      tags: [DEMO_TAG], origin: 'manual', lastActivityAt: day(p.activity),
    }),
  );
  const [lumen, harbour, atlas, notes, thermal] = projects;

  // A discovery waiting for review, so the queue is not empty.
  store.projects.create({
    workspaceId: ws, name: 'scratch-experiments', origin: 'connector',
    sourceKey: 'github:DEMO_node_scratch', reviewState: 'pending-review',
    matchScore: 0.58, confidence: 'medium', category: 'software',
    tags: [DEMO_TAG], lastActivityAt: day(31),
  });

  for (const [project, title, due, status, priority] of [
    [lumen, 'Write the install guide', 2, 'todo', 2],
    [lumen, 'Cut the 0.3 release', 6, 'doing', 1],
    [harbour, 'Add request tracing', null, 'todo', 3],
    [atlas, 'Waiting on brand assets from the client', null, 'blocked', 2],
    [atlas, 'Send the second invoice', -4, 'todo', 1],
    [thermal, 'Replicate the November run', 11, 'todo', 3],
  ]) {
    store.tasks.create({
      workspaceId: ws, projectId: project.id, title,
      status, priority, origin: 'manual',
      dueAt: due === null ? null : day(-due),
      estimateMinutes: 90,
    });
  }

  for (const [project, title, horizon, progress] of [
    [lumen, 'Ship 1.0 with documentation anyone can follow', 'year', 45],
    [atlas, 'Deliver the redesign without scope creep', 'quarter', 60],
    [thermal, 'Answer whether the effect is real', 'long-term', 20],
  ]) {
    store.goals.create({
      workspaceId: ws, projectId: project.id, title, horizon,
      progress, progressOrigin: 'manual',
    });
  }

  store.decisions.create({
    workspaceId: ws, projectId: lumen.id,
    title: 'Ship without a plugin system',
    context: 'Three people asked for plugins before anyone had used the tool for a week.',
    choice: 'No plugin system in 1.0',
    rationale: 'A stable extension interface is a promise. Making it before the core is settled means breaking it later.',
    alternatives: ['A minimal hook API', 'Plugins behind a flag'],
    outcome: 'Nobody has asked again since the docs improved.',
    decidedAt: day(40),
  });
  store.decisions.create({
    workspaceId: ws, projectId: atlas.id,
    title: 'Fixed scope rather than hourly',
    context: 'The client asked for an open-ended engagement.',
    choice: 'Fixed scope with a written change process',
    rationale: 'Open-ended work with this client has drifted before.',
    decidedAt: day(22),
  });

  for (const [title, body, klass, project] of [
    ['Lumen uses a single config file', 'All configuration lives in lumen.toml at the project root. There is no global config, deliberately.', 'fact', lumen],
    ['Why the build got slow in September', 'Turns out the root cause was an unbounded cache key. Lesson: measure before optimising.', 'insight', lumen],
    ['Idea: a read-only mode for Harbour', 'What if the API could be started in a mode that rejects every write? Useful for demos.', 'idea', harbour],
    ['Atlas brand guidelines are in the shared drive', 'The client keeps them in a folder we do not have access to. Asked twice.', 'fact', atlas],
    ['Next steps for the thermal study', '- [ ] replicate the November run\n- [ ] check the sensor calibration\n- [ ] write up either way', 'action', thermal],
    ['Field Notes has stalled', 'Three drafts sitting unfinished since August. Either finish one or archive the project.', 'insight', notes],
  ]) {
    store.knowledge.create({
      workspaceId: ws, projectId: project.id, title, body, klass,
      origin: 'manual', confidence: 'observed', tags: [DEMO_TAG],
      observedAt: day(Math.floor(Math.random() * 60)),
    });
  }

  for (const [name, kind, minor, period, project] of [
    ['Harbour staging host', 'infrastructure', 2400, 'monthly', harbour],
    ['Domain renewals', 'subscription', 4800, 'yearly', null],
    ['Design tool', 'subscription', 1500, 'monthly', atlas],
    ['Notes app', 'subscription', 1000, 'monthly', null],
    ['Second notes app', 'subscription', 500, 'monthly', null],
    ['Error tracking', 'subscription', 2900, 'monthly', lumen],
  ]) {
    store.resources.create({
      workspaceId: ws, kind, name, amountMinor: minor, period,
      projectId: project?.id ?? null, origin: 'manual',
      notes: 'demo data',
      lastConfirmedAt: name.includes('Second') ? null : day(10),
    });
  }

  for (let i = 0; i < 18; i++) {
    const project = [lumen, harbour, thermal][i % 3];
    store.time.log({
      workspaceId: ws, projectId: project.id,
      minutes: 45 + (i % 5) * 30,
      kind: i % 7 === 0 ? 'meeting' : i % 11 === 0 ? 'break' : 'focus',
      occurredOn: dayOnly(i), origin: 'manual', label: 'demo entry',
    });
  }

  for (let i = 0; i < 26; i++) {
    const project = i % 4 === 0 ? harbour : lumen;
    store.activity.add({
      workspaceId: ws, projectId: project.id, connector: 'manual',
      kind: 'commit', summary: `[demo] commit ${i}: incremental work`,
      url: null, sourceId: null, actor: 'demo',
      occurredAt: day(Math.floor(i / 2)),
    });
  }
  store.projects.touchActivity(ws, lumen.id, day(1));
  store.projects.touchActivity(ws, harbour.id, day(0));

  for (const [project, key, label, value, unit, target] of [
    [lumen, 'ci_pass_rate', 'CI pass rate', 91, '%', 100],
    [lumen, 'open_issues', 'Open issues and PRs', 7, '', null],
    [harbour, 'ci_pass_rate', 'CI pass rate', 100, '%', 100],
    [harbour, 'open_issues', 'Open issues and PRs', 2, '', null],
  ]) {
    store.metrics.record({
      workspaceId: ws, projectId: project.id, key, label, value, unit,
      origin: 'manual', sourceId: null, target, observedAt: day(1),
    });
  }
});

const counts = {
  projects: store.projects.list(ws, { limit: 1000 }).length,
  knowledge: store.knowledge.total(ws),
  tasks: store.tasks.list(ws, { status: ['todo', 'doing', 'blocked'] }).length,
  decisions: store.decisions.list(ws, { limit: 100 }).length,
};

console.log('');
console.log(`Seeded ${dbPath}`);
console.log(`  ${counts.projects} projects (1 awaiting review), ${counts.knowledge} knowledge records,`);
console.log(`  ${counts.tasks} open tasks, ${counts.decisions} decisions, plus time, cost and activity.`);
console.log('');
console.log('Everything above is fictional and tagged [demo].');
console.log('');
console.log(`  AI_BRAIN_DB=${dbPath} pnpm dev`);
console.log(`  sign in as ${EMAIL} / ${PASSWORD}`);

db.close();
