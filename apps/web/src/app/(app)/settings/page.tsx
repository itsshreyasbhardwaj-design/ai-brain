import Link from 'next/link';
import { requireContext, appSecret } from '@/lib/server';
import {
  revokeTokenAction, changePasswordAction, importConfigAction,
  importExportAction, deleteWorkspaceAction, deleteAccountAction,
} from '@/lib/actions';
import { TokenForm } from '@/components/token-form';
import {
  Panel, Chip, ActionForm, Field, SubmitButton, Disclosure, EmptyState,
} from '@/components/ui';
import { relativeLabel } from '@ai-brain/core';
import { LATEST_SCHEMA_VERSION } from '@ai-brain/core/db';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const ctx = await requireContext();
  const tokens = ctx.store.tokens.list(ctx.workspace.id);
  const audit = ctx.store.audit.list(ctx.workspace.id, 40);
  const dbPath = process.env.AI_BRAIN_DB ?? './data/brain.db';

  return (
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="display-sm">Settings</h1>
      </header>

      <Panel title="This installation" className="mb-4">
        <dl className="space-y-1.5 text-[13px]">
          {[
            ['Account', ctx.user.email],
            ['Workspace', `${ctx.workspace.name} (${ctx.role})`],
            ['Brain profile', ctx.config ? `${ctx.config.profile}, version ${ctx.config.version}` : 'not configured'],
            ['Database', dbPath],
            ['Schema version', String(LATEST_SCHEMA_VERSION)],
            ['APP_SECRET', appSecret() ? 'set' : 'not set — connector credentials cannot be stored'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt style={{ color: 'var(--text-tertiary)' }}>{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/onboarding" className="btn btn-sm">Edit your brain</Link>
          <a href="/api/export" className="btn btn-sm" download>Export everything</a>
          <a href="/api/export?format=config" className="btn btn-sm" download>Export configuration</a>
          <a href="/api/export?format=context" className="btn btn-sm" download>Export context package</a>
        </div>
      </Panel>

      <Panel
        title="Access tokens"
        subtitle="For MCP clients and agent hooks. Scoped, revocable, and stored only as a hash."
        className="mb-4"
      >
        {tokens.length === 0 ? (
          <EmptyState reason="No tokens issued. No external assistant can read this brain." action="Issue one below" />
        ) : (
          <ul className="mb-4 space-y-2">
            {tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-0" style={{ borderColor: 'var(--line-subtle)' }}>
                <div>
                  <span className="text-[13px]">{t.label}</span>
                  {t.revokedAt && <Chip tone="danger">revoked</Chip>}
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {t.scopes.map((s) => <Chip key={s}>{s}</Chip>)}
                  </div>
                  <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
                    created {t.createdAt.slice(0, 10)} · last used {relativeLabel(t.lastUsedAt)}
                    {t.expiresAt && ` · expires ${t.expiresAt.slice(0, 10)}`}
                  </p>
                </div>
                {!t.revokedAt && (
                  <ActionForm action={revokeTokenAction} className="contents">
                    <input type="hidden" name="id" value={t.id} />
                    <SubmitButton size="sm" variant="ghost" confirm="Revoke this token? Anything using it stops working immediately.">Revoke</SubmitButton>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}

        <TokenForm dbPath={dbPath} />
      </Panel>

      <Panel title="Import" subtitle="From another AI BRAIN installation" className="mb-4">
        <div className="grid gap-4 md:grid-cols-2">
          <ActionForm action={importConfigAction}>
            <div className="mb-3">
              <label className="label" htmlFor="cfg">Configuration</label>
              <input id="cfg" type="file" name="file" accept=".json" className="input" />
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                A <code className="mono">brain.config.json</code>. Saves as a new version and touches no records.
              </p>
            </div>
            <SubmitButton size="sm">Import configuration</SubmitButton>
          </ActionForm>
          <ActionForm action={importExportAction}>
            <div className="mb-3">
              <label className="label" htmlFor="exp">Full export</label>
              <input id="exp" type="file" name="file" accept=".json" className="input" />
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                Records are added with new ids, so this never collides with what you already have.
                Connections cannot be restored — credentials are never exported.
              </p>
            </div>
            <SubmitButton size="sm">Import records</SubmitButton>
          </ActionForm>
        </div>
      </Panel>

      <Panel title="Security" className="mb-4">
        <Disclosure summary="Change password">
          <ActionForm action={changePasswordAction}>
            <Field label="Current password" name="current" type="password" required autoComplete="current-password" />
            <Field label="New password" name="next" type="password" required autoComplete="new-password" hint="At least 10 characters. Every session is signed out." />
            <SubmitButton size="sm">Change password</SubmitButton>
          </ActionForm>
        </Disclosure>

        <Disclosure summary="Audit log" count={audit.length}>
          {audit.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Nothing recorded yet.</p>
          ) : (
            <ul className="space-y-1 text-[11px]">
              {audit.map((a) => (
                <li key={a.id} style={{ color: 'var(--text-tertiary)' }}>
                  <span className="mono">{a.createdAt.slice(0, 19).replace('T', ' ')}</span>{' '}
                  <span style={{ color: 'var(--text-secondary)' }}>{a.action}</span> {a.subject}
                </li>
              ))}
            </ul>
          )}
        </Disclosure>
      </Panel>

      <Panel title="Delete" subtitle="Irreversible. Export first if you want a copy.">
        <div className="grid gap-4 md:grid-cols-2">
          <ActionForm action={deleteWorkspaceAction}>
            <Field label={`Type "${ctx.workspace.name}" to delete this workspace`} name="confirm" placeholder={ctx.workspace.name} />
            <SubmitButton size="sm" variant="danger">Delete workspace</SubmitButton>
          </ActionForm>
          <ActionForm action={deleteAccountAction}>
            <Field label='Type "delete my account"' name="confirm" placeholder="delete my account" />
            <SubmitButton size="sm" variant="danger">Delete account and all data</SubmitButton>
          </ActionForm>
        </div>
      </Panel>
    </div>
  );
}
