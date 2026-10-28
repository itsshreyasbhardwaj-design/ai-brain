'use client';

/**
 * The assistant's question box.
 *
 * The certainty label and the citations are not decoration: they are the
 * difference between an answer and a guess, so they render as prominently as
 * the answer itself.
 */

import { useActionState } from 'react';
import Link from 'next/link';
import { useFormStatus } from 'react-dom';
import { Chip } from './ui';
import type { AskResult } from '@/lib/actions';

const CERTAINTY: Record<string, { label: string; tone: 'verified' | 'neutral' | 'uncertain' | 'danger'; explain: string }> = {
  grounded: { label: 'grounded', tone: 'verified', explain: 'Every figure comes from a stored record.' },
  derived: { label: 'computed', tone: 'neutral', explain: 'Computed from stored records by a stated rule.' },
  'insufficient-data': { label: 'not enough data', tone: 'uncertain', explain: 'Answerable in principle, but the records needed are missing.' },
  'out-of-scope': { label: 'out of scope', tone: 'danger', explain: 'This is outside what your brain can see.' },
};

function Submit() {
  const { pending } = useFormStatus();
  return <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Thinking…' : 'Ask'}</button>;
}

export function AssistantPanel({
  action, suggestions,
}: {
  action: (prev: AskResult | null, form: FormData) => Promise<AskResult>;
  suggestions: string[];
}) {
  const [state, formAction] = useActionState(action, null);
  const answer = state?.answer;
  const certainty = answer ? CERTAINTY[answer.certainty] ?? CERTAINTY.derived! : null;

  return (
    <div>
      <form action={formAction} className="panel-lit p-4">
        <label className="label" htmlFor="question">Your question</label>
        <div className="flex gap-2">
          <input
            id="question"
            name="question"
            className="input"
            required
            maxLength={500}
            placeholder="What needs my attention today?"
            autoComplete="off"
          />
          <Submit />
        </div>
      </form>

      {state && !state.ok && (
        <p role="alert" className="mt-3 text-xs" style={{ color: 'var(--danger)' }}>{state.message}</p>
      )}

      {answer && certainty && (
        <article className="panel mt-4 p-4" aria-live="polite">
          <div className="mb-3 flex items-center gap-2">
            <Chip tone={certainty.tone} title={certainty.explain}>{certainty.label}</Chip>
            {answer.narration?.used && <Chip tone="uncertain" title="A model rewrote the computed answer. The figures are unchanged.">rephrased by a model</Chip>}
          </div>

          <p className="text-[15px] leading-relaxed">{answer.text}</p>

          {answer.bullets.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {answer.bullets.map((b, i) => <li key={i}>· {b}</li>)}
            </ul>
          )}

          {answer.citations.length > 0 && (
            <section className="mt-4 border-t pt-3" style={{ borderColor: 'var(--line-subtle)' }}>
              <h3 className="eyebrow mb-1.5">Where this comes from</h3>
              <ul className="space-y-1 text-[11px]">
                {answer.citations.map((c, i) => (
                  <li key={i} style={{ color: 'var(--text-tertiary)' }}>
                    {c.href ? (
                      <Link href={c.href} style={{ color: 'var(--accent)' }}>{c.label}</Link>
                    ) : (
                      <span style={{ color: 'var(--text-secondary)' }}>{c.label}</span>
                    )}
                    {' — '}{c.source}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {answer.caveats.length > 0 && (
            <section className="mt-3">
              <h3 className="eyebrow mb-1.5">What this does not tell you</h3>
              <ul className="space-y-1 text-[11px]" style={{ color: 'var(--uncertain)' }}>
                {answer.caveats.map((c, i) => <li key={i}>· {c}</li>)}
              </ul>
            </section>
          )}

          {answer.narration?.note && (
            <p className="mt-3 text-[11px]" style={{ color: 'var(--text-ghost)' }}>{answer.narration.note}</p>
          )}

          {answer.suggestions.length > 0 && (
            <section className="mt-4 border-t pt-3" style={{ borderColor: 'var(--line-subtle)' }}>
              <h3 className="eyebrow mb-1.5">Ask next</h3>
              <div className="flex flex-wrap gap-1.5">
                {answer.suggestions.map((s) => (
                  <form key={s} action={formAction} className="contents">
                    <input type="hidden" name="question" value={s} />
                    <button type="submit" className="chip" style={{ cursor: 'pointer' }}>{s}</button>
                  </form>
                ))}
              </div>
            </section>
          )}
        </article>
      )}

      {!answer && (
        <section className="mt-4">
          <h2 className="eyebrow mb-2">Questions it can answer</h2>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <form key={s} action={formAction} className="contents">
                <input type="hidden" name="question" value={s} />
                <button type="submit" className="chip" style={{ cursor: 'pointer' }}>{s}</button>
              </form>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--text-ghost)' }}>
            Anything else falls back to a search over your knowledge base. The assistant will say when a
            question is outside what it can see rather than answering from general knowledge.
          </p>
        </section>
      )}
    </div>
  );
}
