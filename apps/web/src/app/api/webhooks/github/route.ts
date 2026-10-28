import { NextResponse } from 'next/server';
import { getStore } from '@/lib/server';
import { verifyGitHubSignature, interpretGitHubWebhook, SyncRunner } from '@ai-brain/core/connectors';
import { rateLimit } from '@ai-brain/core';

/**
 * GitHub webhook receiver.
 *
 * Fails closed in every direction: no configured secret means every request is
 * rejected, an invalid signature is rejected before the body is parsed as
 * anything meaningful, and an event that names no repository is acknowledged
 * without being acted on. A verified event goes through exactly the same
 * discovery path as a poll, which is why a rename arriving here updates the
 * existing project instead of creating a second one.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'GITHUB_WEBHOOK_SECRET is not configured, so webhooks are refused' },
      { status: 503 },
    );
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const limit = rateLimit(`webhook:github:${ip}`, 300, 60);
  if (!limit.allowed) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } });
  }

  const raw = await request.text();
  if (raw.length > 2_000_000) return NextResponse.json({ error: 'payload too large' }, { status: 413 });

  const signature = request.headers.get('x-hub-signature-256');
  if (!(await verifyGitHubSignature(raw, signature, secret))) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  const event = request.headers.get('x-github-event') ?? 'unknown';
  if (event === 'ping') return NextResponse.json({ ok: true, note: 'ping acknowledged' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const outcome = interpretGitHubWebhook(event, body);
  if (!outcome.source || !outcome.candidate) {
    return NextResponse.json({ ok: true, handled: false, note: outcome.note });
  }

  const store = getStore();
  // The repository id tells us which workspace this belongs to. A webhook for
  // a repository nobody has synced is acknowledged and ignored rather than
  // creating records in an arbitrary workspace.
  const externalId = outcome.source.externalId;
  const owning = store.db.one<{ workspace_id: string }>(
    `SELECT workspace_id FROM source_records WHERE connector = 'github' AND kind = 'repository' AND external_id = ? LIMIT 1`,
    [externalId],
  ) ?? store.db.one<{ workspace_id: string }>(
    `SELECT workspace_id FROM connected_accounts WHERE connector = 'github' AND status = 'active' LIMIT 1`,
  );
  if (!owning) {
    return NextResponse.json({ ok: true, handled: false, note: 'no workspace has a GitHub connection, so this event was ignored' });
  }
  const workspaceId = String(owning.workspace_id);

  const account = store.accounts.byConnector(workspaceId, 'github').find((a) => a.status !== 'revoked');
  if (!account) {
    return NextResponse.json({ ok: true, handled: false, note: 'the GitHub connection for this workspace has been revoked' });
  }

  const config = store.brainConfig.current(workspaceId);
  const result = new SyncRunner(store).apply(workspaceId, account, {
    sources: [outcome.source],
    candidates: [outcome.candidate],
    activity: outcome.activity,
    metrics: [], documents: [], cursor: null, hasMore: false, warnings: [],
    skippedByPrivacy: 0, rateLimitWaits: 0, retries: 0,
  }, {
    automationLevel: config?.automationLevel ?? 'review',
    allowFileContentImport: config?.privacy.allowFileContentImport ?? true,
    excludedCategories: config?.privacy.excludedCategories ?? [],
  });

  store.accounts.update(workspaceId, account.id, { lastSyncAt: new Date().toISOString() });
  store.audit.log({
    workspaceId, actorUserId: null, action: 'connector.webhook',
    subject: `connected_account:${account.id}`,
    detail: { event, note: outcome.note, stats: { ...result.stats } },
  });

  return NextResponse.json({
    ok: true,
    handled: true,
    event,
    projectsCreated: result.stats.projectsCreated,
    projectsUpdated: result.stats.projectsUpdated,
    queuedForReview: result.stats.projectsQueuedForReview,
  });
}

export async function GET(): Promise<Response> {
  return NextResponse.json({
    endpoint: 'github webhook',
    method: 'POST',
    required: 'x-hub-signature-256 header, verified against GITHUB_WEBHOOK_SECRET',
    events: ['push', 'repository', 'create', 'pull_request', 'issues', 'workflow_run'],
  });
}
