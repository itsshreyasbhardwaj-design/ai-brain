import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireContext, engines } from '@/lib/server';
import { updateKnowledgeAction, deleteKnowledgeAction, resolveContradictionAction } from '@/lib/actions';
import { Panel, Chip, Provenance, ActionForm, Field, SubmitButton, Disclosure } from '@/components/ui';

const CLASSES = ['fact', 'decision', 'idea', 'action', 'insight'] as const;

export default async function KnowledgeRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();
  const record = ctx.store.knowledge.byId(ctx.workspace.id, id);
  if (!record) notFound();

  const { knowledge } = engines(ctx.store);
  const related = knowledge.related(ctx.workspace.id, record.id);
  const conflict = record.contradictsId ? ctx.store.knowledge.byId(ctx.workspace.id, record.contradictsId) : null;
  const supersedes = record.supersedesId ? ctx.store.knowledge.byId(ctx.workspace.id, record.supersedesId) : null;
  const project = record.projectId ? ctx.store.projects.byId(ctx.workspace.id, record.projectId) : null;
  const projects = ctx.store.projects.list(ctx.workspace.id, { limit: 300 });
  const source = record.sourceId ? ctx.store.sources.byId(ctx.workspace.id, record.sourceId) : null;

  return (
    <div className="max-w-3xl">
      <nav className="mb-4 text-xs" aria-label="Breadcrumb">
        <Link href="/knowledge" style={{ color: 'var(--text-tertiary)' }}>Knowledge</Link>
        <span style={{ color: 'var(--text-ghost)' }}> / {record.klass}</span>
      </nav>

      <header className="mb-5">
        <h1 className="display-sm">{record.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Chip>{record.klass}</Chip>
          <Provenance origin={record.origin} confidence={record.confidence} />
          {project && <Link href={`/projects/${project.slug}`} className="chip chip-accent">{project.name}</Link>}
          {record.archivedAt && <Chip tone="uncertain">archived</Chip>}
          {record.tags.filter((t) => t !== 'auto-classified').map((t) => <Chip key={t}>{t}</Chip>)}
        </div>
        {record.tags.includes('auto-classified') && (
          <p className="mt-2 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
            Classified as “{record.klass}” by rule, not by you. Change it below if that is wrong.
          </p>
        )}
      </header>

      {record.origin === 'generated' && (
        <div className="mb-4 rounded-lg border px-3 py-2.5 text-xs" style={{ borderColor: 'var(--uncertain)', background: 'var(--uncertain-dim)', color: 'var(--uncertain)' }}>
          A model wrote this. It has not been verified and is not treated as a fact anywhere in this system.
        </div>
      )}

      {conflict && (
        <Panel title="This conflicts with another record" className="mb-4">
          <p className="mb-3 text-[13px]">
            <Link href={`/knowledge/${conflict.id}`} style={{ color: 'var(--uncertain)' }}>{conflict.title}</Link>
          </p>
          <div className="flex flex-wrap gap-2">
            <ActionForm action={resolveContradictionAction} className="contents">
              <input type="hidden" name="keepId" value={record.id} />
              <input type="hidden" name="oldId" value={conflict.id} />
              <input type="hidden" name="action" value="supersede" />
              <SubmitButton size="sm">This one is current</SubmitButton>
            </ActionForm>
            <ActionForm action={resolveContradictionAction} className="contents">
              <input type="hidden" name="keepId" value={record.id} />
              <input type="hidden" name="action" value="keep-both" />
              <SubmitButton size="sm" variant="default">Both are fine</SubmitButton>
            </ActionForm>
          </div>
        </Panel>
      )}

      {supersedes && (
        <p className="mb-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Replaces <Link href={`/knowledge/${supersedes.id}`} style={{ color: 'var(--accent)' }}>{supersedes.title}</Link>,
          which is archived but still readable.
        </p>
      )}

      <Panel title="Record" className="mb-4">
        <pre className="whitespace-pre-wrap text-[13px] leading-relaxed" style={{ fontFamily: 'inherit', color: 'var(--text-secondary)' }}>
          {record.body || '(no body)'}
        </pre>
        <footer className="mt-4 border-t pt-3 text-[11px]" style={{ borderColor: 'var(--line-subtle)', color: 'var(--text-ghost)' }}>
          Observed {record.observedAt.slice(0, 10)} · created {record.createdAt.slice(0, 10)}
          {source && <> · from {source.connector}:{source.locator}</>}
        </footer>
      </Panel>

      {related.length > 0 && (
        <Panel title="Related records" subtitle="Matched on shared terms and project, not by a model" className="mb-4">
          <ul className="space-y-1">
            {related.map((r) => (
              <li key={r.id} className="text-[13px]">
                <Link href={`/knowledge/${r.id}`} style={{ color: 'var(--text-primary)' }}>{r.title}</Link>
                <Chip>{r.klass}</Chip>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Disclosure summary="Edit this record">
        <ActionForm action={updateKnowledgeAction}>
          <input type="hidden" name="id" value={record.id} />
          <Field label="Title" name="title" required defaultValue={record.title} />
          <Field label="Body" name="body" type="textarea" rows={8} defaultValue={record.body} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Class" name="klass" defaultValue={record.klass} options={CLASSES.map((c) => ({ value: c, label: c }))} />
            <Field
              label="Project" name="projectId" defaultValue={record.projectId ?? ''}
              options={[{ value: '', label: 'None' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </div>
          <Field label="Tags" name="tags" defaultValue={record.tags.join(', ')} />
          <SubmitButton size="sm">Save</SubmitButton>
        </ActionForm>
        <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--line-subtle)' }}>
          <ActionForm action={deleteKnowledgeAction}>
            <input type="hidden" name="id" value={record.id} />
            <SubmitButton size="sm" variant="danger" confirm="Delete this record permanently?">Delete</SubmitButton>
          </ActionForm>
        </div>
      </Disclosure>
    </div>
  );
}
