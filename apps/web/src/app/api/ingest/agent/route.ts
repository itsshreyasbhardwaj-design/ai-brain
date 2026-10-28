import { NextResponse } from 'next/server';
import { getStore, getAuth } from '@/lib/server';
import { interpretAgentEvent } from '@ai-brain/core/connectors';
import { SyncRunner } from '@ai-brain/core/connectors';
import { rateLimit, ValidationError } from '@ai-brain/core';
import { AuthError } from '@ai-brain/core/engines';

/**
 * Agent event ingest.
 *
 * This is the endpoint a Claude Code hook or a Codex wrapper posts to. It is
 * the only write path into the brain that is not a signed-in session, so it is
 * tight: a scoped bearer token, a small validated payload, a per-token rate
 * limit, and no ability to do anything except record one activity event and
 * possibly queue a project for review.
 */
export async function POST(request: Request): Promise<Response> {
  const store = getStore();
  const auth = getAuth();

  let workspaceId: string;
  let tokenId: string;
  try {
    const { token, workspace } = auth.resolveToken(request.headers.get('authorization'), 'propose:write');
    workspaceId = workspace.id;
    tokenId = token.id;
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'unauthorized', hint: 'Issue a token with the propose:write scope under Settings.' },
      { status },
    );
  }

  // Generous enough for a busy session, low enough that a runaway loop cannot
  // fill the database.
  const limit = rateLimit(`ingest:${tokenId}`, 600, 60);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'rate limited', retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 64_000) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  let event;
  try {
    event = interpretAgentEvent(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof ValidationError ? err.message : 'invalid event' },
      { status: 400 },
    );
  }

  const accounts = store.accounts.byConnector(workspaceId, event.connector);
  const account = accounts.find((a) => a.status !== 'revoked');
  if (!account) {
    return NextResponse.json(
      { error: `${event.connector} is not set up in this workspace`, hint: 'Enable it under Integrations first.' },
      { status: 409 },
    );
  }

  const config = store.brainConfig.current(workspaceId);
  const result = new SyncRunner(store).applyAgentEvent(
    workspaceId, account, event, config?.automationLevel ?? 'review',
  );
  store.accounts.update(workspaceId, account.id, { lastSyncAt: new Date().toISOString(), status: 'active' });

  return NextResponse.json({
    recorded: true,
    project: result.projectName,
    queuedForReview: result.queuedForReview,
    ...(result.queuedForReview
      ? { note: 'The project this event came from is waiting for the user to confirm it. The event was still recorded.' }
      : {}),
  });
}

export async function GET(): Promise<Response> {
  return NextResponse.json({
    endpoint: 'agent event ingest',
    method: 'POST',
    auth: 'Bearer token with the propose:write scope',
    body: { agent: 'claude-code | codex', kind: 'session.start', summary: 'one line', cwd: '/optional/path' },
  });
}
