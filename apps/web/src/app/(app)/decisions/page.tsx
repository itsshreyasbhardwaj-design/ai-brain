import Link from 'next/link';
import { requireContext } from '@/lib/server';
import { createDecisionAction, updateDecisionAction } from '@/lib/actions';
import { Panel, EmptyState, Chip, ActionForm, Field, SubmitButton, Disclosure } from '@/components/ui';

export const metadata = { title: 'Decisions' };

export default async function DecisionsPage() {
  const ctx = await requireContext();
  const decisions = ctx.store.decisions.list(ctx.workspace.id, { limit: 200 });
  const projects = ctx.store.projects.list(ctx.workspace.id, { limit: 300 });
  const withoutOutcome = decisions.filter((d) => d.status === 'accepted' && d.outcome.trim() === '');

  return (
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="display-sm">Decisions</h1>
        <p className="mt-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {decisions.length} recorded
          {withoutOutcome.length > 0 && `, ${withoutOutcome.length} with no outcome yet`}
        </p>
      </header>

      {decisions.length === 0 ? (
        <Panel title="No decisions">
          <EmptyState
            reason="Nothing recorded. This is the record that makes a review worth reading in six months."
            action="Record one below"
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {decisions.map((d) => {
            const project = d.projectId ? projects.find((p) => p.id === d.projectId) : null;
            return (
              <Panel key={d.id} title={d.title} subtitle={d.decidedAt.slice(0, 10)}>
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  <Chip tone={d.status === 'accepted' ? 'verified' : d.status === 'reversed' ? 'danger' : 'uncertain'}>{d.status}</Chip>
                  {project && <Link href={`/projects/${project.slug}`} className="chip chip-accent">{project.name}</Link>}
                </div>
                <dl className="space-y-2 text-[13px]">
                  {d.context && (<><dt className="eyebrow">Context</dt><dd style={{ color: 'var(--text-secondary)' }}>{d.context}</dd></>)}
                  {d.choice && (<><dt className="eyebrow">Chose</dt><dd>{d.choice}</dd></>)}
                  {d.rationale && (<><dt className="eyebrow">Because</dt><dd style={{ color: 'var(--text-secondary)' }}>{d.rationale}</dd></>)}
                  {d.alternatives.length > 0 && (
                    <><dt className="eyebrow">Rejected</dt>
                      <dd style={{ color: 'var(--text-tertiary)' }}>{d.alternatives.join(' · ')}</dd></>
                  )}
                  {d.outcome ? (
                    <><dt className="eyebrow">Outcome</dt><dd style={{ color: 'var(--verified)' }}>{d.outcome}</dd></>
                  ) : (
                    <dd className="text-xs" style={{ color: 'var(--uncertain)' }}>
                      No outcome recorded, so there is no way to tell yet whether this worked.
                    </dd>
                  )}
                </dl>
                <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--line-subtle)' }}>
                  <ActionForm action={updateDecisionAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <Field label="Record the outcome" name="outcome" type="textarea" rows={2} defaultValue={d.outcome} placeholder="What actually happened?" />
                    <Field label="Status" name="status" defaultValue={d.status} options={[
                      { value: 'proposed', label: 'proposed' }, { value: 'accepted', label: 'accepted' },
                      { value: 'superseded', label: 'superseded' }, { value: 'reversed', label: 'reversed' },
                    ]} />
                    <SubmitButton size="sm">Save</SubmitButton>
                  </ActionForm>
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      <div className="mt-6 max-w-xl">
        <Disclosure summary="Record a decision">
          <ActionForm action={createDecisionAction} resetOnSuccess>
            <Field label="What was decided?" name="title" required placeholder="Use SQLite instead of Postgres" />
            <Field label="Context" name="context" type="textarea" rows={2} placeholder="What was the situation?" />
            <Field label="Chose" name="choice" placeholder="SQLite via node:sqlite" />
            <Field label="Because" name="rationale" type="textarea" rows={2} placeholder="Why this and not the alternatives?" />
            <Field label="Rejected alternatives" name="alternatives" type="textarea" rows={2} hint="One per line." />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project" name="projectId" defaultValue="" options={[{ value: '', label: 'None' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
              <Field label="Decided on" name="decidedAt" type="date" />
            </div>
            <Field label="Supersedes" name="supersedesId" defaultValue="" options={[{ value: '', label: 'Nothing' }, ...decisions.map((d) => ({ value: d.id, label: d.title }))]} hint="The older decision is marked superseded but kept." />
            <SubmitButton>Record decision</SubmitButton>
          </ActionForm>
        </Disclosure>
      </div>
    </div>
  );
}
