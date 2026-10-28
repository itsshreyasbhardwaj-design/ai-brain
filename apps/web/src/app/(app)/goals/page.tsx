import Link from 'next/link';
import { requireContext } from '@/lib/server';
import { createGoalAction, updateGoalAction, deleteGoalAction } from '@/lib/actions';
import { Panel, EmptyState, Chip, ActionForm, Field, SubmitButton, Disclosure, Meter } from '@/components/ui';

export const metadata = { title: 'Goals' };

export default async function GoalsPage() {
  const ctx = await requireContext();
  const goals = ctx.store.goals.list(ctx.workspace.id);
  const projects = ctx.store.projects.list(ctx.workspace.id, { limit: 300 });
  const roots = goals.filter((g) => !g.parentGoalId);

  return (
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="display-sm">Goals</h1>
        <p className="mt-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {goals.filter((g) => g.status === 'active').length} active, {goals.filter((g) => g.status === 'at-risk').length} at risk
        </p>
      </header>

      {goals.length === 0 ? (
        <Panel title="No goals"><EmptyState reason="Nothing to work towards is recorded." action="Set one below" /></Panel>
      ) : (
        <div className="space-y-3">
          {roots.map((goal) => {
            const children = goals.filter((g) => g.parentGoalId === goal.id);
            const project = goal.projectId ? projects.find((p) => p.id === goal.projectId) : null;
            return (
              <Panel key={goal.id} title={goal.title} subtitle={goal.description || undefined}>
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  <Chip tone={goal.status === 'at-risk' ? 'danger' : goal.status === 'achieved' ? 'verified' : 'neutral'}>{goal.status}</Chip>
                  <Chip>{goal.horizon}</Chip>
                  {goal.targetDate && <Chip>by {goal.targetDate.slice(0, 10)}</Chip>}
                  {project && <Link href={`/projects/${project.slug}`} className="chip chip-accent">{project.name}</Link>}
                  {goal.progressOrigin === 'generated' && <Chip tone="uncertain">progress estimated</Chip>}
                </div>
                <Meter value={goal.progress} label={`${goal.progress}% — a figure you maintain, not one this system infers`} />

                {children.length > 0 && (
                  <ul className="mt-3 space-y-2 border-l pl-3" style={{ borderColor: 'var(--line)' }}>
                    {children.map((c) => (
                      <li key={c.id}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[13px]">{c.title}</span>
                          <Chip>{c.progress}%</Chip>
                        </div>
                        <Meter value={c.progress} />
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3" style={{ borderColor: 'var(--line-subtle)' }}>
                  <ActionForm action={updateGoalAction} className="flex items-end gap-2">
                    <input type="hidden" name="id" value={goal.id} />
                    <div className="w-24">
                      <label className="label" htmlFor={`p-${goal.id}`}>Progress</label>
                      <input id={`p-${goal.id}`} name="progress" type="number" min={0} max={100} className="input" defaultValue={goal.progress} />
                    </div>
                    <div className="w-32">
                      <label className="label" htmlFor={`s-${goal.id}`}>Status</label>
                      <select id={`s-${goal.id}`} name="status" className="select" defaultValue={goal.status}>
                        {['active', 'at-risk', 'achieved', 'dropped'].map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <SubmitButton size="sm">Update</SubmitButton>
                  </ActionForm>
                  <ActionForm action={deleteGoalAction} className="contents">
                    <input type="hidden" name="id" value={goal.id} />
                    <SubmitButton size="sm" variant="ghost" confirm="Delete this goal?">Delete</SubmitButton>
                  </ActionForm>
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      <div className="mt-6 max-w-xl">
        <Disclosure summary="Set a goal">
          <ActionForm action={createGoalAction} resetOnSuccess>
            <Field label="Goal" name="title" required />
            <Field label="Description" name="description" type="textarea" rows={2} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Horizon" name="horizon" defaultValue="quarter" options={[
                { value: 'quarter', label: 'This quarter' }, { value: 'year', label: 'This year' }, { value: 'long-term', label: 'Long term' },
              ]} />
              <Field label="Target date" name="targetDate" type="date" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project" name="projectId" defaultValue="" options={[{ value: '', label: 'None' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
              <Field label="Parent goal" name="parentGoalId" defaultValue="" options={[{ value: '', label: 'None' }, ...goals.map((g) => ({ value: g.id, label: g.title }))]} />
            </div>
            <SubmitButton>Add goal</SubmitButton>
          </ActionForm>
        </Disclosure>
      </div>
    </div>
  );
}
