import Link from 'next/link';
import { requireContext, engines } from '@/lib/server';
import {
  createResourceAction, confirmResourceAction, endResourceAction, deleteResourceAction,
  logTimeAction, recordMetricAction,
} from '@/lib/actions';
import { Panel, EmptyState, Chip, ActionForm, Field, SubmitButton, Disclosure, Stat, Checkbox } from '@/components/ui';
import { formatMoney, VERDICT_LABELS, relativeLabel } from '@ai-brain/core';

export const metadata = { title: 'Resources' };

const KINDS = ['subscription', 'infrastructure', 'tool', 'ai-api', 'person', 'budget', 'time'];

export default async function ResourcesPage() {
  const ctx = await requireContext();
  const { resources } = engines(ctx.store);
  const cost = resources.costReport(ctx.workspace.id);
  const time = resources.timeReport(ctx.workspace.id, 30);
  const tools = resources.toolInventory(ctx.workspace.id);
  const allocation = resources.allocation(ctx.workspace.id);
  const projects = ctx.store.projects.list(ctx.workspace.id, { limit: 300 });

  return (
    <div>
      <header className="mb-6">
        <h1 className="display-sm">Resources</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Only figures you recorded. Nothing here is estimated from usage, and nothing can be cancelled
          from this page — that has to happen with the provider.
        </p>
      </header>

      <div className="grid-12 mb-4">
        <Panel title="Recorded cost" span={4}>
          {cost.hasData ? (
            <>
              <Stat value={formatMoney(cost.monthlyRecurringMinor, cost.currency)} caption="per month, recurring" tone="accent" />
              <p className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {formatMoney(cost.yearlyRecurringMinor, cost.currency)} a year
                {cost.oneOffMinor > 0 && ` · ${formatMoney(cost.oneOffMinor, cost.currency)} in one-off costs`}
              </p>
              {cost.anomalies.map((a) => (
                <p key={a.resource.id} className="mt-2 text-xs" style={{ color: 'var(--uncertain)' }}>
                  {a.resource.name}: {a.reason}
                </p>
              ))}
            </>
          ) : (
            <EmptyState reason="No costs recorded." action="Add one below" />
          )}
        </Panel>

        <Panel title="Logged time, 30 days" span={4}>
          {time.hasData ? (
            <>
              <Stat value={`${(time.totalMinutes / 60).toFixed(1)} h`} caption={`across ${time.byProject.length} project(s)`} tone="accent" />
              <p className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {time.deepWorkDays} day(s) with a focus block of an hour or more
              </p>
              {time.overcommitment && (
                <p className="mt-2 text-xs" style={{ color: 'var(--uncertain)' }}>
                  Commitments exceed capacity by {(time.overcommitment.overBy / 60).toFixed(1)} h.
                </p>
              )}
            </>
          ) : (
            <EmptyState reason="No time logged. Time with an app open is never counted as work." action="Log some below" />
          )}
        </Panel>

        <Panel title="Tools" span={4}>
          {tools.hasData ? (
            <>
              <Stat value={String(tools.tools.length)} caption="recorded" />
              {tools.unconfirmed > 0 && (
                <p className="mt-2 text-xs" style={{ color: 'var(--uncertain)' }}>
                  {tools.unconfirmed} not confirmed as still in use recently.
                </p>
              )}
              {tools.possibleOverlaps.map((o) => (
                <p key={o.group} className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  Possible {o.group.toLowerCase()} overlap: {o.names.join(', ')}. Worth a look, not a confirmed duplication.
                </p>
              ))}
            </>
          ) : (
            <EmptyState reason="No tools recorded." action="Add one below" />
          )}
        </Panel>
      </div>

      <Panel title="Project allocation" subtitle="A verdict per project, with the rules that produced it" className="mb-4">
        {allocation.length === 0 ? (
          <EmptyState reason="No projects to assess." action="Add a project" href="/projects" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Project</th><th>Verdict</th><th>Why</th><th>30d activity</th><th>Logged</th><th>Cost/mo</th></tr></thead>
              <tbody>
                {allocation.map((row) => (
                  <tr key={row.project.id}>
                    <td><Link href={`/projects/${row.project.slug}`} style={{ color: 'var(--text-primary)' }}>{row.project.name}</Link></td>
                    <td>
                      <Chip tone={
                        row.verdict === 'blocked' || row.verdict === 'consuming-without-progress' ? 'danger'
                        : row.verdict === 'advancing' || row.verdict === 'worth-more-investment' ? 'verified' : 'uncertain'
                      }>{VERDICT_LABELS[row.verdict]}</Chip>
                    </td>
                    <td style={{ color: 'var(--text-tertiary)' }}>{row.because.join('; ')}</td>
                    <td>{row.activity30d}</td>
                    <td>{(row.loggedMinutes / 60).toFixed(1)} h</td>
                    <td>{row.monthlyCostMinor > 0 ? formatMoney(row.monthlyCostMinor, cost.currency) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {tools.hasData && (
        <Panel title="Inventory" className="mb-4">
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Name</th><th>Kind</th><th>Cost/mo</th><th>Confirmed</th><th>Flags</th><th /></tr></thead>
              <tbody>
                {tools.tools.map((t) => (
                  <tr key={t.resource.id}>
                    <td>{t.resource.name}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>{t.resource.kind}</td>
                    <td>{t.monthlyMinor > 0 ? formatMoney(t.monthlyMinor, t.resource.currency) : '—'}</td>
                    <td style={{ color: 'var(--text-tertiary)' }}>{relativeLabel(t.resource.lastConfirmedAt)}</td>
                    <td style={{ color: 'var(--uncertain)' }}>{t.flags.join('; ') || '—'}</td>
                    <td>
                      <div className="flex gap-1">
                        <ActionForm action={confirmResourceAction} className="contents">
                          <input type="hidden" name="id" value={t.resource.id} />
                          <SubmitButton size="sm" variant="ghost">Still using</SubmitButton>
                        </ActionForm>
                        <ActionForm action={endResourceAction} className="contents">
                          <input type="hidden" name="id" value={t.resource.id} />
                          <SubmitButton size="sm" variant="ghost">Ended</SubmitButton>
                        </ActionForm>
                        <ActionForm action={deleteResourceAction} className="contents">
                          <input type="hidden" name="id" value={t.resource.id} />
                          <SubmitButton size="sm" variant="ghost" confirm="Delete this record?">×</SubmitButton>
                        </ActionForm>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
            “Ended” records that you stopped using it here. It does not cancel anything with the provider.
          </p>
        </Panel>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Disclosure summary="Record a cost">
          <ActionForm action={createResourceAction} resetOnSuccess>
            <Field label="Name" name="name" required placeholder="Vercel Pro" />
            <Field label="Kind" name="kind" defaultValue="subscription" options={KINDS.map((k) => ({ value: k, label: k }))} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Amount" name="amount" type="number" step="0.01" min={0} placeholder="20.00" />
              <Field label="Currency" name="currency" defaultValue="USD" />
            </div>
            <Field label="Period" name="period" defaultValue="monthly" options={[
              { value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }, { value: 'one-off', label: 'One-off' },
            ]} />
            <Field label="Project" name="projectId" defaultValue="" options={[{ value: '', label: 'None' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
            <Checkbox label="I am using this right now" name="confirmNow" defaultChecked />
            <SubmitButton size="sm">Record</SubmitButton>
          </ActionForm>
        </Disclosure>

        <Disclosure summary="Log time">
          <ActionForm action={logTimeAction} resetOnSuccess>
            <Field label="Minutes" name="minutes" type="number" min={1} max={1440} required defaultValue={60} />
            <Field label="What for?" name="label" />
            <Field label="Project" name="projectId" defaultValue="" options={[{ value: '', label: 'Unassigned' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
            <Field label="Kind" name="kind" defaultValue="focus" options={[
              { value: 'focus', label: 'Focused work' }, { value: 'meeting', label: 'Meeting' },
              { value: 'admin', label: 'Admin' }, { value: 'break', label: 'Break or recovery' },
            ]} />
            <Field label="Day" name="occurredOn" type="date" />
            <SubmitButton size="sm">Log</SubmitButton>
          </ActionForm>
        </Disclosure>

        <Disclosure summary="Record a metric">
          <ActionForm action={recordMetricAction} resetOnSuccess>
            <Field label="Label" name="label" required placeholder="Monthly revenue" />
            <Field label="Key" name="key" required placeholder="revenue" hint="Lowercase identifier used for charts and history." />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Value" name="value" type="number" step="any" required />
              <Field label="Unit" name="unit" placeholder="USD, %, count" />
              <Field label="Target" name="target" type="number" step="any" />
            </div>
            <Field label="Project" name="projectId" defaultValue="" options={[{ value: '', label: 'Whole workspace' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
            <SubmitButton size="sm">Record</SubmitButton>
          </ActionForm>
        </Disclosure>
      </div>

      <ul className="mt-6 space-y-1 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
        {[...cost.notes, ...time.notes, ...tools.notes].map((n, i) => <li key={i}>· {n}</li>)}
      </ul>
    </div>
  );
}
