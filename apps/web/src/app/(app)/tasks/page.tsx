import Link from 'next/link';
import { requireContext } from '@/lib/server';
import { createTaskAction, updateTaskAction, deleteTaskAction } from '@/lib/actions';
import { Panel, EmptyState, Chip, ActionForm, Field, SubmitButton, Disclosure } from '@/components/ui';
import { nowIso } from '@ai-brain/core';

export const metadata = { title: 'Tasks' };

export default async function TasksPage() {
  const ctx = await requireContext();
  const open = ctx.store.tasks.list(ctx.workspace.id, { status: ['doing', 'todo', 'blocked'], limit: 300 });
  const done = ctx.store.tasks.list(ctx.workspace.id, { status: ['done'], limit: 40 });
  const projects = ctx.store.projects.list(ctx.workspace.id, { limit: 300 });
  const goals = ctx.store.goals.list(ctx.workspace.id);
  const now = nowIso();

  return (
    <div className="max-w-4xl">
      <header className="mb-6">
        <h1 className="display-sm">Tasks</h1>
        <p className="mt-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {open.length} open, {open.filter((t) => t.dueAt && t.dueAt < now).length} overdue
        </p>
      </header>

      <Panel title="Open" className="mb-4">
        {open.length === 0 ? (
          <EmptyState reason="Nothing open." action="Add a task below" />
        ) : (
          <ul className="space-y-1">
            {open.map((t) => {
              const project = t.projectId ? projects.find((p) => p.id === t.projectId) : null;
              const overdue = t.dueAt !== null && t.dueAt < now;
              return (
                <li key={t.id} className="flex items-start gap-2 border-b py-2 last:border-0" style={{ borderColor: 'var(--line-subtle)' }}>
                  <ActionForm action={updateTaskAction} className="shrink-0 pt-0.5">
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="status" value="done" />
                    <SubmitButton size="sm" variant="ghost">○</SubmitButton>
                  </ActionForm>
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px]">{t.title}</span>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Chip tone={t.priority === 1 ? 'danger' : 'neutral'}>P{t.priority}</Chip>
                      <Chip tone={t.status === 'blocked' ? 'danger' : 'neutral'}>{t.status}</Chip>
                      {t.dueAt && <Chip tone={overdue ? 'danger' : 'neutral'}>{overdue ? 'overdue' : 'due'} {t.dueAt.slice(0, 10)}</Chip>}
                      {project && <Link href={`/projects/${project.slug}`} className="chip chip-accent">{project.name}</Link>}
                      {t.estimateMinutes && <Chip>{t.estimateMinutes}m</Chip>}
                    </div>
                    {t.notes && <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t.notes}</p>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {t.status !== 'blocked' && (
                      <ActionForm action={updateTaskAction} className="contents">
                        <input type="hidden" name="id" value={t.id} />
                        <input type="hidden" name="status" value="blocked" />
                        <SubmitButton size="sm" variant="ghost">Block</SubmitButton>
                      </ActionForm>
                    )}
                    <ActionForm action={deleteTaskAction} className="contents">
                      <input type="hidden" name="id" value={t.id} />
                      <SubmitButton size="sm" variant="ghost" confirm="Delete this task?">×</SubmitButton>
                    </ActionForm>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <div className="max-w-xl">
        <Disclosure summary="Add a task">
          <ActionForm action={createTaskAction} resetOnSuccess>
            <Field label="Task" name="title" required />
            <Field label="Notes" name="notes" type="textarea" rows={2} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project" name="projectId" defaultValue="" options={[{ value: '', label: 'None' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
              <Field label="Goal" name="goalId" defaultValue="" options={[{ value: '', label: 'None' }, ...goals.map((g) => ({ value: g.id, label: g.title }))]} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Priority" name="priority" defaultValue="3" options={[
                { value: '1', label: '1 — now' }, { value: '2', label: '2 — soon' },
                { value: '3', label: '3 — normal' }, { value: '4', label: '4 — someday' },
              ]} />
              <Field label="Due" name="dueAt" type="date" />
              <Field label="Estimate (min)" name="estimateMinutes" type="number" min={0} hint="Used for overcommitment warnings." />
            </div>
            <SubmitButton>Add task</SubmitButton>
          </ActionForm>
        </Disclosure>
      </div>

      {done.length > 0 && (
        <div className="mt-6">
          <Disclosure summary="Recently completed" count={done.length}>
            <ul className="space-y-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {done.map((t) => (
                <li key={t.id}>✓ {t.title} <span style={{ color: 'var(--text-ghost)' }}>{t.completedAt?.slice(0, 10)}</span></li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}
    </div>
  );
}
