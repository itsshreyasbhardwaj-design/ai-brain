import { requireContext, engines, providerFor } from '@/lib/server';
import { AssistantPanel } from '@/components/assistant-panel';
import { askAction } from '@/lib/actions';
import { Panel } from '@/components/ui';
import { DbLedger } from '@ai-brain/core/ai';
import { formatMoney } from '@ai-brain/core';

export const metadata = { title: 'Assistant' };

/**
 * The assistant.
 *
 * Answers are retrieved and computed from records, with citations and an
 * explicit certainty label. A configured provider may only rephrase what was
 * already computed, which is why this page works identically with no provider
 * at all.
 */
export default async function AssistantPage() {
  const ctx = await requireContext();
  const { assistant } = engines(ctx.store);
  const { config: providerConfig } = providerFor(ctx.store, ctx.workspace.id, ctx.config);
  const ledger = new DbLedger(ctx.store, ctx.workspace.id);
  const spent = ledger.spentThisMonthMinor();
  const calls = ledger.callsThisMonth();

  return (
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="display-sm">Ask your brain</h1>
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Answers come from your own records, with a source for every claim. This assistant knows nothing
          about the world — only what is in this workspace.
        </p>
      </header>

      <AssistantPanel action={askAction} suggestions={assistant.capabilities()} />

      <Panel title="AI provider" subtitle="What is configured on this installation" className="mt-6">
        <dl className="space-y-1.5 text-[13px]">
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--text-tertiary)' }}>Provider</dt>
            <dd>{providerConfig.kind === 'none' ? 'none — answers are computed by rules' : `${providerConfig.kind}${providerConfig.model ? ` (${providerConfig.model})` : ''}`}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--text-tertiary)' }}>Remote AI allowed by your settings</dt>
            <dd>{ctx.config?.privacy.allowRemoteAi ? 'yes' : 'no'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--text-tertiary)' }}>Monthly budget</dt>
            <dd>{providerConfig.monthlyBudgetMinor === 0 ? 'none set — paid calls are refused' : formatMoney(providerConfig.monthlyBudgetMinor)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--text-tertiary)' }}>Spent this month</dt>
            <dd>{spent === 0 ? 'nothing' : `${formatMoney(spent)} across ${calls} call(s)`}</dd>
          </div>
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--text-ghost)' }}>
          A provider is configured in <code className="mono">.env</code> with <code className="mono">AI_PROVIDER</code>.
          An API key alone does not authorize spending: <code className="mono">AI_MONTHLY_BUDGET_MINOR</code> must
          be set too, and a call estimated to exceed the remaining budget is refused before it is made.
          Ollama runs a local model and costs nothing.
        </p>
      </Panel>
    </div>
  );
}
