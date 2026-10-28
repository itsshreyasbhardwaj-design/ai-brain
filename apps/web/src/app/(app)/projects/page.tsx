import Link from 'next/link';
import { requireContext } from '@/lib/server';
import { createProjectAction } from '@/lib/actions';
import { Panel, EmptyState, Chip, ActionForm, Field, SubmitButton, Disclosure, Provenance } from '@/components/ui';
import { relativeLabel } from '@ai-brain/core';

export const metadata = { title: 'Projects' };

const CATEGORIES = ['software', 'business', 'product', 'content', 'research', 'client', 'personal', 'study', 'other'];
const LIFECYCLES = ['idea', 'planning', 'active', 'blocked', 'paused', 'shipped', 'archived'];

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; lifecycle?: string; category?: string }>;
}) {
  const ctx = await requireContext();
  const { q, lifecycle, category } = await searchParams;

  const projects = ctx.store.projects.list(ctx.workspace.id, {
    ...(q ? { search: q } : {}),
    ...(lifecycle ? { lifecycle: [lifecycle as 'active'] } : {}),
    ...(category ? { category: [category as 'software'] } : {}),
    includeArchived: lifecycle === 'archived',
    limit: 300,
  });
  const pending = ctx.store.projects.list(ctx.workspace.id, { reviewState: ['pending-review'], limit: 500 });

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display-sm">Projects</h1>
          <p className="mt-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {projects.length} shown{q ? ` matching “${q}”` : ''}
          </p>
        </div>
        {pending.length > 0 && (
          <Link href="/projects/review" className="btn btn-primary btn-sm">
            Review {pending.length} discovered project{pending.length > 1 ? 's' : ''} →
          </Link>
        )}
      </header>

      <form className="mb-5 flex flex-wrap items-end gap-2" action="/projects">
        <div className="min-w-48 flex-1">
          <label className="label" htmlFor="q">Search</label>
          <input id="q" name="q" className="input" defaultValue={q ?? ''} placeholder="name, description or alias" />
        </div>
        <div>
          <label className="label" htmlFor="lifecycle">Lifecycle</label>
          <select id="lifecycle" name="lifecycle" className="select" defaultValue={lifecycle ?? ''}>
            <option value="">Any</option>
            {LIFECYCLES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="category">Category</label>
          <select id="category" name="category" className="select" defaultValue={category ?? ''}>
            <option value="">Any</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button type="submit" className="btn">Filter</button>
        {(q || lifecycle || category) && <Link href="/projects" className="btn btn-ghost">Clear</Link>}
      </form>

      {projects.length === 0 ? (
        <Panel title="No projects">
          <EmptyState
            reason={q || lifecycle || category ? 'Nothing matches those filters.' : 'You have no projects yet.'}
            action="Connect a source to discover them automatically"
            href="/integrations"
          />
        </Panel>
      ) : (
        <div className="panel overflow-x-auto p-4">
          <table className="data">
            <thead>
              <tr>
                <th>Project</th><th>Category</th><th>Lifecycle</th><th>Last activity</th><th>Origin</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/projects/${p.slug}`} style={{ color: 'var(--text-primary)' }}>{p.name}</Link>
                    {p.reviewState === 'pending-review' && <Chip tone="uncertain">unconfirmed</Chip>}
                    {p.description && (
                      <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {p.description.slice(0, 110)}
                      </span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>{p.category}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{p.lifecycle}</td>
                  <td style={{ color: 'var(--text-tertiary)' }}>{relativeLabel(p.lastActivityAt)}</td>
                  <td><Provenance origin={p.origin} confidence={p.confidence} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 max-w-xl">
        <Disclosure summary="Add a project by hand">
          <ActionForm action={createProjectAction} resetOnSuccess>
            <Field label="Name" name="name" required placeholder="What is it called?" />
            <Field label="Description" name="description" type="textarea" rows={2} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Category" name="category" defaultValue="other" options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
              <Field label="Lifecycle" name="lifecycle" defaultValue="active" options={LIFECYCLES.map((l) => ({ value: l, label: l }))} />
            </div>
            <Field label="Tags" name="tags" placeholder="comma, separated" />
            <SubmitButton>Add project</SubmitButton>
          </ActionForm>
        </Disclosure>
      </div>
    </div>
  );
}
