/**
 * The AI BRAIN assistant.
 *
 * Answers are *retrieved and computed*, never written by a model. An intent is
 * matched from the question, the relevant records are read, and the answer is
 * assembled from them with a citation for every claim and an explicit
 * uncertainty label. This is why the assistant works with no API key, no
 * network and no cost.
 *
 * An AI provider, if the user configures one, is only allowed to rephrase an
 * answer this engine already produced (see ai/narrate.ts). It never gets to
 * decide what is true, and it is never required for an answer to exist.
 */

import type { BrainConfiguration, Id, KnowledgeClass } from '../domain/types.ts';
import type { Store } from '../db/repositories.ts';
import { nowIso, relativeLabel, daysBetween, periodFor } from '../util/time.ts';
import { ResourceEngine, VERDICT_LABELS } from './resources.ts';
import { KnowledgeEngine } from './knowledge.ts';
import { formatMoney } from './passport.ts';
import { ReviewEngine } from './review.ts';

export type AnswerCertainty =
  /** Every figure comes from a stored record. */
  | 'grounded'
  /** Computed from stored records by a stated rule. */
  | 'derived'
  /** Answerable in principle, but the records needed are missing. */
  | 'insufficient-data'
  /** The question is outside what this system can see. */
  | 'out-of-scope';

export interface Citation {
  label: string;
  /** Where the number came from: a table and a filter, in plain language. */
  source: string;
  href?: string;
  observedAt?: string;
}

export interface Answer {
  question: string;
  intent: string;
  /** The answer, already written. Plain sentences, no markdown headings. */
  text: string;
  bullets: string[];
  certainty: AnswerCertainty;
  citations: Citation[];
  /** What the answer could not cover, stated rather than omitted. */
  caveats: string[];
  /** Follow-up questions this engine can also answer. */
  suggestions: string[];
}

interface Intent {
  key: string;
  re: RegExp;
  run: (ctx: AnswerContext) => Answer;
}

interface AnswerContext {
  store: Store;
  workspaceId: Id;
  question: string;
  config: BrainConfiguration | null;
  resources: ResourceEngine;
  knowledge: KnowledgeEngine;
  review: ReviewEngine;
}

export class AssistantEngine {
  private readonly store: Store;
  private readonly resources: ResourceEngine;
  private readonly knowledge: KnowledgeEngine;
  private readonly review: ReviewEngine;

  constructor(store: Store) {
    this.store = store;
    this.resources = new ResourceEngine(store);
    this.knowledge = new KnowledgeEngine(store);
    this.review = new ReviewEngine(store);
  }

  ask(workspaceId: Id, question: string, config: BrainConfiguration | null): Answer {
    const q = question.trim();
    const ctx: AnswerContext = {
      store: this.store, workspaceId, question: q, config,
      resources: this.resources, knowledge: this.knowledge, review: this.review,
    };
    for (const intent of INTENTS) {
      if (intent.re.test(q)) return intent.run(ctx);
    }
    return searchFallback(ctx);
  }

  /** The questions this engine can answer, for the UI to offer. */
  capabilities(): string[] {
    return [
      'What did I accomplish this week?',
      'What new projects were created?',
      'Which projects have not progressed?',
      'What needs my attention today?',
      'Where am I spending the most resources?',
      'What are my recurring expenses?',
      'Which development projects have failing tests?',
      'What major decisions did I make last month?',
      'What should I prioritise next?',
      'Where can I reduce costs?',
      'What information is missing from my operating system?',
    ];
  }
}

/* ---------------------------------------------------------------- */
/* Intents                                                           */
/* ---------------------------------------------------------------- */

