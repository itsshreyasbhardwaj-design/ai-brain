import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireContext, engines } from '@/lib/server';
import { updateProjectAction, deleteProjectAction, logTimeAction, createTaskAction } from '@/lib/actions';
import {
  Panel, EmptyState, Chip, Provenance, ActionForm, Field, SubmitButton, Disclosure, Meter,
} from '@/components/ui';
import { relativeLabel, VERDICT_LABELS } from '@ai-brain/core';

const CATEGORIES = ['software', 'business', 'product', 'content', 'research', 'client', 'personal', 'study', 'other'];
const LIFECYCLES = ['idea', 'planning', 'active', 'blocked', 'paused', 'shipped', 'archived'];

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: slug };
}

/**
 * The Project Passport.
 *
 * Sections are chosen by the project's category, and each one shows where its
 * content came from and when that was last confirmed. A section with no rows
 * says what would fill it rather than rendering an empty box.
 */
export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireContext();
  const project = ctx.store.projects.bySlug(ctx.workspace.id, slug);
  if (!project) notFound();

  const { passports, resources } = engines(ctx.store);
  const passport = passports.build(ctx.workspace.id, project.id);
  if (!passport) notFound();

  const allocation = resources.allocation(ctx.workspace.id).find((r) => r.project.id === project.id);
  const openTasks = ctx.store.tasks.list(ctx.workspace.id, { projectId: project.id, status: ['todo', 'doing', 'blocked'] });

  return (
    <div>
      <nav className="mb-4 text-xs" aria-label="Breadcrumb">
        <Link href="/projects" style={{ color: 'var(--text-tertiary)' }}>Projects</Link>
        <span style={{ color: 'var(--text-ghost)' }}> / {project.name}</span>
      </nav>

      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="display-sm">{project.name}</h1>
            {project.description && (
              <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {project.description}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Chip>{project.category}</Chip>
              <Chip tone={project.lifecycle === 'blocked' ? 'danger' : project.lifecycle === 'active' ? 'accent' : 'neutral'}>
                {project.lifecycle}
              </Chip>
              <Provenance origin={project.origin} confidence={project.confidence} />
              {project.tags.map((t) => <Chip key={t}>{t}</Chip>)}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Passport completeness</div>
            <div className="mt-1 w-36"><Meter value={passport.completeness} /></div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
              {passport.completeness}% of sections populated
            </div>
          </div>
        </div>

        {project.reviewState === 'pending-review' && (
          <div
            className="mt-4 rounded-lg border px-3 py-2.5 text-xs"
            style={{ borderColor: 'var(--uncertain)', background: 'var(--uncertain-dim)', color: 'var(--uncertain)' }}
          >
            This project was discovered automatically with confidence {project.matchScore.toFixed(2)} and you have
            not confirmed it is yours.{' '}
            <Link href="/projects/review" style={{ textDecoration: 'underline' }}>Review it →</Link>
          </div>
        )}
      </header>

      {allocation && (
        <Panel title="Where this project stands" subtitle="Computed from your records by fixed rules" className="mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={
              allocation.verdict === 'blocked' || allocation.verdict === 'consuming-without-progress' ? 'danger'
              : allocation.verdict === 'advancing' || allocation.verdict === 'worth-more-investment' ? 'verified'
              : 'uncertain'
            }>
              {VERDICT_LABELS[allocation.verdict]}
            </Chip>
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {allocation.activity30d} activity event(s) in 30 days · {(allocation.loggedMinutes / 60).toFixed(1)} h logged ·{' '}
              {allocation.openTasks} open task(s)
            </span>
          </div>
          <ul className="mt-2.5 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {allocation.because.map((b, i) => <li key={i}>· {b}</li>)}
          </ul>
        </Panel>
      )}

      <div className="grid-12">
        {passport.sections.map((section) => (
          <Panel
            key={section.key}
            title={section.title}
            span={section.key === 'identity' || section.key === 'activity' || section.key === 'history' ? 6 : 4}
            action={
              section.rows.length > 0
                ? <Provenance origin={section.origin} verifiedAt={section.lastVerifiedAt} />
                : undefined
            }
          >
            {section.rows.length === 0 ? (
              <EmptyState
                reason={emptyReason(section.key, project.category)}
                action={emptyAction(section.key)}
                href={emptyHref(section.key)}
              />
            ) : (
              <dl className="space-y-2">
                {section.rows.map((row, i) => (
                  <div key={i} className="grid grid-cols-[auto_1fr] gap-x-3 text-[13px]">
                    <dt className="shrink-0 text-xs" style={{ color: 'var(--text-tertiary)' }}>{row.label}</dt>
                    <dd style={{ color: row.uncertain ? 'var(--uncertain)' : 'var(--text-primary)' }}>
                      {row.href ? (
                        row.href.startsWith('http') ? (
                          <a href={row.href} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent)' }}>{row.value}</a>
                        ) : (
                          <Link href={row.href} style={{ color: 'var(--accent)' }}>{row.value}</Link>
                        )
                      ) : row.value}
                      {row.uncertain && <Chip tone="uncertain">uncertain</Chip>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {section.sourceRefs.length > 0 && (
              <p className="mt-3 border-t pt-2 text-[11px]" style={{ borderColor: 'var(--line-subtle)', color: 'var(--text-ghost)' }}>
                Source: {section.sourceRefs.map((r) => `${r.connector}:${r.locator}`).join(', ')}
              </p>
            )}
          </Panel>
        ))}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Disclosure summary="Log time against this project">
          <ActionForm action={logTimeAction} resetOnSuccess>
            <input type="hidden" name="projectId" value={project.id} />
            <Field label="Minutes" name="minutes" type="number" min={1} max={1440} required defaultValue={60} />
            <Field label="What for?" name="label" placeholder="optional" />
            <Field label="Kind" name="kind" defaultValue="focus" options={[
              { value: 'focus', label: 'Focused work' },
              { value: 'meeting', label: 'Meeting' },
              { value: 'admin', label: 'Admin' },
              { value: 'break', label: 'Break or recovery' },
            ]} />
            <SubmitButton size="sm">Log it</SubmitButton>
          </ActionForm>
        </Disclosure>

        <Disclosure summary={`Add a task (${openTasks.length} open)`}>
          <ActionForm action={createTaskAction} resetOnSuccess>
            <input type="hidden" name="projectId" value={project.id} />
            <Field label="Task" name="title" required />
            <Field label="Due" name="dueAt" type="date" />
            <Field label="Priority" name="priority" defaultValue="3" options={[
              { value: '1', label: '1 — now' }, { value: '2', label: '2 — soon' },
              { value: '3', label: '3 — normal' }, { value: '4', label: '4 — someday' },
            ]} />
            <SubmitButton size="sm">Add task</SubmitButton>
          </ActionForm>
        </Disclosure>

        <Disclosure summary="Edit this project">
          <ActionForm action={updateProjectAction}>
            <input type="hidden" name="id" value={project.id} />
            <Field label="Name" name="name" required defaultValue={project.name} />
            <Field label="Description" name="description" type="textarea" rows={3} defaultValue={project.description} />
            <Field label="Category" name="category" defaultValue={project.category} options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
            <Field label="Lifecycle" name="lifecycle" defaultValue={project.lifecycle} options={LIFECYCLES.map((l) => ({ value: l, label: l }))} />
            <Field label="Tags" name="tags" defaultValue={project.tags.join(', ')} />
            <SubmitButton size="sm">Save</SubmitButton>
          </ActionForm>

          <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--line-subtle)' }}>
            <ActionForm action={deleteProjectAction}>
              <input type="hidden" name="id" value={project.id} />
              <Field label="Delete permanently" name="confirm" placeholder="type delete" hint="Records attached to it lose their link but are not deleted." />
              <SubmitButton size="sm" variant="danger">Delete project</SubmitButton>
            </ActionForm>
          </div>
        </Disclosure>
      </div>
    </div>
  );
}

/** What an empty section means, specifically rather than generically. */
function emptyReason(key: string, category: string): string {
  const map: Record<string, string> = {
    objectives: 'No goals are attached to this project.',
    activity: 'No activity has been recorded against this project.',
    resources: 'No time or cost is recorded against this project.',
    documents: 'No knowledge records are attached.',
    decisions: 'No decisions have been recorded for this project.',
    performance: 'No metrics have been recorded.',
    financials: 'No costs or financial metrics are recorded.',
    risks: 'No blocked tasks, overdue work or conflicting records.',
    history: 'Nothing has changed since this project was created.',
    recommendations: 'Nothing is flagged for this project.',
    repositories: 'No repository is linked. This fills in when GitHub syncs.',
    ci: 'No CI results observed. These come from GitHub Actions runs on the default branch.',
    tests: 'No test metrics recorded.',
    dependencies: 'No dependency data recorded.',
    security: 'No security findings recorded.',
    deployments: 'No deployments observed.',
    architecture: 'No architecture notes recorded.',
  };
  return map[key] ?? `Nothing recorded for ${key} on this ${category} project.`;
}

function emptyAction(key: string): string {
  const map: Record<string, string> = {
    objectives: 'Set a goal',
    activity: 'Connect a source',
    resources: 'Record a cost',
    documents: 'Import notes',
    decisions: 'Record a decision',
    performance: 'Record a metric',
    financials: 'Record a cost',
    repositories: 'Connect GitHub',
    ci: 'Connect GitHub',
    risks: 'Nothing to do',
    history: 'Nothing to do',
    recommendations: 'Nothing to do',
  };
  return map[key] ?? 'Nothing to do';
}

function emptyHref(key: string): string | undefined {
  const map: Record<string, string> = {
    objectives: '/goals',
    activity: '/integrations',
    resources: '/resources',
    documents: '/knowledge',
    decisions: '/decisions',
    performance: '/resources',
    financials: '/resources',
    repositories: '/integrations',
    ci: '/integrations',
  };
  return map[key];
}
