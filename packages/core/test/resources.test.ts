/**
 * Resource optimization, reviews, the dashboard and the assistant.
 *
 * The recurring assertion in this file is the one the brief insists on: with no
 * data, every surface says it has no data. It never shows a zero, an estimate
 * or a sample that could be read as a measurement.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, daysAgo, dayStringAgo } from './helpers.ts';
import { ResourceEngine } from '../src/engines/resources.ts';
import { ReviewEngine } from '../src/engines/review.ts';
import { DashboardEngine } from '../src/engines/dashboard.ts';
import { AssistantEngine } from '../src/engines/assistant.ts';
import { monthlyMinor, formatMoney } from '../src/engines/passport.ts';

describe('time intelligence', () => {
  test('reports no data rather than zero when nothing is logged', () => {
    const f = makeWorkspace();
    const r = new ResourceEngine(f.store).timeReport(f.workspace.id, 7);
    assert.equal(r.hasData, false);
    assert.equal(r.totalMinutes, 0);
    assert.ok(r.notes.some((nn) => nn.includes('No time has been logged')));
    f.close();
  });

  test('aggregates logged time by project with shares', () => {
    const f = makeWorkspace();
    const a = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Alpha' });
    const b = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Beta' });
    f.store.time.log({ workspaceId: f.workspace.id, projectId: a.id, minutes: 180, occurredOn: dayStringAgo(1) });
    f.store.time.log({ workspaceId: f.workspace.id, projectId: b.id, minutes: 60, occurredOn: dayStringAgo(2) });

    const r = new ResourceEngine(f.store).timeReport(f.workspace.id, 7);
    assert.equal(r.hasData, true);
    assert.equal(r.totalMinutes, 240);
    assert.equal(r.byProject[0]!.projectName, 'Alpha');
    assert.equal(r.byProject[0]!.share, 75);
    assert.equal(r.deepWorkDays, 2, 'both days had a 60+ minute focus block');
    f.close();
  });

  test('never treats app time as work: only logged entries count', () => {
    const f = makeWorkspace();
    const p = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Busy' });
    // Lots of recorded activity, but no logged time.
    for (let i = 0; i < 50; i++) {
      f.store.activity.add({
        workspaceId: f.workspace.id, projectId: p.id, connector: 'github', kind: 'commit',
        summary: `commit ${i}`, url: null, sourceId: null, actor: null, occurredAt: daysAgo(1),
      });
    }
    const r = new ResourceEngine(f.store).timeReport(f.workspace.id, 7);
    assert.equal(r.hasData, false, 'activity is not time');
    assert.ok(r.notes.some((nn) => nn.includes('No time has been logged')));
    f.close();
  });

  test('warns about overcommitment using estimates on tasks due soon', () => {
    const f = makeWorkspace();
    f.store.time.log({ workspaceId: f.workspace.id, minutes: 2000, occurredOn: dayStringAgo(1) });
    f.store.tasks.create({
      workspaceId: f.workspace.id, title: 'Big thing', estimateMinutes: 3000, dueAt: daysAgo(-3), status: 'todo',
    });
    const r = new ResourceEngine(f.store).timeReport(f.workspace.id, 7);
    assert.ok(r.overcommitment, 'should flag overcommitment');
    assert.ok(r.overcommitment!.overBy > 0);
    f.close();
  });

  test('notes missing recovery time without moralising about it', () => {
    const f = makeWorkspace();
    f.store.time.log({ workspaceId: f.workspace.id, minutes: 120, kind: 'focus', occurredOn: dayStringAgo(1) });
    const r = new ResourceEngine(f.store).timeReport(f.workspace.id, 7);
    const note = r.notes.find((nn) => nn.includes('recovery'));
    assert.ok(note, 'should mention recovery time');
    assert.ok(note!.includes('gap in the record'), 'framed as a data gap, not a judgement');
    f.close();
  });
});

describe('financial intelligence', () => {
  test('reports no data rather than a zero total', () => {
    const f = makeWorkspace();
    const r = new ResourceEngine(f.store).costReport(f.workspace.id);
    assert.equal(r.hasData, false);
    assert.ok(r.notes.some((nn) => nn.includes('No costs have been recorded')));
    f.close();
  });

  test('converts yearly to monthly and excludes one-off costs from recurring', () => {
    const f = makeWorkspace();
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'Monthly tool', amountMinor: 1200, period: 'monthly' });
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'Yearly tool', amountMinor: 12_000, period: 'yearly' });
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'tool', name: 'One-time purchase', amountMinor: 9900, period: 'one-off' });

    const r = new ResourceEngine(f.store).costReport(f.workspace.id);
    assert.equal(r.monthlyRecurringMinor, 1200 + 1000, 'yearly is divided by 12, one-off excluded');
    assert.equal(r.oneOffMinor, 9900);
    f.close();
  });

  test('refuses to call anything an anomaly without a baseline', () => {
    const f = makeWorkspace();
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'Huge', amountMinor: 500_000, period: 'monthly' });
    const r = new ResourceEngine(f.store).costReport(f.workspace.id);
    assert.equal(r.anomalies.length, 0);
    assert.ok(r.notes.some((nn) => nn.includes('Fewer than four')));
    f.close();
  });

  test('flags an outlier once there is a baseline', () => {
    const f = makeWorkspace();
    for (const [name, amt] of [['A', 1000], ['B', 1200], ['C', 900], ['D', 1100]] as Array<[string, number]>) {
      f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name, amountMinor: amt, period: 'monthly' });
    }
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'Outlier', amountMinor: 50_000, period: 'monthly' });

    const r = new ResourceEngine(f.store).costReport(f.workspace.id);
    assert.equal(r.anomalies.length, 1);
    assert.equal(r.anomalies[0]!.resource.name, 'Outlier');
    assert.ok(r.anomalies[0]!.reason.includes('median'), 'the reason states the rule used');
    f.close();
  });

  test('warns when currencies are mixed instead of summing silently', () => {
    const f = makeWorkspace();
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'USD thing', amountMinor: 1000, period: 'monthly', currency: 'USD' });
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'EUR thing', amountMinor: 1000, period: 'monthly', currency: 'EUR' });
    const r = new ResourceEngine(f.store).costReport(f.workspace.id);
    assert.ok(r.notes.some((nn) => nn.includes('more than one currency')));
    f.close();
  });

  test('compares budgets against recorded spend', () => {
    const f = makeWorkspace();
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'budget', name: 'Tooling budget', amountMinor: 2000, period: 'monthly' });
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'Expensive', amountMinor: 5000, period: 'monthly' });

    const r = new ResourceEngine(f.store).costReport(f.workspace.id);
    assert.equal(r.budgets.length, 1);
    assert.equal(r.budgets[0]!.overBy, 3000);
    f.close();
  });

  test('money formatting is stable for minor units', () => {
    assert.equal(formatMoney(1200, 'USD'), '$12');
    assert.equal(formatMoney(1250, 'USD'), '$12.50');
    assert.equal(monthlyMinor(12_000, 'yearly'), 1000);
    assert.equal(monthlyMinor(5000, 'one-off'), 0);
    assert.equal(monthlyMinor(5000, null), 0);
  });
});

describe('tool inventory', () => {
  test('flags unconfirmed and unattached tools, and says it cannot cancel them', () => {
    const f = makeWorkspace();
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'Notion', amountMinor: 1000, period: 'monthly' });
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'Obsidian Sync', amountMinor: 400, period: 'monthly', lastConfirmedAt: daysAgo(400) });

    const inv = new ResourceEngine(f.store).toolInventory(f.workspace.id);
    assert.equal(inv.hasData, true);
    assert.equal(inv.unconfirmed, 2);
    assert.ok(inv.tools.some((t) => t.flags.includes('never confirmed as still in use')));
    assert.ok(inv.tools.some((t) => t.flags.some((x) => x.includes('not confirmed for'))));
    assert.ok(inv.notes.some((nn) => nn.includes('cannot cancel')));
    f.close();
  });

  test('offers possible overlaps as a question, not a claim', () => {
    const f = makeWorkspace();
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'Notion', amountMinor: 1000, period: 'monthly' });
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'Obsidian', amountMinor: 500, period: 'monthly' });

    const inv = new ResourceEngine(f.store).toolInventory(f.workspace.id);
    const overlap = inv.possibleOverlaps.find((o) => o.group === 'Note-taking');
    assert.ok(overlap, 'note-taking overlap should be detected');
    assert.equal(overlap!.names.length, 2);
    assert.ok(inv.notes.some((nn) => nn.includes('not a confirmed duplication')));
    f.close();
  });

  test('flags a tool attached to a dead project', () => {
    const f = makeWorkspace();
    const p = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Abandoned', lastActivityAt: daysAgo(200) });
    f.store.resources.create({ workspaceId: f.workspace.id, projectId: p.id, kind: 'infrastructure', name: 'Idle database', amountMinor: 2500, period: 'monthly' });

    const inv = new ResourceEngine(f.store).toolInventory(f.workspace.id);
    assert.ok(inv.tools[0]!.flags.some((x) => x.includes('no activity for 90+ days')));
    f.close();
  });
});

describe('project allocation', () => {
  test('identifies a project consuming resources without progress', () => {
    const f = makeWorkspace();
    const p = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Zombie', lastActivityAt: daysAgo(90) });
    f.store.resources.create({ workspaceId: f.workspace.id, projectId: p.id, kind: 'infrastructure', name: 'Server', amountMinor: 4000, period: 'monthly' });

    const rows = new ResourceEngine(f.store).allocation(f.workspace.id);
    const row = rows.find((r) => r.project.id === p.id)!;
    assert.equal(row.verdict, 'consuming-without-progress');
    assert.ok(row.because.some((b) => b.includes('/month')), 'the cost is stated');
    assert.ok(row.because.some((b) => b.includes('30 days')));
    f.close();
  });

  test('identifies blocked, advancing and pause-candidate projects', () => {
    const f = makeWorkspace();
    const engine = new ResourceEngine(f.store);

    const blocked = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Blocked' });
    f.store.tasks.create({ workspaceId: f.workspace.id, projectId: blocked.id, title: 'Waiting', status: 'blocked' });

    const advancing = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Advancing', lastActivityAt: daysAgo(1) });
    for (let i = 0; i < 12; i++) {
      f.store.activity.add({
        workspaceId: f.workspace.id, projectId: advancing.id, connector: 'github', kind: 'commit',
        summary: `c${i}`, url: null, sourceId: null, actor: null, occurredAt: daysAgo(2),
      });
    }

    const dormant = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Dormant', lastActivityAt: daysAgo(200) });

    const rows = engine.allocation(f.workspace.id);
    assert.equal(rows.find((r) => r.project.id === blocked.id)!.verdict, 'blocked');
    assert.equal(rows.find((r) => r.project.id === advancing.id)!.verdict, 'advancing');
    assert.equal(rows.find((r) => r.project.id === dormant.id)!.verdict, 'candidate-to-pause');
    // Most urgent first.
    assert.equal(rows[0]!.verdict, 'blocked');
    f.close();
  });

  test('a brand-new project reports insufficient data, not failure', () => {
    const f = makeWorkspace();
    f.store.projects.create({ workspaceId: f.workspace.id, name: 'Just created' });
    const rows = new ResourceEngine(f.store).allocation(f.workspace.id);
    assert.equal(rows[0]!.verdict, 'insufficient-data');
    f.close();
  });

  test('every verdict carries its reasons', () => {
    const f = makeWorkspace();
    f.store.projects.create({ workspaceId: f.workspace.id, name: 'Any' });
    for (const row of new ResourceEngine(f.store).allocation(f.workspace.id)) {
      assert.ok(row.because.length > 0, `${row.project.name} has a verdict with no stated reason`);
    }
    f.close();
  });
});

describe('four Cs and reviews', () => {
  test('an empty brain grades as empty, not healthy', () => {
    const f = makeWorkspace({ profile: 'custom', modules: ['projects', 'knowledge'] });
    const four = new ReviewEngine(f.store).fourCs(f.workspace.id, f.config);
    assert.equal(four.context.grade, 'empty');
    assert.equal(four.context.measurable, false);
    assert.equal(four.connections.grade, 'empty');
    assert.equal(four.cadence.grade, 'empty');
    assert.ok(four.context.actions.length > 0, 'an empty brain is told what to do first');
    f.close();
  });

  test('context grading improves as records and provenance arrive', () => {
    const f = makeWorkspace();
    const engine = new ReviewEngine(f.store);
    for (let i = 0; i < 12; i++) {
      f.store.knowledge.create({ workspaceId: f.workspace.id, title: `Note ${i}`, body: `content ${i}` });
    }
    const four = engine.fourCs(f.workspace.id, f.config);
    assert.equal(four.context.grade, 'workable');
    assert.ok(four.context.findings.some((x) => x.includes('knowledge record')));
    assert.ok(four.context.gaps.some((g) => g.includes('no source link')), 'untraceable knowledge is reported as a gap');
    f.close();
  });

  test('capabilities reports a module with nothing behind it', () => {
    const f = makeWorkspace({ profile: 'developer' });
    const four = new ReviewEngine(f.store).fourCs(f.workspace.id, f.config);
    assert.ok(
      four.capabilities.gaps.some((g) => g.includes('no code source is connected')),
      'developer intelligence with no source must be reported as not useful yet',
    );
    assert.ok(four.capabilities.findings.some((x) => x.includes('Remote AI is off')));
    f.close();
  });

  test('a review over an empty period says nothing was recorded', () => {
    const f = makeWorkspace();
    const { body } = new ReviewEngine(f.store).runReview(f.workspace.id, 'weekly', f.config);
    assert.ok(body.verifiedProgress[0]!.includes('Nothing was recorded'));
    assert.ok(body.verifiedProgress[0]!.includes('not necessarily that nothing happened'));
    assert.equal(f.store.reports.list(f.workspace.id).length, 1);
    f.close();
  });

  test('a review counts real progress and keeps the report', () => {
    const f = makeWorkspace();
    const p = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Shipping' });
    const t = f.store.tasks.create({ workspaceId: f.workspace.id, projectId: p.id, title: 'Done thing' });
    f.store.tasks.update(f.workspace.id, t.id, { status: 'done' });
    f.store.decisions.create({ workspaceId: f.workspace.id, projectId: p.id, title: 'Chose SQLite', choice: 'SQLite' });

    const { report, body } = new ReviewEngine(f.store).runReview(f.workspace.id, 'weekly', f.config);
    assert.ok(body.verifiedProgress.some((x) => x.includes('1 task(s) completed')));
    assert.equal(body.decisions.length, 1);
    assert.equal(report.origin, 'derived', 'a review is derived, never generated');
    assert.ok(f.store.reports.byId(f.workspace.id, report.id));
    f.close();
  });

  test('cadence notices when reviews fall behind', () => {
    const f = makeWorkspace();
    const engine = new ReviewEngine(f.store);
    f.store.reports.create({
      workspaceId: f.workspace.id, cadence: 'weekly',
      periodStart: daysAgo(60), periodEnd: daysAgo(53), body: {}, origin: 'derived',
    });
    f.store.db.run('UPDATE reports SET created_at = ? WHERE workspace_id = ?', [daysAgo(53), f.workspace.id]);

    const four = engine.fourCs(f.workspace.id, f.config);
    assert.equal(four.cadence.grade, 'thin');
    assert.ok(four.cadence.gaps.some((g) => g.includes('behind a weekly cadence')));
    f.close();
  });
});

describe('dashboard', () => {
  test('every widget on a fresh brain has an empty state with an action', () => {
    const f = makeWorkspace({ profile: 'developer' });
    const data = new DashboardEngine(f.store).build(f.workspace.id, f.config);
    assert.ok(data.widgets.length > 0, 'a fresh brain still renders widgets');
    for (const w of data.widgets) {
      if (w.rows.length === 0) {
        assert.ok(w.empty, `${w.key} is empty but has no empty state`);
        assert.ok(w.empty!.reason.length > 0, `${w.key} does not say why it is empty`);
        assert.ok(w.empty!.action.length > 0, `${w.key} does not say what would fill it`);
      }
    }
    f.close();
  });

  test('widgets are filtered to enabled modules', () => {
    const f = makeWorkspace({ profile: 'custom', modules: ['projects'] });
    const data = new DashboardEngine(f.store).build(f.workspace.id, f.config);
    for (const w of data.widgets) {
      assert.ok(!['resource-usage', 'financial-summary', 'business-summary'].includes(w.key), `${w.key} should not appear`);
    }
    f.close();
  });

  test('counts reflect stored records', () => {
    const f = makeWorkspace({ profile: 'developer' });
    f.store.projects.create({ workspaceId: f.workspace.id, name: 'One' });
    f.store.tasks.create({ workspaceId: f.workspace.id, title: 'Do it' });
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'Know it' });

    const data = new DashboardEngine(f.store).build(f.workspace.id, f.config);
    assert.equal(data.counts.projects, 1);
    assert.equal(data.counts.openTasks, 1);
    assert.equal(data.counts.knowledge, 1);
    assert.equal(data.counts.connections, 0);
    f.close();
  });

  test('a discovered project is marked uncertain in its widget', () => {
    const f = makeWorkspace({ profile: 'developer' });
    f.store.projects.create({
      workspaceId: f.workspace.id, name: 'Maybe mine', origin: 'connector',
      reviewState: 'pending-review', matchScore: 0.6, sourceKey: 'github:x',
    });
    const data = new DashboardEngine(f.store).build(f.workspace.id, f.config);
    const widget = data.widgets.find((w) => w.key === 'discovered-projects')!;
    assert.equal(widget.rows.length, 1);
    assert.equal(widget.rows[0]!.uncertain, true);
    assert.ok(widget.footnote?.includes('until you confirm it'));
    f.close();
  });
});

describe('assistant', () => {
  test('answers without any AI provider configured', () => {
    const f = makeWorkspace();
    const a = new AssistantEngine(f.store);
    const answer = a.ask(f.workspace.id, 'What did I accomplish this week?', f.config);
    assert.ok(answer.text.length > 0);
    assert.equal(answer.certainty, 'insufficient-data');
    assert.ok(answer.caveats.some((c) => c.includes('what was captured')));
    f.close();
  });

  test('cites its sources for a grounded answer', () => {
    const f = makeWorkspace();
    const t = f.store.tasks.create({ workspaceId: f.workspace.id, title: 'Finished thing' });
    f.store.tasks.update(f.workspace.id, t.id, { status: 'done' });

    const answer = new AssistantEngine(f.store).ask(f.workspace.id, 'What did I accomplish this week?', f.config);
    assert.equal(answer.certainty, 'grounded');
    assert.ok(answer.citations.length > 0, 'every grounded answer cites something');
    assert.ok(answer.citations.every((c) => c.source.length > 0));
    f.close();
  });

  test('says it cannot answer when the data is missing, rather than guessing', () => {
    const f = makeWorkspace();
    const answer = new AssistantEngine(f.store).ask(f.workspace.id, 'Which development projects have failing tests?', f.config);
    assert.equal(answer.certainty, 'insufficient-data');
    assert.ok(answer.caveats.some((c) => c.includes('ci_pass_rate')));
    f.close();
  });

  test('answers the failing-tests question from observed CI data', () => {
    const f = makeWorkspace();
    const p = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Flaky', category: 'software' });
    f.store.metrics.record({
      workspaceId: f.workspace.id, projectId: p.id, key: 'ci_pass_rate', label: 'CI pass rate',
      value: 62, unit: '%', origin: 'connector', sourceId: null, target: 100, observedAt: daysAgo(1),
    });
    const answer = new AssistantEngine(f.store).ask(f.workspace.id, 'Which projects have failing tests?', f.config);
    assert.equal(answer.certainty, 'grounded');
    assert.ok(answer.bullets[0]!.includes('62%'));
    assert.ok(answer.citations[0]!.source.includes('GitHub Actions'));
    f.close();
  });

  test('refuses questions outside its own records', () => {
    const f = makeWorkspace();
    const answer = new AssistantEngine(f.store).ask(f.workspace.id, 'Who won the 1998 world cup?', f.config);
    assert.equal(answer.certainty, 'out-of-scope');
    assert.ok(answer.caveats.some((c) => c.includes('does not know anything about the world')));
    assert.ok(answer.suggestions.length > 0, 'it offers what it can do instead');
    f.close();
  });

  test('answers recurring expenses from recorded costs only', () => {
    const f = makeWorkspace();
    f.store.resources.create({ workspaceId: f.workspace.id, kind: 'subscription', name: 'Hosting', amountMinor: 2000, period: 'monthly' });
    const answer = new AssistantEngine(f.store).ask(f.workspace.id, 'What are my recurring expenses?', f.config);
    assert.equal(answer.certainty, 'grounded');
    assert.ok(answer.text.includes('$20'));
    assert.ok(answer.caveats.some((c) => c.includes('cannot see your bank')));
    f.close();
  });

  test('every documented capability produces an answer', () => {
    const f = makeWorkspace();
    const a = new AssistantEngine(f.store);
    for (const q of a.capabilities()) {
      const answer = a.ask(f.workspace.id, q, f.config);
      assert.ok(answer.text.length > 0, `no answer for: ${q}`);
      // Falling through to the search fallback means the question is
      // advertised but not actually implemented.
      assert.notEqual(answer.intent, 'search', `"${q}" fell through to generic search`);
      assert.ok(
        ['grounded', 'derived', 'insufficient-data'].includes(answer.certainty),
        `"${q}" returned ${answer.certainty}, so the question is not actually supported`,
      );
    }
    f.close();
  });

  test('a retrieval answer labels generated and conflicting records', () => {
    const f = makeWorkspace();
    f.store.knowledge.create({
      workspaceId: f.workspace.id, title: 'Kubernetes migration plan',
      body: 'A model wrote this plan for migrating to kubernetes.', origin: 'generated', confidence: 'low',
    });
    const answer = new AssistantEngine(f.store).ask(f.workspace.id, 'kubernetes migration', f.config);
    assert.ok(answer.caveats.some((c) => c.includes('model-generated')));
    f.close();
  });
});