const INTENTS: Intent[] = [
  {
    key: 'accomplished',
    re: /\b(accomplish|achieve|get done|got done|complete[d]?|finish|ship)\b/i,
    run: (ctx) => {
      const window = windowFromQuestion(ctx.question);
      const { start, end } = periodFor(window.cadence);
      const done = ctx.store.tasks.completedBetween(ctx.workspaceId, start, end);
      const activity = ctx.store.activity.recent(ctx.workspaceId, { since: start, limit: 500 });
      const knowledge = ctx.store.knowledge.list(ctx.workspaceId, { limit: 2000 }).filter((k) => k.createdAt >= start);
      const decisions = ctx.store.decisions.list(ctx.workspaceId, { since: start, limit: 100 });

      const bullets: string[] = [];
      if (done.length) bullets.push(`${done.length} task(s) completed${done[0] ? `, most recently "${done[0].title}"` : ''}.`);
      if (activity.length) bullets.push(`${activity.length} activity event(s) recorded from ${new Set(activity.map((a) => a.connector)).size} source(s).`);
      if (knowledge.length) bullets.push(`${knowledge.length} knowledge record(s) added.`);
      if (decisions.length) bullets.push(`${decisions.length} decision(s) recorded.`);

      if (bullets.length === 0) {
        return {
          question: ctx.question, intent: 'accomplished',
          text: `Nothing was recorded in the last ${window.label}.`,
          bullets: [],
          certainty: 'insufficient-data',
          citations: [],
          caveats: [
            'This reflects what was captured, not what you actually did.',
            'Complete tasks here, or connect a source, for this answer to mean anything.',
          ],
          suggestions: ['What information is missing from my operating system?'],
        };
      }

      return {
        question: ctx.question, intent: 'accomplished',
        text: `In the last ${window.label}, these things were recorded in your brain.`,
        bullets,
        certainty: 'grounded',
        citations: [
          { label: `${done.length} completed task(s)`, source: `tasks completed between ${start.slice(0, 10)} and ${end.slice(0, 10)}`, href: '/tasks' },
          { label: `${activity.length} activity event(s)`, source: 'activity events in the same window', href: '/activity' },
        ],
        caveats: ['Only recorded work is counted. Anything not captured here is invisible to this answer.'],
        suggestions: ['Which projects have not progressed?', 'What should I prioritise next?'],
      };
    },
  },

  {
    key: 'new-projects',
    re: /\b(new|newly|recently)\s+(project|repo|repositor)/i,
    run: (ctx) => {
      const window = windowFromQuestion(ctx.question);
      const { start } = periodFor(window.cadence);
      const all = ctx.store.projects.list(ctx.workspaceId, { limit: 1000, reviewState: ['confirmed', 'pending-review'] });
      const fresh = all.filter((p) => p.createdAt >= start);
      if (fresh.length === 0) {
        return {
          question: ctx.question, intent: 'new-projects',
          text: `No projects were created in the last ${window.label}.`,
          bullets: [], certainty: 'grounded',
          citations: [{ label: `${all.length} project(s) total`, source: 'projects table', href: '/projects' }],
          caveats: all.length === 0 ? ['You have no projects at all yet.'] : [],
          suggestions: ['Which projects have not progressed?'],
        };
      }
      const pending = fresh.filter((p) => p.reviewState === 'pending-review');
      return {
        question: ctx.question, intent: 'new-projects',
        text: `${fresh.length} project(s) appeared in the last ${window.label}.`,
        bullets: fresh.slice(0, 12).map(
          (p) => `${p.name} — ${p.origin === 'connector' ? `discovered from ${p.sourceKey?.split(':')[0] ?? 'a connector'}` : 'added by you'}${p.reviewState === 'pending-review' ? ` (awaiting review, confidence ${p.matchScore.toFixed(2)})` : ''}`,
        ),
        certainty: 'grounded',
        citations: fresh.slice(0, 8).map((p) => ({
          label: p.name, source: p.sourceKey ? `source key ${p.sourceKey}` : 'created manually',
          href: `/projects/${p.slug}`, observedAt: p.createdAt,
        })),
        caveats: pending.length > 0 ? [`${pending.length} of these have not been confirmed by you yet.`] : [],
        suggestions: ['What needs my attention today?'],
      };
    },
  },

  {
    key: 'stalled',
    re: /\b(?:not|no|never)\s+progress(?:ed|ing|es)?\b|\b(?:stalled|stuck|stale|idle|abandoned|dormant|neglected)\b|\bhaven'?t\s+touched\b/i,
    run: (ctx) => {
      const rows = ctx.resources.allocation(ctx.workspaceId);
      const stalled = rows.filter((r) => ['candidate-to-pause', 'consuming-without-progress', 'blocked'].includes(r.verdict));
      if (rows.length === 0) {
        return emptyAnswer(ctx, 'stalled', 'You have no projects recorded, so nothing can be assessed.', ['Add a project.']);
      }
      if (stalled.length === 0) {
        return {
          question: ctx.question, intent: 'stalled',
          text: `All ${rows.length} project(s) show some recorded movement.`,
          bullets: [], certainty: 'derived',
          citations: [{ label: `${rows.length} project(s) assessed`, source: 'activity, completed tasks and logged time over 30 days', href: '/resources/allocation' }],
          caveats: ['Movement means recorded movement, not necessarily meaningful progress.'],
          suggestions: ['Where am I spending the most resources?'],
        };
      }
      return {
        question: ctx.question, intent: 'stalled',
        text: `${stalled.length} of ${rows.length} project(s) are not moving.`,
        bullets: stalled.slice(0, 10).map((r) => `${r.project.name} — ${VERDICT_LABELS[r.verdict]}: ${r.because.join('; ')}.`),
        certainty: 'derived',
        citations: stalled.slice(0, 8).map((r) => ({
          label: r.project.name,
          source: `${r.activity30d} activity event(s) in 30 days, ${(r.loggedMinutes / 60).toFixed(1)} h logged, ${r.openTasks} open task(s)`,
          href: `/projects/${r.project.slug}`,
          ...(r.project.lastActivityAt ? { observedAt: r.project.lastActivityAt } : {}),
        })),
        caveats: ['These verdicts come from fixed rules over recorded data. Work you did not record looks like inactivity.'],
        suggestions: ['Where can I reduce costs?', 'What should I prioritise next?'],
      };
    },
  },

  {
    key: 'attention',
    re: /\b(attention|today|urgent|right now|first|most important)\b/i,
    run: (ctx) => {
      const now = nowIso();
      const bullets: string[] = [];
      const citations: Citation[] = [];

      const blocked = ctx.store.tasks.list(ctx.workspaceId, { status: ['blocked'], limit: 20 });
      if (blocked.length) {
        bullets.push(`${blocked.length} blocked task(s): ${blocked.slice(0, 3).map((t) => `"${t.title}"`).join(', ')}.`);
        citations.push({ label: 'blocked tasks', source: 'tasks with status "blocked"', href: '/tasks' });
      }
      const overdue = ctx.store.tasks.list(ctx.workspaceId, { status: ['todo', 'doing'], limit: 300 }).filter((t) => t.dueAt && t.dueAt < now);
      if (overdue.length) {
        bullets.push(`${overdue.length} overdue task(s), the earliest due ${overdue.sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))[0]!.dueAt!.slice(0, 10)}.`);
        citations.push({ label: 'overdue tasks', source: 'open tasks with a due date in the past', href: '/tasks' });
      }
      const pending = ctx.store.projects.list(ctx.workspaceId, { reviewState: ['pending-review'], limit: 100 });
      if (pending.length) {
        bullets.push(`${pending.length} discovered project(s) waiting for you to confirm or reject.`);
        citations.push({ label: 'review queue', source: 'projects with review state "pending-review"', href: '/projects/review' });
      }
      const brokenConnections = ctx.store.accounts.list(ctx.workspaceId).filter((a) => a.status === 'error');
      if (brokenConnections.length) {
        bullets.push(`${brokenConnections.length} connection(s) are failing: ${brokenConnections.map((a) => a.connector).join(', ')}.`);
        citations.push({ label: 'failing connections', source: 'connected accounts with status "error"', href: '/integrations' });
      }
      const atRisk = ctx.store.goals.list(ctx.workspaceId).filter((g) => g.status === 'at-risk');
      if (atRisk.length) {
        bullets.push(`${atRisk.length} goal(s) marked at risk.`);
        citations.push({ label: 'goals at risk', source: 'goals with status "at-risk"', href: '/goals' });
      }
      const conflicts = ctx.knowledge.contradictions(ctx.workspaceId);
      if (conflicts.length) {
        bullets.push(`${conflicts.length} knowledge record(s) conflict with another record.`);
        citations.push({ label: 'conflicting knowledge', source: 'knowledge records with a contradiction link', href: '/knowledge' });
      }

      if (bullets.length === 0) {
        return {
          question: ctx.question, intent: 'attention',
          text: 'Nothing in your brain is flagged as needing attention.',
          bullets: [], certainty: 'derived',
          citations: [{ label: 'checks run', source: 'blocked and overdue tasks, review queue, connection health, goals at risk, knowledge conflicts' }],
          caveats: ['This only checks the things AI BRAIN can see.'],
          suggestions: ['What should I prioritise next?'],
        };
      }
      return {
        question: ctx.question, intent: 'attention',
        text: 'These things are flagged right now.',
        bullets, certainty: 'derived', citations,
        caveats: ['Ordered by category, not by importance to you.'],
        suggestions: ['What should I prioritise next?', 'Which projects have not progressed?'],
      };
    },
  },

  {
    key: 'resource-spend',
    re: /\b(spend|spending|where.*(time|money|resources)|most (time|resources|money)|allocat)/i,
    run: (ctx) => {
      const time = ctx.resources.timeReport(ctx.workspaceId, 30);
      const cost = ctx.resources.costReport(ctx.workspaceId);
      const bullets: string[] = [];
      const citations: Citation[] = [];

      if (time.hasData) {
        bullets.push(`${(time.totalMinutes / 60).toFixed(1)} h logged over 30 days across ${time.byProject.length} project(s).`);
        for (const p of time.byProject.slice(0, 5)) bullets.push(`${p.projectName}: ${(p.minutes / 60).toFixed(1)} h (${p.share}%).`);
        citations.push({ label: 'time entries', source: 'explicitly logged time over the last 30 days', href: '/resources' });
      } else {
        bullets.push('No time has been logged, so time allocation cannot be answered.');
      }

      if (cost.hasData) {
        bullets.push(`${formatMoney(cost.monthlyRecurringMinor, cost.currency)} per month in recorded recurring costs.`);
        for (const p of cost.byProject.slice(0, 5)) {
          if (p.monthlyMinor > 0) bullets.push(`${p.projectName}: ${formatMoney(p.monthlyMinor, cost.currency)} / month.`);
        }
        citations.push({ label: 'cost records', source: 'active resources with a recorded amount', href: '/resources' });
      } else {
        bullets.push('No costs have been recorded, so financial allocation cannot be answered.');
      }

      return {
        question: ctx.question, intent: 'resource-spend',
        text: time.hasData || cost.hasData ? 'Here is where your recorded resources went.' : 'There is nothing recorded to answer this from.',
        bullets,
        certainty: time.hasData || cost.hasData ? 'grounded' : 'insufficient-data',
        citations,
        caveats: [
          'Time spent with an application open is not counted; only time you logged.',
          ...(cost.notes.filter((nn) => nn.includes('currency'))),
        ],
        suggestions: ['Where can I reduce costs?', 'What are my recurring expenses?'],
      };
    },
  },

  {
    key: 'recurring-expenses',
    re: /\b(recurring|subscription|monthly cost|expenses?|bills?)\b/i,
    run: (ctx) => {
      const cost = ctx.resources.costReport(ctx.workspaceId);
      if (!cost.hasData) {
        return emptyAnswer(ctx, 'recurring-expenses', 'No costs have been recorded yet.', ['Add a subscription or infrastructure cost under Resources.']);
      }
      const items = ctx.store.resources
        .list(ctx.workspaceId, { activeOnly: true })
        .filter((r) => r.amountMinor !== null && (r.period === 'monthly' || r.period === 'yearly'))
        .sort((a, b) => (b.amountMinor ?? 0) - (a.amountMinor ?? 0));
      return {
        question: ctx.question, intent: 'recurring-expenses',
        text: `${formatMoney(cost.monthlyRecurringMinor, cost.currency)} per month, or about ${formatMoney(cost.yearlyRecurringMinor, cost.currency)} a year, across ${items.length} recorded item(s).`,
        bullets: items.slice(0, 15).map((r) => `${r.name}: ${formatMoney(r.amountMinor!, r.currency)} / ${r.period}${r.lastConfirmedAt ? ` (confirmed ${relativeLabel(r.lastConfirmedAt)})` : ' (never confirmed)'}.`),
        certainty: 'grounded',
        citations: [{ label: `${items.length} recurring item(s)`, source: 'resources with a monthly or yearly period and no end date', href: '/resources' }],
        caveats: [
          'These are the costs you entered. AI BRAIN cannot see your bank or card statements.',
          'It also cannot cancel anything — that has to be done with the provider.',
        ],
        suggestions: ['Where can I reduce costs?'],
      };
    },
  },

  {
    key: 'failing-tests',
    re: /\b(?:fail|fails|failed|failing|broken|red)\b[^.?!]*\b(?:tests?|ci|builds?|pipelines?|suites?)\b|\b(?:tests?|ci|builds?|pipelines?)\b[^.?!]*\b(?:fail|fails|failed|failing|broken|red)\b/i,
    run: (ctx) => {
      const projects = ctx.store.projects.list(ctx.workspaceId, { limit: 500 });
      const failing: Array<{ name: string; slug: string; value: number; observedAt: string }> = [];
      let withData = 0;
      for (const p of projects) {
        const ci = ctx.store.metrics.latest(ctx.workspaceId, p.id).find((m) => m.key === 'ci_pass_rate');
        if (!ci) continue;
        withData++;
        if (ci.value < 100) failing.push({ name: p.name, slug: p.slug, value: ci.value, observedAt: ci.observedAt });
      }
      if (withData === 0) {
        return {
          question: ctx.question, intent: 'failing-tests',
          text: 'No CI or test results have been observed, so this cannot be answered.',
          bullets: [], certainty: 'insufficient-data',
          citations: [],
          caveats: [
            `None of your ${projects.length} project(s) has a recorded ci_pass_rate metric.`,
            'Connect GitHub and sync; CI results come from GitHub Actions runs on the default branch.',
          ],
          suggestions: ['Which projects have not progressed?'],
        };
      }
      if (failing.length === 0) {
        return {
          question: ctx.question, intent: 'failing-tests',
          text: `All ${withData} project(s) with observed CI data are passing.`,
          bullets: [], certainty: 'grounded',
          citations: [{ label: `${withData} project(s) with CI data`, source: 'ci_pass_rate metric observed from GitHub Actions' }],
          caveats: [`${projects.length - withData} project(s) have no CI data at all, so they are not covered by this answer.`],
          suggestions: ['What needs my attention today?'],
        };
      }
      return {
        question: ctx.question, intent: 'failing-tests',
        text: `${failing.length} of ${withData} project(s) with CI data are not fully passing.`,
        bullets: failing.map((f) => `${f.name}: ${f.value}% of sampled runs passed (observed ${relativeLabel(f.observedAt)}).`),
        certainty: 'grounded',
        citations: failing.map((f) => ({ label: f.name, source: 'ci_pass_rate from recent GitHub Actions runs on the default branch', href: `/projects/${f.slug}`, observedAt: f.observedAt })),
        caveats: [
          'The pass rate samples recent runs on the default branch, not every run ever.',
          `${projects.length - withData} project(s) have no CI data and are not covered.`,
        ],
        suggestions: ['What needs my attention today?'],
      };
    },
  },

  {
    key: 'decisions',
    re: /\b(?:decisions?|decided|decide|chose|choices?|rationale)\b/i,
    run: (ctx) => {
      const window = windowFromQuestion(ctx.question, 'monthly');
      const { start } = periodFor(window.cadence);
      const decisions = ctx.store.decisions.list(ctx.workspaceId, { since: start, limit: 100 });
      if (decisions.length === 0) {
        const total = ctx.store.decisions.list(ctx.workspaceId, { limit: 1 }).length;
        return emptyAnswer(
          ctx, 'decisions',
          `No decisions were recorded in the last ${window.label}.`,
          total === 0 ? ['You have no decision records at all. Recording them is what makes reviews useful later.'] : [],
        );
      }
      return {
        question: ctx.question, intent: 'decisions',
        text: `${decisions.length} decision(s) recorded in the last ${window.label}.`,
        bullets: decisions.map((d) => {
          const project = d.projectId ? ctx.store.projects.byId(ctx.workspaceId, d.projectId)?.name : null;
          return `${d.decidedAt.slice(0, 10)} — ${d.title}${project ? ` (${project})` : ''}: chose ${d.choice || 'unrecorded'}${d.status !== 'accepted' ? ` [${d.status}]` : ''}.`;
        }),
        certainty: 'grounded',
        citations: decisions.slice(0, 10).map((d) => ({ label: d.title, source: 'decision record', href: `/decisions/${d.id}`, observedAt: d.decidedAt })),
        caveats: decisions.filter((d) => d.outcome.trim() === '').length > 0
          ? [`${decisions.filter((d) => d.outcome.trim() === '').length} of these have no recorded outcome, so you cannot yet tell whether they worked.`]
          : [],
        suggestions: ['What did I accomplish this week?'],
      };
    },
  },

  {
    key: 'prioritise',
    re: /\b(priorit|what should i|what next|next step|focus on)\b/i,
    run: (ctx) => {
      const review = ctx.review.buildReview(ctx.workspaceId, 'weekly', ctx.config);
      const bullets = review.topActions;
      return {
        question: ctx.question, intent: 'prioritise',
        text: bullets.length > 0 && bullets[0] !== 'Nothing is flagged. Keep going.'
          ? 'Based on your records, these are the highest-value next actions.'
          : 'Nothing in your records is flagged as needing action.',
        bullets,
        certainty: 'derived',
        citations: [
          { label: 'Context assessment', source: review.fourCs.context.findings.join(' ') },
          { label: 'Connections assessment', source: review.fourCs.connections.findings.join(' ') },
        ],
        caveats: [
          'These are rule-based priorities over what is recorded. They cannot know what matters most to you today.',
        ],
        suggestions: ['What needs my attention today?', 'What information is missing from my operating system?'],
      };
    },
  },

  {
    key: 'reduce-costs',
    re: /\b(?:reduce|cut|save|lower|cheaper|optimi[sz]e|trim)\b[^.?!]*\b(?:costs?|spend(?:ing)?|money|expenses?|subscriptions?|bills?|burn)\b/i,
    run: (ctx) => {
      const cost = ctx.resources.costReport(ctx.workspaceId);
      const tools = ctx.resources.toolInventory(ctx.workspaceId);
      const allocation = ctx.resources.allocation(ctx.workspaceId);
      if (!cost.hasData) {
        return emptyAnswer(ctx, 'reduce-costs', 'No costs are recorded, so there is nothing to analyse.', ['Record your subscriptions and infrastructure costs first.']);
      }
      const bullets: string[] = [];
      const citations: Citation[] = [];

      const idle = allocation.filter((r) => r.verdict === 'consuming-without-progress');
      for (const r of idle) {
        bullets.push(`${r.project.name} has ${formatMoney(r.monthlyCostMinor, cost.currency)}/month attached but no recorded progress in 30 days.`);
        citations.push({ label: r.project.name, source: r.because.join('; '), href: `/projects/${r.project.slug}` });
      }
      for (const t of tools.tools.filter((x) => x.flags.length > 0 && x.monthlyMinor > 0).slice(0, 6)) {
        bullets.push(`${t.resource.name} (${formatMoney(t.monthlyMinor, t.resource.currency)}/month): ${t.flags.join('; ')}.`);
        citations.push({ label: t.resource.name, source: 'resource record flags', href: '/resources' });
      }
      for (const o of tools.possibleOverlaps) {
        bullets.push(`Possible overlap in ${o.group}: ${o.names.join(', ')}. Worth checking whether you need all of them.`);
      }
      for (const a of cost.anomalies) {
        bullets.push(`${a.resource.name}: ${a.reason}.`);
      }

      if (bullets.length === 0) {
        return {
          question: ctx.question, intent: 'reduce-costs',
          text: `Nothing stands out across ${formatMoney(cost.monthlyRecurringMinor, cost.currency)}/month of recorded cost.`,
          bullets: [], certainty: 'derived',
          citations: [{ label: 'cost report', source: 'active resources with recorded amounts', href: '/resources' }],
          caveats: ['Only recorded costs are examined, and overlap detection matches on tool names.'],
          suggestions: ['What are my recurring expenses?'],
        };
      }
      return {
        question: ctx.question, intent: 'reduce-costs',
        text: `Across ${formatMoney(cost.monthlyRecurringMinor, cost.currency)}/month of recorded cost, these are worth a look.`,
        bullets, certainty: 'derived', citations,
        caveats: [
          'These are questions raised by your own records, not confirmed waste.',
          'AI BRAIN cannot cancel or change any subscription.',
        ],
        suggestions: ['Where am I spending the most resources?'],
      };
    },
  },

  {
    key: 'missing-information',
    re: /\b(missing|gap|incomplete|what don'?t|blind spot|quality)\b/i,
    run: (ctx) => {
      const four = ctx.review.fourCs(ctx.workspaceId, ctx.config);
      const gaps = [
        ...four.context.gaps.map((g) => `Context: ${g}`),
        ...four.connections.gaps.map((g) => `Connections: ${g}`),
        ...four.capabilities.gaps.map((g) => `Capabilities: ${g}`),
        ...four.cadence.gaps.map((g) => `Cadence: ${g}`),
      ];
      return {
        question: ctx.question, intent: 'missing-information',
        text: gaps.length > 0
          ? `${gaps.length} gap(s) in what your brain can see.`
          : 'No gaps detected across the four dimensions.',
        bullets: gaps,
        certainty: 'derived',
        citations: [
          { label: `Context: ${four.context.grade}`, source: four.context.findings.join(' ') },
          { label: `Connections: ${four.connections.grade}`, source: four.connections.findings.join(' ') },
          { label: `Capabilities: ${four.capabilities.grade}`, source: four.capabilities.findings.join(' ') },
          { label: `Cadence: ${four.cadence.grade}`, source: four.cadence.findings.join(' ') },
        ],
        caveats: ['This is a self-assessment of recorded data. It cannot know about information you never gave it.'],
        suggestions: ['What should I prioritise next?'],
      };
    },
  },
];

/* ---------------------------------------------------------------- */
/* Fallback: grounded search                                         */
/* ---------------------------------------------------------------- */

function searchFallback(ctx: AnswerContext): Answer {
  const hits = ctx.store.knowledge.search(ctx.workspaceId, ctx.question, { limit: 6 });
  const projects = ctx.store.projects.list(ctx.workspaceId, { search: keyTerm(ctx.question), limit: 5 });

  if (hits.length === 0 && projects.length === 0) {
    return {
      question: ctx.question, intent: 'search',
      text: 'Nothing in your brain matches that question.',
      bullets: [], certainty: 'out-of-scope',
      citations: [],
      caveats: [
        'This assistant answers only from records in this workspace. It does not know anything about the world.',
        'Try one of the questions it can answer, or import more of your own material.',
      ],
      suggestions: new AssistantEngine(ctx.store).capabilities().slice(0, 4),
    };
  }

  const bullets: string[] = [];
  const citations: Citation[] = [];
  for (const h of hits) {
    bullets.push(`${h.record.title} (${h.record.klass}): ${h.snippet}`);
    citations.push({
      label: h.record.title,
      source: `knowledge record, origin "${h.record.origin}", confidence "${h.record.confidence}"`,
      href: `/knowledge/${h.record.id}`,
      observedAt: h.record.observedAt,
    });
  }
  for (const p of projects) {
    bullets.push(`Project: ${p.name} — ${p.description || 'no description recorded'}.`);
    citations.push({ label: p.name, source: 'project record', href: `/projects/${p.slug}` });
  }

  const generated = hits.filter((h) => h.record.origin === 'generated').length;
  const conflicting = hits.filter((h) => h.record.contradictsId !== null).length;

  return {
    question: ctx.question, intent: 'search',
    text: `Found ${hits.length} knowledge record(s) and ${projects.length} project(s) matching that.`,
    bullets, certainty: 'grounded', citations,
    caveats: [
      'This is a retrieval answer: the records are shown as they are, not interpreted.',
      ...(generated > 0 ? [`${generated} of these were model-generated and are not verified facts.`] : []),
      ...(conflicting > 0 ? [`${conflicting} of these conflict with another record.`] : []),
    ],
    suggestions: ['What needs my attention today?'],
  };
}

function emptyAnswer(ctx: AnswerContext, intent: string, text: string, caveats: string[]): Answer {
  return {
    question: ctx.question, intent, text, bullets: [],
    certainty: 'insufficient-data', citations: [], caveats,
    suggestions: ['What information is missing from my operating system?'],
  };
}

function windowFromQuestion(q: string, fallback: 'daily' | 'weekly' | 'monthly' | 'quarterly' = 'weekly'): {
  cadence: 'daily' | 'weekly' | 'monthly' | 'quarterly';
  label: string;
} {
  if (/\btoday\b|\byesterday\b|\b24 hours\b/i.test(q)) return { cadence: 'daily', label: 'day' };
  if (/\bthis week\b|\blast week\b|\b7 days\b|\bweekly\b/i.test(q)) return { cadence: 'weekly', label: 'week' };
  if (/\bthis month\b|\blast month\b|\b30 days\b|\bmonthly\b/i.test(q)) return { cadence: 'monthly', label: 'month' };
  if (/\bquarter\b|\b90 days\b|\b3 months\b/i.test(q)) return { cadence: 'quarterly', label: 'quarter' };
  return { cadence: fallback, label: fallback === 'monthly' ? 'month' : fallback === 'daily' ? 'day' : fallback === 'quarterly' ? 'quarter' : 'week' };
}

/** Longest meaningful word, used as a search needle for the fallback. */
function keyTerm(q: string): string {
  const words = q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 3);
  return words.sort((a, b) => b.length - a.length)[0] ?? q.slice(0, 20);
}

export type { KnowledgeClass, Id as WorkspaceId };
export { daysBetween };
