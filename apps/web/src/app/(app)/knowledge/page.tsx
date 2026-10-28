import Link from 'next/link';
import { requireContext, engines } from '@/lib/server';
import { createKnowledgeAction, importNotesAction } from '@/lib/actions';
import { Panel, EmptyState, Chip, Provenance, ActionForm, Field, SubmitButton, Disclosure, Stat } from '@/components/ui';
import { relativeLabel } from '@ai-brain/core';

export const metadata = { title: 'Knowledge' };

const CLASSES = ['fact', 'decision', 'idea', 'action', 'insight'] as const;

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; klass?: string }>;
}) {
  const ctx = await requireContext();
  const { q, klass } = await searchParams;
  const { knowledge } = engines(ctx.store);

  const hits = ctx.store.knowledge.search(ctx.workspace.id, q ?? '', {
    ...(klass ? { klass: [klass as 'fact'] } : {}),
    limit: 60,
  });
  const stats = knowledge.stats(ctx.workspace.id);
  const conflicts = knowledge.contradictions(ctx.workspace.id);
  const projects = ctx.store.projects.list(ctx.workspace.id, { limit: 300 });

  return (
    <div>
      <header className="mb-6">
        <h1 className="display-sm">Knowledge</h1>
        <p className="mt-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {stats.total} record(s). {stats.withSource} linked to a source, {stats.stale} not confirmed in 180 days.
        </p>
      </header>

      <div className="mb-5 flex flex-wrap gap-x-8 gap-y-3">
        {CLASSES.map((c) => (
          <Link key={c} href={`/knowledge?klass=${c}`} className="no-underline">
            <Stat value={String(stats.byClass[c])} caption={c} />
          </Link>
        ))}
      </div>

      {conflicts.length > 0 && (
        <Panel
          title={`${conflicts.length} conflicting record(s)`}
          subtitle="Two records assert opposite things. Resolving one keeps both readable."
          className="mb-4"
        >
          <ul className="space-y-1.5">
            {conflicts.slice(0, 5).map(({ record, conflictsWith }) => (
              <li key={record.id} className="text-[13px]">
                <Link href={`/knowledge/${record.id}`} style={{ color: 'var(--uncertain)' }}>{record.title}</Link>
                {conflictsWith && (
                  <span style={{ color: 'var(--text-tertiary)' }}> conflicts with “{conflictsWith.title}”</span>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <form className="mb-5 flex flex-wrap items-end gap-2" action="/knowledge">
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="q">Search</label>
          <input id="q" name="q" className="input" defaultValue={q ?? ''} placeholder="full-text search across everything" />
        </div>
        <div>
          <label className="label" htmlFor="klass">Class</label>
          <select id="klass" name="klass" className="select" defaultValue={klass ?? ''}>
            <option value="">Any</option>
            {CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button type="submit" className="btn">Search</button>
        {(q || klass) && <Link href="/knowledge" className="btn btn-ghost">Clear</Link>}
      </form>

      {hits.length === 0 ? (
        <Panel title="No records">
          <EmptyState
            reason={q ? `Nothing matches “${q}”.` : 'Your knowledge base is empty.'}
            action="Import some notes below, or write a record"
          />
        </Panel>
      ) : (
        <ul className="space-y-2">
          {hits.map(({ record, snippet }) => (
            <li key={record.id}>
              <Link href={`/knowledge/${record.id}`} className="panel block p-3.5 no-underline">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{record.title}</h2>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Chip>{record.klass}</Chip>
                    {record.contradictsId && <Chip tone="danger">conflict</Chip>}
                  </div>
                </div>
                {snippet && (
                  <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>{snippet}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Provenance origin={record.origin} confidence={record.confidence} />
                  <span className="text-[11px]" style={{ color: 'var(--text-ghost)' }}>
                    {relativeLabel(record.observedAt)}
                  </span>
                  {record.tags.filter((t) => t !== 'auto-classified').map((t) => <Chip key={t}>{t}</Chip>)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Disclosure summary="Import notes or a conversation export">
          <ActionForm action={importNotesAction}>
            <div className="mb-3">
              <label className="label" htmlFor="files">Files</label>
              <input id="files" type="file" name="files" multiple accept=".md,.markdown,.txt,.json" className="input" />
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                Markdown, text, or the official data export from ChatGPT or Claude. Secrets are stripped
                locally before anything is stored, and re-importing the same file does not duplicate it.
              </p>
            </div>
            <Field label="Or paste a note" name="pasted" type="textarea" rows={4} placeholder="# A heading&#10;&#10;Body text…" />
            <SubmitButton>Import</SubmitButton>
          </ActionForm>
        </Disclosure>

        <Disclosure summary="Write a record">
          <ActionForm action={createKnowledgeAction} resetOnSuccess>
            <Field label="Title" name="title" required />
            <Field label="Body" name="body" type="textarea" rows={4} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Class" name="klass" defaultValue="fact" options={CLASSES.map((c) => ({ value: c, label: c }))} />
              <Field
                label="Project"
                name="projectId"
                defaultValue=""
                options={[{ value: '', label: 'None' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
              />
            </div>
            <Field label="Tags" name="tags" placeholder="comma, separated" />
            <SubmitButton>Save record</SubmitButton>
          </ActionForm>
        </Disclosure>
      </div>
    </div>
  );
}
