/**
 * Connector integration: GitHub polling, incremental sync, webhooks, failure
 * recovery, agent event ingest, and portability.
 *
 * Every HTTP call is served by a scripted mock, so these run offline and make
 * no paid API calls. What they verify is the behaviour that cannot be checked
 * by reading the code: that a second sync is cheap, that a failed sync is
 * recorded and recoverable, and that a rename arriving by webhook does not
 * produce a duplicate project.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, mockFetch, ghRepo, noSleep, daysAgo } from './helpers.ts';
import { GitHubConnector, interpretGitHubWebhook, verifyGitHubSignature, repoPayloadHash } from '../src/connectors/github.ts';
import { SyncRunner, connectionHealth } from '../src/connectors/sync.ts';
import { HttpClient, nextPageUrl } from '../src/connectors/http.ts';
import { interpretAgentEvent, claudeCodeHookSnippet } from '../src/connectors/agent-events.ts';
import { encryptSecret } from '../src/security/secrets.ts';
import { PortabilityEngine } from '../src/engines/portability.ts';
import { CONNECTORS, ROADMAP_CONNECTORS } from '../src/connectors/registry.ts';
import type { ConnectorContext } from '../src/connectors/types.ts';

const APP_SECRET = 'test-app-secret-at-least-16-chars';

function ctx(over: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    connector: 'github',
    accountLabel: 'octocat',
    credential: 'ghp_test_token',
    allowlist: [],
    cursor: null,
    privacy: { excludedPaths: [], excludedCategories: [], allowFileContentImport: true },
    ...over,
  };
}

function githubAccount(f: ReturnType<typeof makeWorkspace>, allowlist: string[] = []) {
  return f.store.accounts.create({
    workspaceId: f.workspace.id,
    connector: 'github',
    accountLabel: 'octocat',
    credentialCipher: encryptSecret('ghp_test_token', APP_SECRET),
    scopes: ['repo:read'],
    allowlist,
  });
}

describe('github connector: verify', () => {
  test('reports the account and scopes on success', async () => {
    const { fetch } = mockFetch([{ match: /\/user$/, body: { login: 'octocat' }, headers: { 'x-oauth-scopes': 'repo, read:user' } }]);
    const r = await new GitHubConnector().verify(ctx({ fetchImpl: fetch }));
    assert.equal(r.ok, true);
    assert.equal(r.accountLabel, 'octocat');
    assert.deepEqual(r.scopes, ['repo', 'read:user']);
  });

  test('explains a rejected token instead of failing silently', async () => {
    const { fetch } = mockFetch([{ match: /\/user$/, status: 401, body: { message: 'Bad credentials' } }]);
    const r = await new GitHubConnector().verify(ctx({ fetchImpl: fetch }));
    assert.equal(r.ok, false);
    assert.match(r.error!, /401/);
  });

  test('refuses to verify with no token at all', async () => {
    const r = await new GitHubConnector().verify(ctx({ credential: null }));
    assert.equal(r.ok, false);
    assert.match(r.error!, /no token/);
  });
});

describe('github connector: fetch', () => {
  test('turns repositories into sources, candidates, metrics and activity', async () => {
    const { fetch } = mockFetch([
      { match: /\/user\/repos/, body: [ghRepo({ name: 'ai-brain' })] },
      { match: /\/commits/, body: [{ sha: 'abc1234def', html_url: 'https://github.com/c/1', commit: { message: 'Add storage layer\n\nbody', author: { name: 'Octo', date: '2026-10-01T10:00:00Z' } }, author: { login: 'octocat' } }] },
      // Newest run first, failing, as GitHub would report a freshly broken build.
      { match: /\/actions\/runs/, body: { total_count: 2, workflow_runs: [
        { id: 2, name: 'ci', conclusion: 'failure', status: 'completed', created_at: '2026-10-01T11:00:00Z', html_url: 'https://github.com/r/2', head_branch: 'main' },
        { id: 1, name: 'ci', conclusion: 'success', status: 'completed', created_at: '2026-09-30T11:00:00Z', html_url: 'https://github.com/r/1', head_branch: 'main' },
      ] } },
    ]);

    const r = await new GitHubConnector().fetch(ctx({ fetchImpl: fetch }));
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0]!.kind, 'repository');
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0]!.name, 'ai-brain');
    assert.equal(r.candidates[0]!.sourceId, null, 'the connector does not invent a source row id');

    const ciMetric = r.metrics.find((m) => m.key === 'ci_pass_rate');
    assert.ok(ciMetric, 'CI pass rate is computed from real runs');
    assert.equal(ciMetric!.value, 50, '1 of 2 finished runs passed');
    assert.ok(r.activity.some((a) => a.kind === 'commit' && a.summary.includes('Add storage layer')));
    assert.ok(r.activity.some((a) => a.kind === 'ci.failed'), 'a failing latest run is recorded as activity');
    assert.equal(r.cursor, '2026-10-01T12:00:00Z', 'the cursor is the newest pushed_at seen');
  });

  test('a fork gets lower confidence than an owned repository', async () => {
    const { fetch } = mockFetch([
      { match: /\/user\/repos/, body: [ghRepo({ name: 'forked', fork: true, description: null })] },
      { match: /\/commits/, body: [] },
      { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
    ]);
    const r = await new GitHubConnector().fetch(ctx({ fetchImpl: fetch }));
    assert.ok(r.candidates[0]!.connectorConfidence! < 0.7, `fork confidence was ${r.candidates[0]!.connectorConfidence}`);
  });

  test('an allowlist excludes everything outside it, and says how many', async () => {
    const { fetch } = mockFetch([
      { match: /\/user\/repos/, body: [ghRepo({ name: 'wanted' }), ghRepo({ name: 'unwanted', full_name: 'octocat/unwanted', node_id: 'other' })] },
      { match: /\/commits/, body: [] },
      { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
    ]);
    const r = await new GitHubConnector().fetch(ctx({ fetchImpl: fetch, allowlist: ['octocat/wanted'] }));
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0]!.name, 'wanted');
    assert.equal(r.skippedByPrivacy, 1, 'skipped items are counted, not hidden');
  });

  test('an owner-only allowlist entry authorizes that owner', async () => {
    const { fetch } = mockFetch([
      { match: /\/user\/repos/, body: [ghRepo({ name: 'mine' }), ghRepo({ name: 'theirs', full_name: 'someone-else/theirs', node_id: 'z' })] },
      { match: /\/commits/, body: [] },
      { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
    ]);
    const r = await new GitHubConnector().fetch(ctx({ fetchImpl: fetch, allowlist: ['octocat'] }));
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0]!.locator, 'octocat/mine');
  });

  test('a glob allowlist entry works', async () => {
    const { fetch } = mockFetch([
      { match: /\/user\/repos/, body: [ghRepo({ name: 'app-web', full_name: 'octocat/app-web' }), ghRepo({ name: 'lib', full_name: 'octocat/lib', node_id: 'z' })] },
      { match: /\/commits/, body: [] },
      { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
    ]);
    const r = await new GitHubConnector().fetch(ctx({ fetchImpl: fetch, allowlist: ['octocat/app-*'] }));
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0]!.name, 'app-web');
  });

  test('the cursor short-circuits repositories already seen', async () => {
    const { fetch, calls } = mockFetch([
      { match: /\/user\/repos/, body: [ghRepo({ name: 'old', pushed_at: '2026-01-01T00:00:00Z' })] },
    ]);
    const r = await new GitHubConnector().fetch(ctx({ fetchImpl: fetch, cursor: '2026-06-01T00:00:00Z' }));
    assert.equal(r.candidates.length, 0, 'nothing newer than the cursor');
    assert.equal(calls.filter((c) => c.includes('/commits')).length, 0, 'no detail calls for unchanged repos');
  });

  test('reports a listing failure as a warning rather than throwing', async () => {
    const { fetch } = mockFetch([{ match: /\/user\/repos/, status: 403, body: { message: 'Forbidden' } }]);
    const r = await new GitHubConnector().fetch(ctx({ fetchImpl: fetch }));
    assert.equal(r.candidates.length, 0);
    assert.ok(r.warnings.some((w) => w.includes('Listing repositories failed')));
  });

  test('says when detail was budgeted rather than silently truncating', async () => {
    const repos = Array.from({ length: 30 }, (_, i) =>
      ghRepo({ name: `repo-${i}`, full_name: `octocat/repo-${i}`, node_id: `n${i}`, pushed_at: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` }),
    );
    const { fetch } = mockFetch([
      { match: /\/user\/repos/, body: repos },
      { match: /\/commits/, body: [] },
      { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
    ]);
    const r = await new GitHubConnector().fetch(ctx({ fetchImpl: fetch }));
    assert.equal(r.candidates.length, 30, 'every repo still becomes a candidate');
    assert.ok(r.warnings.some((w) => w.includes('rate limit')), 'the budget is disclosed');
  });

  test('a payload hash is stable regardless of key order', () => {
    const a = repoPayloadHash({ full_name: 'a/b', description: 'x', pushed_at: 'p', topics: ['t'] });
    const b = repoPayloadHash({ topics: ['t'], pushed_at: 'p', description: 'x', full_name: 'a/b' });
    assert.equal(a, b);
  });
});

describe('http client resilience', () => {
  test('retries a 500 and succeeds', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return n < 3
        ? new Response('{}', { status: 500 })
        : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const http = new HttpClient({ fetchImpl, sleepImpl: noSleep });
    const r = await http.getJson<{ ok: boolean }>('https://example.test/x');
    assert.equal(r.ok, true);
    assert.equal(r.retries, 2);
  });

  test('waits for the rate-limit reset, then proceeds', async () => {
    let n = 0;
    const reset = Math.floor(Date.now() / 1000) + 2;
    const fetchImpl = (async () => {
      n++;
      return n === 1
        ? new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } })
        : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const http = new HttpClient({ fetchImpl, sleepImpl: noSleep });
    const r = await http.getJson<{ ok: boolean }>('https://example.test/x');
    assert.equal(r.ok, true);
    assert.equal(r.rateLimitWaits, 1);
  });

  test('gives up when the reset is beyond the run budget', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const fetchImpl = (async () =>
      new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': String(reset) } })) as unknown as typeof fetch;

    const http = new HttpClient({ fetchImpl, sleepImpl: noSleep, maxRateLimitWaitMs: 5000 });
    const r = await http.getJson('https://example.test/x');
    assert.equal(r.ok, false);
    assert.match(r.error!, /rate limited/);
  });

  test('a network error is reported, not thrown', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const http = new HttpClient({ fetchImpl, sleepImpl: noSleep, maxAttempts: 2 });
    const r = await http.getJson('https://example.test/x');
    assert.equal(r.ok, false);
    assert.match(r.error!, /ECONNREFUSED/);
  });

  test('parses Link headers for pagination', () => {
    const headers = new Headers({ link: '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=9>; rel="last"' });
    assert.equal(nextPageUrl(headers), 'https://api.github.com/user/repos?page=2');
    assert.equal(nextPageUrl(new Headers()), null);
  });
});

describe('sync runner', () => {
  test('a first sync creates projects and records honest stats', async () => {
    const f = makeWorkspace({ profile: 'developer', automationLevel: 'automatic' });
    const account = githubAccount(f);
    const { fetch } = mockFetch([
      { match: /\/user\/repos/, body: [ghRepo({ name: 'ai-brain' })] },
      { match: /\/commits/, body: [] },
      { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
    ]);

    const runner = new SyncRunner(f.store);
    const out = await runner.run(f.workspace.id, account.id, { trigger: 'manual', appSecret: APP_SECRET, fetchImpl: fetch });

    assert.equal(out.stats.projectsCreated, 1);
    assert.equal(out.stats.sourcesWritten, 1);
    assert.equal(f.store.projects.list(f.workspace.id).length, 1);
    assert.ok(f.store.accounts.byId(f.workspace.id, account.id)!.lastSyncAt);
    assert.ok(f.store.accounts.byId(f.workspace.id, account.id)!.cursor);
    f.close();
  });

  test('a second sync over unchanged data writes nothing', async () => {
    const f = makeWorkspace({ profile: 'developer', automationLevel: 'automatic' });
    const account = githubAccount(f);
    const repo = ghRepo({ name: 'ai-brain' });
    const routes = [
      { match: /\/user\/repos/, body: [repo] },
      { match: /\/commits/, body: [] },
      { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
    ];
    const runner = new SyncRunner(f.store);

    await runner.run(f.workspace.id, account.id, { trigger: 'manual', appSecret: APP_SECRET, fetchImpl: mockFetch(routes).fetch });
    // Clearing the cursor forces the repo to be re-seen, which is the harder
    // case: idempotency must come from the source hash, not just the cursor.
    f.store.accounts.update(f.workspace.id, account.id, { cursor: null });
    const second = await runner.run(f.workspace.id, account.id, { trigger: 'manual', appSecret: APP_SECRET, fetchImpl: mockFetch(routes).fetch });

    assert.equal(second.stats.sourcesSeen, 1);
    assert.equal(second.stats.sourcesWritten, 0, 'an unchanged source is not rewritten');
    assert.equal(second.stats.projectsCreated, 0);
    assert.equal(f.store.projects.list(f.workspace.id).length, 1, 'no duplicate project');
    f.close();
  });

  test('a repository rename updates the existing project', async () => {
    const f = makeWorkspace({ profile: 'developer', automationLevel: 'automatic' });
    const account = githubAccount(f);
    const runner = new SyncRunner(f.store);

    await runner.run(f.workspace.id, account.id, {
      trigger: 'manual', appSecret: APP_SECRET,
      fetchImpl: mockFetch([
        { match: /\/user\/repos/, body: [ghRepo({ name: 'old-name' })] },
        { match: /\/commits/, body: [] }, { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
      ]).fetch,
    });
    f.store.accounts.update(f.workspace.id, account.id, { cursor: null });
    const second = await runner.run(f.workspace.id, account.id, {
      trigger: 'manual', appSecret: APP_SECRET,
      fetchImpl: mockFetch([
        { match: /\/user\/repos/, body: [ghRepo({ name: 'new-name', full_name: 'octocat/new-name' })] },
        { match: /\/commits/, body: [] }, { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
      ]).fetch,
    });

    assert.equal(second.stats.projectsCreated, 0);
    assert.equal(second.stats.projectsUpdated, 1);
    const projects = f.store.projects.list(f.workspace.id);
    assert.equal(projects.length, 1);
    assert.equal(projects[0]!.name, 'new-name');
    assert.ok(projects[0]!.aliases.includes('old-name'));
    f.close();
  });

  test('"review" automation queues discoveries instead of registering them', async () => {
    const f = makeWorkspace({ profile: 'developer', automationLevel: 'review' });
    const account = githubAccount(f);
    const out = await new SyncRunner(f.store).run(f.workspace.id, account.id, {
      trigger: 'manual', appSecret: APP_SECRET,
      fetchImpl: mockFetch([
        { match: /\/user\/repos/, body: [ghRepo({ name: 'ai-brain' })] },
        { match: /\/commits/, body: [] }, { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
      ]).fetch,
    });
    assert.equal(out.stats.projectsCreated, 0);
    assert.equal(out.stats.projectsQueuedForReview, 1);
    assert.equal(out.queuedForReview[0]!.name, 'ai-brain');
    assert.ok(out.queuedForReview[0]!.reason.includes('review'));
    f.close();
  });

  test('a failed sync is recorded and the account is recoverable', async () => {
    const f = makeWorkspace({ profile: 'developer' });
    const account = githubAccount(f);
    const runner = new SyncRunner(f.store);

    // Wrong app secret: the credential cannot be decrypted.
    await assert.rejects(
      () => runner.run(f.workspace.id, account.id, { trigger: 'manual', appSecret: 'a-different-secret-16ch', fetchImpl: mockFetch([]).fetch }),
      /could not be decrypted/,
    );

    const failed = f.store.accounts.byId(f.workspace.id, account.id)!;
    assert.equal(failed.status, 'error');
    assert.ok(failed.lastError);
    const run = f.store.syncRuns.latestFor(f.workspace.id, account.id)!;
    assert.equal(run.status, 'failed');
    assert.ok(run.finishedAt, 'a failed run is still closed out');

    // Recovery: the same account syncs cleanly with the right secret.
    const out = await runner.run(f.workspace.id, account.id, {
      trigger: 'manual', appSecret: APP_SECRET,
      fetchImpl: mockFetch([
        { match: /\/user\/repos/, body: [ghRepo({ name: 'ai-brain' })] },
        { match: /\/commits/, body: [] }, { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
      ]).fetch,
    });
    assert.notEqual(out.run.status, 'failed');
    assert.equal(f.store.accounts.byId(f.workspace.id, account.id)!.status, 'active');
    f.close();
  });

  test('a revoked connection refuses to sync', async () => {
    const f = makeWorkspace();
    const account = githubAccount(f);
    f.store.accounts.revoke(f.workspace.id, account.id);
    await assert.rejects(
      () => new SyncRunner(f.store).run(f.workspace.id, account.id, { trigger: 'manual', appSecret: APP_SECRET }),
      /revoked/,
    );
    f.close();
  });

  test('metrics are only written when the value actually changes', async () => {
    const f = makeWorkspace({ profile: 'developer', automationLevel: 'automatic' });
    const account = githubAccount(f);
    const routes = [
      { match: /\/user\/repos/, body: [ghRepo({ name: 'ai-brain' })] },
      { match: /\/commits/, body: [] },
      { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
    ];
    const runner = new SyncRunner(f.store);
    const first = await runner.run(f.workspace.id, account.id, { trigger: 'manual', appSecret: APP_SECRET, fetchImpl: mockFetch(routes).fetch });
    assert.ok(first.stats.metricsWritten > 0);

    f.store.accounts.update(f.workspace.id, account.id, { cursor: null });
    const second = await runner.run(f.workspace.id, account.id, { trigger: 'manual', appSecret: APP_SECRET, fetchImpl: mockFetch(routes).fetch });
    assert.equal(second.stats.metricsWritten, 0, 'identical metric values are not re-recorded');
    f.close();
  });

  test('connection health reports real freshness and completeness', async () => {
    const f = makeWorkspace({ profile: 'developer', automationLevel: 'automatic' });
    const account = githubAccount(f, ['octocat/ai-brain']);
    await new SyncRunner(f.store).run(f.workspace.id, account.id, {
      trigger: 'manual', appSecret: APP_SECRET,
      fetchImpl: mockFetch([
        { match: /\/user\/repos/, body: [ghRepo({ name: 'ai-brain' })] },
        { match: /\/commits/, body: [] }, { match: /\/actions\/runs/, body: { total_count: 0, workflow_runs: [] } },
      ]).fetch,
    });

    const health = connectionHealth(f.store, f.workspace.id);
    assert.equal(health.length, 1);
    assert.ok(health[0]!.freshnessSeconds !== null && health[0]!.freshnessSeconds < 60);
    assert.ok(health[0]!.completeness.includes('1 item(s) you allowlisted'));
    assert.ok(health[0]!.limitations.length > 0, 'limitations are always surfaced');
    f.close();
  });

  test('a never-synced connection says so rather than showing a green light', () => {
    const f = makeWorkspace();
    githubAccount(f);
    const health = connectionHealth(f.store, f.workspace.id);
    assert.equal(health[0]!.freshnessSeconds, null);
    assert.ok(health[0]!.completeness.includes('Never synced'));
    f.close();
  });
});

describe('github webhooks', () => {
  test('a valid signature is accepted and an invalid one is not', async () => {
    const { createHmac } = await import('node:crypto');
    const body = JSON.stringify({ zen: 'ok' });
    const secret = 'webhook-secret';
    const good = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    assert.equal(await verifyGitHubSignature(body, good, secret), true);
    assert.equal(await verifyGitHubSignature(body, good, 'wrong-secret'), false);
    assert.equal(await verifyGitHubSignature(`${body} `, good, secret), false);
    assert.equal(await verifyGitHubSignature(body, null, secret), false);
    assert.equal(await verifyGitHubSignature(body, good, ''), false, 'a missing secret must fail closed');
    assert.equal(await verifyGitHubSignature(body, 'sha1=deadbeef', secret), false);
  });

  test('a rename webhook carries the old name as an alias', () => {
    const out = interpretGitHubWebhook('repository', {
      action: 'renamed',
      changes: { repository: { name: { from: 'old-name' } } },
      repository: ghRepo({ name: 'new-name' }),
      sender: { login: 'octocat' },
    });
    assert.equal(out.handled, true);
    assert.ok(out.candidate!.aliases!.includes('old-name'));
    assert.ok(out.note.includes('renamed'));
  });

  test('a webhook rename updates the existing project instead of duplicating it', () => {
    const f = makeWorkspace({ profile: 'developer', automationLevel: 'automatic' });
    const account = githubAccount(f);
    const runner = new SyncRunner(f.store);

    const created = interpretGitHubWebhook('push', { repository: ghRepo({ name: 'old-name' }), commits: [{}], pusher: { name: 'octocat' } });
    runner.apply(f.workspace.id, account, {
      sources: [created.source!], candidates: [created.candidate!], activity: created.activity,
      metrics: [], documents: [], cursor: null, hasMore: false, warnings: [],
      skippedByPrivacy: 0, rateLimitWaits: 0, retries: 0,
    }, { automationLevel: 'automatic', allowFileContentImport: true, excludedCategories: [] });
    assert.equal(f.store.projects.list(f.workspace.id).length, 1);

    const renamed = interpretGitHubWebhook('repository', {
      action: 'renamed', changes: { repository: { name: { from: 'old-name' } } },
      repository: ghRepo({ name: 'new-name' }), sender: { login: 'octocat' },
    });
    const result = runner.apply(f.workspace.id, account, {
      sources: [renamed.source!], candidates: [renamed.candidate!], activity: renamed.activity,
      metrics: [], documents: [], cursor: null, hasMore: false, warnings: [],
      skippedByPrivacy: 0, rateLimitWaits: 0, retries: 0,
    }, { automationLevel: 'automatic', allowFileContentImport: true, excludedCategories: [] });

    assert.equal(result.stats.projectsCreated, 0);
    assert.equal(result.stats.projectsUpdated, 1);
    const projects = f.store.projects.list(f.workspace.id);
    assert.equal(projects.length, 1, 'webhook rename must not duplicate the project');
    assert.equal(projects[0]!.name, 'new-name');
    f.close();
  });

  test('an unmapped event is recorded without pretending to understand it', () => {
    const out = interpretGitHubWebhook('star', { repository: ghRepo(), action: 'created' });
    assert.equal(out.handled, false);
    assert.ok(out.source, 'the repository is still recorded as a source');
    assert.ok(out.note.includes('not mapped'));
  });

  test('an event with no repository is rejected cleanly', () => {
    const out = interpretGitHubWebhook('ping', { zen: 'hello' });
    assert.equal(out.handled, false);
    assert.equal(out.candidate, null);
    assert.ok(out.note.includes('no repository'));
  });
});

describe('agent event ingest', () => {
  test('accepts a well-formed Claude Code event and attaches it to a project', () => {
    const f = makeWorkspace({ profile: 'developer', automationLevel: 'automatic' });
    const account = f.store.accounts.create({
      workspaceId: f.workspace.id, connector: 'claude-code', accountLabel: 'local',
    });
    const event = interpretAgentEvent({
      agent: 'claude-code', kind: 'session.start',
      summary: 'Claude Code session started', cwd: '/Users/me/code/ai-brain',
    });
    assert.equal(event.connector, 'claude-code');
    assert.equal(event.candidate?.name, 'ai-brain');

    const out = new SyncRunner(f.store).applyAgentEvent(f.workspace.id, account, event, 'automatic');
    // 0.7 connector confidence stays under the auto-register threshold, so it
    // waits for review even in automatic mode.
    assert.equal(out.queuedForReview, true);
    assert.equal(f.store.activity.recent(f.workspace.id).length, 1);
    f.close();
  });

  test('collapses many events from one directory onto one project', () => {
    const f = makeWorkspace({ profile: 'developer' });
    const account = f.store.accounts.create({ workspaceId: f.workspace.id, connector: 'claude-code', accountLabel: 'local' });
    const runner = new SyncRunner(f.store);
    for (let i = 0; i < 25; i++) {
      runner.applyAgentEvent(f.workspace.id, account, interpretAgentEvent({
        agent: 'claude-code', kind: 'tool.use', summary: `tool call ${i}`, cwd: '/Users/me/code/ai-brain',
      }), 'review');
    }
    assert.equal(f.store.projects.list(f.workspace.id, { reviewState: ['pending-review'] }).length, 1);
    f.close();
  });

  test('rejects malformed events instead of storing something mangled', () => {
    assert.throws(() => interpretAgentEvent({ agent: 'unknown-agent', kind: 'x', summary: 'y' }), /agent/);
    assert.throws(() => interpretAgentEvent({ agent: 'codex', kind: 'Not A Kind!', summary: 'y' }), /kind/);
    assert.throws(() => interpretAgentEvent({ agent: 'codex', kind: 'session.start', summary: '' }), /summary/);
    assert.throws(() => interpretAgentEvent({ agent: 'codex', kind: 'session.start', summary: 'ok', occurredAt: 'not-a-date' }), /occurredAt/);
    assert.throws(() => interpretAgentEvent('a string'), /JSON object/);
  });

  test('caps detail so a hook cannot post a transcript', () => {
    const detail: Record<string, unknown> = { nested: { deep: true }, big: 'x'.repeat(5000) };
    for (let i = 0; i < 50; i++) detail[`k${i}`] = i;
    const event = interpretAgentEvent({ agent: 'codex', kind: 'tool.use', summary: 'ok', detail });
    const stored = (event.payload as { detail: Record<string, unknown> }).detail;
    assert.ok(Object.keys(stored).length <= 20, 'detail keys are capped');
    assert.ok(!('nested' in stored), 'non-scalar values are dropped');
    assert.ok(String(stored.big ?? '').length <= 300, 'long strings are truncated');
  });

  test('the hook snippet is printed for the user, never installed', () => {
    const snippet = claudeCodeHookSnippet('http://localhost:3000', 'aib_token');
    assert.ok(snippet.includes('SessionStart'));
    assert.ok(snippet.includes('/api/ingest/agent'));
    assert.ok(snippet.includes('aib_token'));
  });

  test('a pull-based sync of an agent connector explains that it cannot poll', async () => {
    const f = makeWorkspace();
    const account = f.store.accounts.create({ workspaceId: f.workspace.id, connector: 'codex', accountLabel: 'local' });
    const out = await new SyncRunner(f.store).run(f.workspace.id, account.id, { trigger: 'manual', appSecret: APP_SECRET });
    assert.equal(out.stats.sourcesSeen, 0);
    assert.ok(out.warnings[0]!.includes('receiver, not a poll source'));
    f.close();
  });
});

describe('connector registry honesty', () => {
  test('every connector declares a mode and its limitations', () => {
    for (const c of Object.values(CONNECTORS)) {
      assert.ok(c.limitations.length > 20, `${c.key} has no meaningful limitations text`);
      assert.ok(['api-poll', 'api-webhook', 'local-filesystem', 'manual-export'].includes(c.mode));
      assert.ok(['supported', 'experimental', 'roadmap'].includes(c.status));
    }
  });

  test('manual-export connectors do not claim to be live', () => {
    for (const c of Object.values(CONNECTORS)) {
      if (c.mode !== 'manual-export') continue;
      assert.match(c.limitations, /import|export|yourself|not a sync|does not update/i, `${c.key} must say it is not live`);
    }
  });

  test('the conversation connector does not claim account-wide chat access', () => {
    assert.match(CONNECTORS['conversation-import'].limitations, /official data export/i);
    assert.match(CONNECTORS['conversation-import'].limitations, /unrestricted account-wide/i);
  });

  test('roadmap connectors are listed separately with a reason', () => {
    assert.ok(ROADMAP_CONNECTORS.length > 0);
    for (const r of ROADMAP_CONNECTORS) assert.ok(r.why.length > 10, `${r.label} has no reason`);
  });
});

describe('portability', () => {
  test('a full export round-trips into a fresh workspace', () => {
    const f = makeWorkspace({ profile: 'developer' });
    const p = f.store.projects.create({ workspaceId: f.workspace.id, name: 'Exported', description: 'keeps its description', category: 'software' });
    const g = f.store.goals.create({ workspaceId: f.workspace.id, projectId: p.id, title: 'Ship it', progress: 40 });
    f.store.tasks.create({ workspaceId: f.workspace.id, projectId: p.id, goalId: g.id, title: 'Write tests' });
    f.store.decisions.create({ workspaceId: f.workspace.id, projectId: p.id, title: 'Use SQLite', choice: 'SQLite', rationale: 'ships with Node' });
    f.store.knowledge.create({ workspaceId: f.workspace.id, projectId: p.id, title: 'Note', body: 'something known' });
    f.store.resources.create({ workspaceId: f.workspace.id, projectId: p.id, kind: 'subscription', name: 'Hosting', amountMinor: 1500, period: 'monthly' });
    f.store.time.log({ workspaceId: f.workspace.id, projectId: p.id, minutes: 90 });

    const engine = new PortabilityEngine(f.store);
    const dump = JSON.parse(JSON.stringify(engine.export(f.workspace.id)));

    // Import into a different workspace in the same installation.
    const target = f.store.workspaces.create({ ownerId: f.user.id, name: 'Restored' });
    const { imported } = new PortabilityEngine(f.store).importWorkspace(target.id, dump);

    // The profile seeds goals of its own, so compare against the export rather
    // than a hard-coded number.
    assert.equal(imported.projects, dump.projects.length);
    assert.equal(imported.goals, dump.goals.length);
    assert.equal(imported.tasks, dump.tasks.length);
    assert.ok(dump.goals.some((g: { title: string }) => g.title === 'Ship it'));
    assert.equal(imported.decisions, 1);
    assert.equal(imported.knowledge, 1);
    assert.equal(imported.resources, 1);
    assert.equal(imported.timeEntries, 1);

    const restored = f.store.projects.list(target.id)[0]!;
    assert.equal(restored.name, 'Exported');
    assert.equal(restored.description, 'keeps its description');
    const restoredTask = f.store.tasks.list(target.id)[0]!;
    assert.equal(restoredTask.projectId, restored.id, 'project references are remapped, not broken');
    assert.notEqual(restoredTask.projectId, p.id, 'ids are new, so an import cannot collide');
    f.close();
  });

  test('an export carries no credentials', () => {
    const f = makeWorkspace();
    githubAccount(f);
    const dump = JSON.stringify(new PortabilityEngine(f.store).export(f.workspace.id));
    assert.ok(!dump.includes('ghp_test_token'));
    assert.ok(!dump.includes(f.user.passwordHash));
    assert.ok(dump.includes('octocat'), 'the connection is still described so it can be rebuilt');
    f.close();
  });

  test('importing warns that connections must be rebuilt', () => {
    const f = makeWorkspace();
    githubAccount(f);
    const dump = JSON.parse(JSON.stringify(new PortabilityEngine(f.store).export(f.workspace.id)));
    const target = f.store.workspaces.create({ ownerId: f.user.id, name: 'Target' });
    const { warnings } = new PortabilityEngine(f.store).importWorkspace(target.id, dump);
    assert.ok(warnings.some((w) => w.includes('credentials are never exported')));
    f.close();
  });

  test('refuses an export from a newer version', () => {
    const f = makeWorkspace();
    assert.throws(() => new PortabilityEngine(f.store).importWorkspace(f.workspace.id, { version: 99 }), /newer than this installation/);
    f.close();
  });

  test('deleting one connector’s data leaves the rest intact', () => {
    const f = makeWorkspace();
    const account = githubAccount(f);
    const { record } = f.store.sources.upsert({
      workspaceId: f.workspace.id, connectedAccountId: account.id, connector: 'github',
      kind: 'repository', externalId: 'n1', locator: 'octocat/x', url: null,
      payload: {}, payloadHash: 'h', observedAt: daysAgo(1),
    });
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'From GitHub', sourceId: record.id, body: 'synced' });
    f.store.knowledge.create({ workspaceId: f.workspace.id, title: 'My own note', body: 'typed by hand' });
    f.store.projects.create({ workspaceId: f.workspace.id, name: 'From GitHub', sourceKey: 'github:n1', origin: 'connector' });

    const { deleted } = new PortabilityEngine(f.store).deleteSourceData(f.workspace.id, 'github');
    assert.equal(deleted.sources, 1);
    assert.equal(deleted.knowledge, 1);
    assert.equal(deleted.projectsArchived, 1, 'connector projects are archived, not destroyed');

    const remaining = f.store.knowledge.list(f.workspace.id);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.title, 'My own note');
    f.close();
  });
});
