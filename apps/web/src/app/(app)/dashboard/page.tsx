import Link from 'next/link';
import { requireContext, engines } from '@/lib/server';
import { Panel, EmptyState, Chip, Stat, Disclosure } from '@/components/ui';
import { WIDGET_CATALOG } from '@ai-brain/core/engines';
import { DashboardCustomiser } from '@/components/dashboard-customiser';

export const metadata = { title: 'Mission Control' };

/**
 * Mission Control.
 *
 * Every widget here is built by the dashboard engine, which returns either real
 * rows or an explicit empty state carrying the reason and the fix. The page
 * itself does no inference: if a panel looks empty, that is the data.
 */
export default async function DashboardPage() {
  const ctx = await requireContext();
  const { dashboard } = engines(ctx.store);
  const data = dashboard.build(ctx.workspace.id, ctx.config);

  const allWidgetKeys = (ctx.config?.dashboardLayout.widgets ?? []).map((w) => w.key);
  const visibleKeys = (ctx.config?.dashboardLayout.widgets ?? []).filter((w) => w.visible).map((w) => w.key);

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow mb-1.5">{ctx.config?.profile ?? 'unconfigured'} brain</p>
          <h1 className="display-sm">{ctx.config?.displayName ?? ctx.workspace.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/assistant" className="btn btn-sm">Ask your brain</Link>
          <Link href="/reports" className="btn btn-sm">Run a review</Link>
          <DashboardCustomiser allKeys={allWidgetKeys} visibleKeys={visibleKeys} catalog={WIDGET_CATALOG} />
        </div>
      </header>

      <div className="mb-6 flex flex-wrap gap-x-8 gap-y-4">
        <Stat value={String(data.counts.projects)} caption="projects" />
        <Stat value={String(data.counts.openTasks)} caption="open tasks" />
        <Stat value={String(data.counts.knowledge)} caption="knowledge records" />
        <Stat value={String(data.counts.connections)} caption="live connections" />
        {data.counts.pendingReview > 0 && (
          <Link href="/projects/review" className="no-underline">
            <Stat value={String(data.counts.pendingReview)} caption="awaiting review" tone="uncertain" />
          </Link>
        )}
        {data.counts.staleConnections > 0 && (
          <Link href="/integrations" className="no-underline">
            <Stat value={String(data.counts.staleConnections)} caption="stale connections" tone="uncertain" />
          </Link>
        )}
      </div>

      {data.widgets.length === 0 ? (
        <Panel title="Nothing on your dashboard yet">
          <EmptyState
            reason="No widgets are switched on for this brain."
            action="Configure your brain"
            href="/onboarding"
          />
        </Panel>
      ) : (
        <div className="grid-12">
          {data.widgets.map((w) => (
            <Panel key={w.key} title={w.label} span={w.span}>
              {w.headline && (
                <div className="mb-3">
                  <Stat value={w.headline.value} caption={w.headline.caption} tone="accent" />
                </div>
              )}

              {w.empty ? (
                <EmptyState reason={w.empty.reason} action={w.empty.action} href={w.empty.href} />
              ) : (
                <ul className="-mx-1 space-y-0.5">
                  {w.rows.map((row, i) => {
                    const content = (
                      <>
                        <span className="flex items-start justify-between gap-2">
                          <span
                            className="text-[13px] leading-snug"
                            style={{ color: row.uncertain ? 'var(--uncertain)' : 'var(--text-primary)' }}
                          >
                            {row.primary}
                          </span>
                          {row.badge && <Chip tone={row.uncertain ? 'uncertain' : 'neutral'}>{row.badge}</Chip>}
                        </span>
                        {row.secondary && (
                          <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                            {row.secondary}
                          </span>
                        )}
                      </>
                    );
                    return (
                      <li key={i}>
                        {row.href ? (
                          row.href.startsWith('http') ? (
                            <a href={row.href} target="_blank" rel="noreferrer noopener" className="row-link">{content}</a>
                          ) : (
                            <Link href={row.href} className="row-link">{content}</Link>
                          )
                        ) : (
                          <div className="px-1.5 py-1">{content}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {w.footnote && (
                <p className="mt-3 border-t pt-2.5 text-[11px] leading-relaxed" style={{ borderColor: 'var(--line-subtle)', color: 'var(--text-ghost)' }}>
                  {w.footnote}
                </p>
              )}
            </Panel>
          ))}
        </div>
      )}

      <div className="mt-6">
        <Disclosure summary="Where these numbers come from">
          <p className="max-w-2xl text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
            Every figure above is read from records in this workspace. Counts of activity, completed tasks
            and knowledge reflect what was <em>captured</em>, which is not the same as everything you did.
            Panels marked as computed were derived from those records by fixed rules you can read in{' '}
            <code className="mono">packages/core/src/engines</code> — no model is involved in producing them.
            Generated at {data.generatedAt.slice(0, 19).replace('T', ' ')} UTC.
          </p>
        </Disclosure>
      </div>
    </div>
  );
}
