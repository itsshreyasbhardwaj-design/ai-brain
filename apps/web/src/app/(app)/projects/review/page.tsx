import Link from 'next/link';
import { requireContext, engines } from '@/lib/server';
import { reviewProjectAction } from '@/lib/actions';
import { Panel, EmptyState, Chip, ActionForm, SubmitButton, Field } from '@/components/ui';
import { relativeLabel } from '@ai-brain/core';

export const metadata = { title: 'Review queue' };

/**
 * The review queue.
 *
 * Everything here was discovered automatically but did not clear the
 * confidence threshold, so it is waiting for a human. The page shows the score
 * and the reason for each one, because "trust me" is not an acceptable answer
 * when the alternative is merging two unrelated projects.
 */
export default async function ReviewQueuePage() {
  const ctx = await requireContext();
  const { discovery } = engines(ctx.store);
  const queue = discovery.reviewQueue(ctx.workspace.id);
  const confirmed = ctx.store.projects.list(ctx.workspace.id, { reviewState: ['confirmed'], limit: 300 });

  return (
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="display-sm">Review queue</h1>
        <p className="mt-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
          Discovered automatically, not yet confirmed as yours.
        </p>
      </header>

      {queue.length === 0 ? (
        <Panel title="Nothing to review">
          <EmptyState
            reason="No discovered projects are waiting."
            action="Sync a connected source"
            href="/integrations"
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {queue.map((p) => (
            <Panel key={p.id} title={p.name} subtitle={p.description || undefined}>
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <Chip tone="uncertain">confidence {p.matchScore.toFixed(2)}</Chip>
                <Chip>{p.category}</Chip>
                <Chip>{p.lifecycle}</Chip>
                {p.sourceKey && <Chip tone="accent">{p.sourceKey.split(':')[0]}</Chip>}
                <span className="text-[11px]" style={{ color: 'var(--text-ghost)' }}>
                  last activity {relativeLabel(p.lastActivityAt)}
                </span>
              </div>

              {p.aliases.length > 0 && (
                <p className="mb-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  Also seen as: {p.aliases.join(', ')}
                </p>
              )}

              <div className="flex flex-wrap items-start gap-2">
                <ActionForm action={reviewProjectAction} className="contents">
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="decision" value="confirm" />
                  <SubmitButton size="sm">This is mine</SubmitButton>
                </ActionForm>
                <ActionForm action={reviewProjectAction} className="contents">
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="decision" value="reject" />
                  <SubmitButton size="sm" variant="default" confirm={`Reject "${p.name}"? Later syncs will not bring it back.`}>
                    Not a project of mine
                  </SubmitButton>
                </ActionForm>
              </div>

              {confirmed.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    It is a duplicate of something I already have
                  </summary>
                  <ActionForm action={reviewProjectAction} className="mt-2">
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="decision" value="merge" />
                    <Field
                      label="Merge into"
                      name="targetId"
                      options={confirmed.map((c) => ({ value: c.id, label: c.name }))}
                      hint="Records attached to this discovery move across, and the duplicate is archived with a link."
                    />
                    <SubmitButton size="sm" variant="default">Merge</SubmitButton>
                  </ActionForm>
                </details>
              )}
            </Panel>
          ))}
        </div>
      )}

      <p className="mt-6 text-xs leading-relaxed" style={{ color: 'var(--text-ghost)' }}>
        Confidence combines what the connector reported with how closely the candidate resembles
        something you already have. A name match alone can never clear the threshold — that is
        deliberate, because a wrong merge is harder to undo than a question.
      </p>
      <Link href="/projects" className="mt-4 inline-block text-xs" style={{ color: 'var(--accent)' }}>← All projects</Link>
    </div>
  );
}
