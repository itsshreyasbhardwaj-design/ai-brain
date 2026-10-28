import Link from 'next/link';
import { requireContext, baseUrl, appSecret } from '@/lib/server';
import {
  connectGitHubAction, connectLocalDirectoryAction, connectAgentAction,
  syncAction, revokeConnectionAction, deleteConnectorDataAction,
} from '@/lib/actions';
import {
  Panel, Chip, EmptyState, ActionForm, Field, SubmitButton, Disclosure, CodeBlock, Toast,
} from '@/components/ui';
import { connectionHealth, CONNECTORS, ROADMAP_CONNECTORS, claudeCodeHookSnippet, codexWrapperSnippet } from '@ai-brain/core/connectors';
import { relativeLabel } from '@ai-brain/core';

export const metadata = { title: 'Integrations' };

/**
 * Integrations.
 *
 * The honesty surface. Every connection shows what it actually covers, when it
 * last succeeded, and the connector's documented limitations verbatim — so a
 * user can never mistake "connected" for "complete".
 */
export default async function IntegrationsPage() {
  const ctx = await requireContext();
  const health = connectionHealth(ctx.store, ctx.workspace.id);
  const base = await baseUrl();
  const hasSecret = appSecret() !== null;
  const tokens = ctx.store.tokens.list(ctx.workspace.id).filter((t) => !t.revokedAt);
  const imports = ctx.store.imports.list(ctx.workspace.id, 10);
  const runs = ctx.store.syncRuns.list(ctx.workspace.id, 10);

  return (
    <div className="max-w-4xl">
      <header className="mb-6">
        <h1 className="display-sm">Integrations</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Nothing is read from an account you have not authorized. Each connector states what it can and
          cannot do, and those statements are the same ones the code enforces.
        </p>
      </header>

      {!hasSecret && (
        <Toast
          message="APP_SECRET is not set, so credentials cannot be encrypted and GitHub cannot be connected. Set it in .env and restart. Local directory and file imports work without it."
          tone="warn"
        />
      )}

      {health.length === 0 ? (
        <Panel title="Nothing connected" className="mb-4">
          <EmptyState
            reason="Every record in this brain was entered by you. Connecting a source is what makes project discovery automatic."
            action="Pick one below"
          />
        </Panel>
      ) : (
        <div className="mb-6 space-y-3">
          {health.map((h) => (
            <Panel
              key={h.account.id}
              title={`${h.label} — ${h.account.accountLabel}`}
              action={
                <div className="flex gap-1.5">
                  {h.account.status !== 'revoked' && h.mode !== 'manual-export' && (
                    <ActionForm action={syncAction} className="contents">
                      <input type="hidden" name="accountId" value={h.account.id} />
                      <SubmitButton size="sm">Sync now</SubmitButton>
                    </ActionForm>
                  )}
                  {h.account.status !== 'revoked' && (
                    <ActionForm action={revokeConnectionAction} className="contents">
                      <input type="hidden" name="accountId" value={h.account.id} />
                      <SubmitButton size="sm" variant="ghost" confirm="Revoke this connection? The stored credential is destroyed.">Revoke</SubmitButton>
                    </ActionForm>
                  )}
                </div>
              }
            >
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <Chip tone={h.account.status === 'active' ? 'verified' : h.account.status === 'error' ? 'danger' : 'uncertain'}>
                  {h.account.status}
                </Chip>
                <Chip>{h.mode}</Chip>
                <Chip tone={h.connectorStatus === 'supported' ? 'neutral' : 'uncertain'}>{h.connectorStatus}</Chip>
                <span className="text-[11px]" style={{ color: 'var(--text-ghost)' }}>
                  last sync {relativeLabel(h.account.lastSyncAt)}
                </span>
              </div>

              <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>{h.completeness}</p>

              {h.account.lastError && (
                <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
                  Last error: {h.account.lastError}
                </p>
              )}

              {h.account.allowlist.length > 0 && (
                <p className="mt-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  Scoped to: {h.account.allowlist.join(', ')}
                </p>
              )}

              {h.lastRun && (
                <p className="mt-2 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
                  Last run: {h.lastRun.status} · {h.lastRun.stats.sourcesSeen} seen, {h.lastRun.stats.sourcesWritten} written,{' '}
                  {h.lastRun.stats.projectsCreated} project(s) created, {h.lastRun.stats.projectsQueuedForReview} queued
                  {h.lastRun.stats.skippedByPrivacy > 0 && `, ${h.lastRun.stats.skippedByPrivacy} skipped by privacy settings`}
                </p>
              )}

              <p className="mt-3 border-t pt-2.5 text-[11px] leading-relaxed" style={{ borderColor: 'var(--line-subtle)', color: 'var(--text-tertiary)' }}>
                {h.limitations}
              </p>

              <Disclosure summary="Delete everything from this source">
                <ActionForm action={deleteConnectorDataAction}>
                  <input type="hidden" name="connector" value={h.account.connector} />
                  <Field
                    label="Type delete to confirm"
                    name="confirm"
                    placeholder="delete"
                    hint="Source records, imported knowledge and activity are deleted. Projects discovered from it are archived rather than destroyed, so notes you wrote survive."
                  />
                  <SubmitButton size="sm" variant="danger">Delete source data</SubmitButton>
                </ActionForm>
              </Disclosure>
            </Panel>
          ))}
        </div>
      )}

      <h2 className="eyebrow mb-3">Connect a source</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="GitHub" subtitle={CONNECTORS.github.limitations} lit>
          <ActionForm action={connectGitHubAction}>
            <Field
              label="Personal access token"
              name="token"
              type="password"
              required
              placeholder="ghp_… or github_pat_…"
              hint="Read access is enough. The token is encrypted with APP_SECRET and never shown again. It is verified against GitHub before anything is saved."
            />
            <Field
              label="Repositories to read"
              name="allowlist"
              type="textarea"
              rows={3}
              placeholder={'octocat/ai-brain\nocto-org/*\nsomeowner'}
              hint="One per line. owner/repo for a single repository, owner/* or just owner for everything under an owner. Leave blank to read everything the token can see."
            />
            <SubmitButton>Connect GitHub</SubmitButton>
          </ActionForm>
        </Panel>

        <Panel title="Local directory" subtitle={CONNECTORS['local-directory'].limitations} lit>
          <ActionForm action={connectLocalDirectoryAction}>
            <Field
              label="Directories to scan"
              name="directories"
              type="textarea"
              rows={3}
              required
              placeholder={'/Users/me/code\n/Users/me/work/clients'}
              hint="One absolute path per line. A whole home directory is refused: point at the folder your projects live in. node_modules, .git, .ssh and secret files are never read."
            />
            <SubmitButton>Authorize directories</SubmitButton>
          </ActionForm>
        </Panel>

        <Panel title="Claude Code" subtitle={CONNECTORS['claude-code'].limitations}>
          <ActionForm action={connectAgentAction}>
            <input type="hidden" name="connector" value="claude-code" />
            <SubmitButton size="sm">Set up event ingest</SubmitButton>
          </ActionForm>
          <Disclosure summary="The hook to install yourself">
            {tokens.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--uncertain)' }}>
                Issue an access token in <Link href="/settings" style={{ color: 'var(--accent)' }}>Settings</Link> first,
                then this snippet will include it.
              </p>
            ) : (
              <CodeBlock
                label="Add to your own Claude Code settings.json"
                code={claudeCodeHookSnippet(base, '<your-access-token>')}
              />
            )}
            <p className="mt-2 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
              AI BRAIN never writes to your settings files. Copy this in yourself, and remove it whenever
              you like.
            </p>
          </Disclosure>
        </Panel>

        <Panel title="OpenAI Codex" subtitle={CONNECTORS.codex.limitations}>
          <ActionForm action={connectAgentAction}>
            <input type="hidden" name="connector" value="codex" />
            <SubmitButton size="sm">Set up event ingest</SubmitButton>
          </ActionForm>
          <Disclosure summary="The wrapper to run yourself">
            <CodeBlock label="Save as ~/bin/codex-brain" code={codexWrapperSnippet(base, '<your-access-token>')} />
          </Disclosure>
        </Panel>

        <Panel title="Notes and conversation exports" subtitle={CONNECTORS['markdown-import'].limitations}>
          <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            Markdown, text and the official data export from ChatGPT or Claude are imported from the
            Knowledge page. Secrets are stripped locally before anything is stored.
          </p>
          <Link href="/knowledge" className="btn btn-sm mt-3">Import notes →</Link>
        </Panel>

        <Panel title="Webhooks" subtitle="Faster than polling, and optional">
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Point a GitHub webhook at the endpoint below with a secret of your choosing, set{' '}
            <code className="mono">GITHUB_WEBHOOK_SECRET</code> to the same value, and pushes and renames
            arrive immediately instead of on the next sync.
          </p>
          <div className="mt-3">
            <CodeBlock code={`${base}/api/webhooks/github`} />
          </div>
          <p className="mt-2 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
            Signatures are verified with HMAC-SHA256. A request with no valid signature is rejected, and
            with no secret configured the endpoint refuses everything.
          </p>
        </Panel>
      </div>

      <Panel title="Not available in this release" className="mt-4">
        <ul className="space-y-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {ROADMAP_CONNECTORS.map((r) => (
            <li key={r.label}>
              <span style={{ color: 'var(--text-secondary)' }}>{r.label}</span> — {r.why}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px]" style={{ color: 'var(--text-ghost)' }}>
          These are listed so you know they are missing rather than broken. The adapter interface is
          documented in <code className="mono">docs/connectors.md</code> if you want to add one.
        </p>
      </Panel>

      {(runs.length > 0 || imports.length > 0) && (
        <div className="mt-4">
          <Disclosure summary="Sync and import history">
            {runs.length > 0 && (
              <div className="mb-4 overflow-x-auto">
                <table className="data">
                  <thead><tr><th>Started</th><th>Connector</th><th>Status</th><th>Seen</th><th>Written</th><th>Created</th><th>Queued</th></tr></thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id}>
                        <td style={{ color: 'var(--text-tertiary)' }}>{r.startedAt.slice(0, 16).replace('T', ' ')}</td>
                        <td>{r.connector}</td>
                        <td>
                          <Chip tone={r.status === 'success' ? 'verified' : r.status === 'failed' ? 'danger' : 'uncertain'}>{r.status}</Chip>
                        </td>
                        <td>{r.stats.sourcesSeen}</td>
                        <td>{r.stats.sourcesWritten}</td>
                        <td>{r.stats.projectsCreated}</td>
                        <td>{r.stats.projectsQueuedForReview}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {imports.length > 0 && (
              <ul className="space-y-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {imports.map((b) => (
                  <li key={b.id}>
                    {b.createdAt.slice(0, 16).replace('T', ' ')} · {b.kind} · {b.label} · {b.recordsCreated} created,{' '}
                    {b.recordsSkipped} skipped, {b.redactions} redaction(s) · {b.status}
                  </li>
                ))}
              </ul>
            )}
          </Disclosure>
        </div>
      )}
    </div>
  );
}
