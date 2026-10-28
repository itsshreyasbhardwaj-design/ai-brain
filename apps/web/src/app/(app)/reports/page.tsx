import { requireContext, engines } from '@/lib/server';
import { runReviewAction } from '@/lib/actions';
import { Panel, Chip, ActionForm, Field, SubmitButton, EmptyState, Disclosure } from '@/components/ui';
import { GRADE_LABELS, relativeLabel } from '@ai-brain/core';
import type { ReviewBody } from '@ai-brain/core/engines';

export const metadata = { title: 'Reviews' };

export default async function ReportsPage() {
  const ctx = await requireContext();
  const { reviews } = engines(ctx.store);
  const reports = ctx.store.reports.list(ctx.workspace.id, 20);
  const four = reviews.fourCs(ctx.workspace.id, ctx.config);
  const latest = reports[0] ? (reports[0].body as unknown as ReviewBody) : null;

  const gradeTone = (g: string) => (g === 'strong' ? 'verified' : g === 'workable' ? 'neutral' : 'uncertain');

  return (
    <div className="max-w-4xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display-sm">Reviews</h1>
          <p className="mt-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Computed from your records by fixed rules. No AI provider is involved, and nothing runs on a
            schedule — you run them.
          </p>
        </div>
        <ActionForm action={runReviewAction} className="flex items-end gap-2">
          <Field label="Period" name="cadence" defaultValue={ctx.config?.reportingCadence === 'manual' ? 'weekly' : ctx.config?.reportingCadence ?? 'weekly'} options={[
            { value: 'daily', label: 'Day' }, { value: 'weekly', label: 'Week' },
            { value: 'monthly', label: 'Month' }, { value: 'quarterly', label: 'Quarter' },
          ]} />
          <SubmitButton>Run a review</SubmitButton>
        </ActionForm>
      </header>

      <div className="grid-12 mb-6">
        {[four.context, four.connections, four.capabilities, four.cadence].map((a) => (
          <Panel key={a.key} title={a.label} span={3}>
            <Chip tone={gradeTone(a.grade)}>{GRADE_LABELS[a.grade]}</Chip>
            {!a.measurable && (
              <p className="mt-2 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
                Not enough recorded to judge this yet.
              </p>
            )}
            <ul className="mt-2.5 space-y-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              {a.findings.slice(0, 3).map((f, i) => <li key={i}>· {f}</li>)}
            </ul>
            {a.gaps.length > 0 && (
              <ul className="mt-2 space-y-1 text-[11px]" style={{ color: 'var(--uncertain)' }}>
                {a.gaps.slice(0, 2).map((g, i) => <li key={i}>· {g}</li>)}
              </ul>
            )}
            {a.actions.length > 0 && (
              <ul className="mt-2 space-y-1 text-[11px]" style={{ color: 'var(--accent)' }}>
                {a.actions.slice(0, 2).map((x, i) => <li key={i}>→ {x}</li>)}
              </ul>
            )}
          </Panel>
        ))}
      </div>

      {latest ? (
        <Panel
          title={`Latest review · ${latest.cadence}`}
          subtitle={`${latest.periodStart.slice(0, 10)} to ${latest.periodEnd.slice(0, 10)} · run ${relativeLabel(reports[0]!.createdAt)}`}
          className="mb-4"
        >
          {([
            ['Verified progress', latest.verifiedProgress],
            ['Recent changes', latest.recentChanges],
            ['Bottlenecks', latest.bottlenecks],
            ['Resource use', latest.resourceUtilisation],
            ['Data quality', latest.dataQuality],
            ['Recommended next', latest.topActions],
          ] as Array<[string, string[]]>).map(([heading, lines]) => (
            <section key={heading} className="mb-4 last:mb-0">
              <h3 className="eyebrow mb-1.5">{heading}</h3>
              <ul className="space-y-1 text-[13px]" style={{ color: heading === 'Recommended next' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                {lines.length === 0 ? <li style={{ color: 'var(--text-ghost)' }}>Nothing.</li> : lines.map((l, i) => <li key={i}>· {l}</li>)}
              </ul>
            </section>
          ))}
          {latest.currentGoals.length > 0 && (
            <section>
              <h3 className="eyebrow mb-1.5">Goals</h3>
              <ul className="space-y-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                {latest.currentGoals.map((g, i) => <li key={i}>· {g.title} — {g.status}, {g.progress}%</li>)}
              </ul>
            </section>
          )}
        </Panel>
      ) : (
        <Panel title="No reviews yet" className="mb-4">
          <EmptyState reason="Nothing has been reviewed, so nothing has been caught." action="Run your first review above" />
        </Panel>
      )}

      {reports.length > 1 && (
        <Disclosure summary="Earlier reviews" count={reports.length - 1}>
          <ul className="space-y-1 text-xs">
            {reports.slice(1).map((r) => (
              <li key={r.id} style={{ color: 'var(--text-secondary)' }}>
                {r.cadence} · {r.periodStart.slice(0, 10)} to {r.periodEnd.slice(0, 10)} · run {r.createdAt.slice(0, 10)}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
