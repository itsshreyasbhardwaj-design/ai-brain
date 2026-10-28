/**
 * GitHub connector.
 *
 * Uses only read endpoints with a token the user supplies. Three constraints
 * shape the implementation:
 *
 *   - Allowlist first. A repository is fetched only if the user listed it (or
 *     listed `owner/*`). An empty allowlist means "everything this token can
 *     see", and the UI says so before you save it.
 *   - Incremental. The cursor is the newest `pushed_at` seen, so a second run
 *     over an unchanged account costs one page of requests and writes nothing.
 *   - Budgeted. Per-repository detail calls are capped, so a user with 300
 *     repositories cannot accidentally spend their whole rate limit in one go.
 */

import type { ConnectorAdapter, ConnectorContext, FetchResult, SourcePayload } from './types.ts';
import { emptyFetchResult } from './types.ts';
import type { ProjectCandidate } from '../engines/discovery.ts';
import type { ProjectCategory, Lifecycle } from '../domain/types.ts';
import { HttpClient, nextPageUrl } from './http.ts';
import { contentHash } from '../util/id.ts';
import { globMatch } from '../security/redact.ts';

const API = 'https://api.github.com';

interface GhRepo {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  disabled?: boolean;
  html_url: string;
  language: string | null;
  default_branch: string;
  topics?: string[];
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  size: number;
  pushed_at: string | null;
  created_at: string;
  updated_at: string;
  owner: { login: string; type: string };
  parent?: { node_id: string; full_name: string };
}

interface GhCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name?: string; date?: string } | null };
  author: { login?: string } | null;
}

interface GhWorkflowRuns {
  total_count: number;
  workflow_runs: Array<{ id: number; name: string | null; conclusion: string | null; status: string; created_at: string; html_url: string; head_branch: string | null }>;
}

/** Repositories whose detail endpoints we call per run. Keeps rate limits sane. */
const DETAIL_BUDGET = 25;

export class GitHubConnector implements ConnectorAdapter {
  readonly key = 'github' as const;

  async verify(ctx: ConnectorContext): Promise<{ ok: boolean; accountLabel: string; scopes: string[]; error?: string }> {
    if (!ctx.credential) return { ok: false, accountLabel: '', scopes: [], error: 'no token provided' };
    const http = this.client(ctx);
    const res = await http.getJson<{ login: string }>(`${API}/user`);
    if (!res.ok || !res.data) {
      return {
        ok: false, accountLabel: '', scopes: [],
        error: res.status === 401 ? 'GitHub rejected the token (401). Check that it is valid and not expired.' : res.error ?? 'verification failed',
      };
    }
    const scopes = (res.headers.get('x-oauth-scopes') ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    return { ok: true, accountLabel: res.data.login, scopes };
  }

  async fetch(ctx: ConnectorContext): Promise<FetchResult> {
    const out = emptyFetchResult();
    if (!ctx.credential) {
      out.warnings.push('No GitHub token is stored for this account, so nothing was fetched.');
      return out;
    }

    const http = this.client(ctx);
    const since = ctx.cursor;
    const maxItems = ctx.maxItems ?? 300;
    let newestPushedAt = since;

    // 1. Repository list, newest-pushed first so the cursor can short-circuit.
    let url: string | null = `${API}/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100`;
    const repos: GhRepo[] = [];
    let pages = 0;

    while (url && repos.length < maxItems && pages < 10) {
      const res = await http.getJson<GhRepo[]>(url);
      if (!res.ok || !res.data) {
        out.warnings.push(`Listing repositories failed: ${res.error ?? 'unknown error'}`);
        break;
      }
      pages++;
      let reachedCursor = false;
      for (const repo of res.data) {
        if (!this.allowed(repo.full_name, ctx.allowlist)) { out.skippedByPrivacy++; continue; }
        if (repo.disabled) continue;
        // Everything after this point in a pushed-desc list is older than the
        // cursor, so there is nothing new left to see.
        if (since && repo.pushed_at && repo.pushed_at <= since) { reachedCursor = true; break; }
        repos.push(repo);
      }
      if (reachedCursor) break;
      url = nextPageUrl(res.headers);
      if (url && repos.length >= maxItems) { out.hasMore = true; break; }
    }
    if (url && repos.length >= maxItems) out.hasMore = true;

    // 2. One source record and one candidate per repository.
    for (const repo of repos) {
      if (repo.pushed_at && (!newestPushedAt || repo.pushed_at > newestPushedAt)) newestPushedAt = repo.pushed_at;

      const observedAt = new Date().toISOString();
      const payload: Record<string, unknown> = {
        id: repo.id, full_name: repo.full_name, name: repo.name, description: repo.description,
        private: repo.private, fork: repo.fork, archived: repo.archived, language: repo.language,
        default_branch: repo.default_branch, topics: repo.topics ?? [],
        stargazers_count: repo.stargazers_count, forks_count: repo.forks_count,
        open_issues_count: repo.open_issues_count, size_kb: repo.size,
        pushed_at: repo.pushed_at, created_at: repo.created_at, owner: repo.owner.login,
      };
      const source: SourcePayload = {
        kind: 'repository',
        externalId: repo.node_id,
        locator: repo.full_name,
        url: repo.html_url,
        payload,
        observedAt,
      };
      out.sources.push(source);

      const candidate: ProjectCandidate = {
        connector: 'github',
        externalId: repo.node_id,
        name: repo.name,
        description: repo.description ?? '',
        category: categoryFor(repo),
        lifecycle: lifecycleFor(repo),
        tags: [...(repo.topics ?? []), ...(repo.language ? [repo.language.toLowerCase()] : [])].slice(0, 12),
        url: repo.html_url,
        locator: repo.full_name,
        sourceId: null, // the sync runner fills this in once the source row exists
        lastActivityAt: repo.pushed_at,
        aliases: [repo.full_name],
        // A fork is likelier to be someone else's work than a project of yours.
        connectorConfidence: repo.fork ? 0.55 : repo.description ? 0.9 : 0.82,
      };
      if (repo.parent?.node_id) {
        candidate.relatedExternalIds = [{ externalId: repo.parent.node_id, kind: 'fork-of' }];
      }
      out.candidates.push(candidate);

      // Metrics: straight from the repository payload, so each is observed.
      const key = `github:${repo.node_id}`;
      for (const [metricKey, label, value, unit] of [
        ['stars', 'Stars', repo.stargazers_count, ''],
        ['forks', 'Forks', repo.forks_count, ''],
        ['open_issues', 'Open issues and PRs', repo.open_issues_count, ''],
        ['repo_size', 'Repository size', repo.size, 'KB'],
      ] as Array<[string, string, number, string]>) {
        out.metrics.push({ projectSourceKey: key, key: metricKey, label, value, unit, observedAt });
      }

      out.activity.push({
        projectSourceKey: key,
        kind: 'repository.pushed',
        summary: `Pushed to ${repo.full_name}${repo.default_branch ? ` (${repo.default_branch})` : ''}`,
        url: repo.html_url,
        actor: repo.owner.login,
        occurredAt: repo.pushed_at ?? observedAt,
        sourceExternalId: repo.node_id,
      });
    }

    // 3. Detail calls for the most recently active repositories only.
    const detailed = repos
      .filter((r) => !r.archived && r.pushed_at)
      .sort((a, b) => (b.pushed_at ?? '').localeCompare(a.pushed_at ?? ''))
      .slice(0, DETAIL_BUDGET);
    if (repos.length > detailed.length) {
      out.warnings.push(
        `Commit and CI detail was fetched for the ${detailed.length} most recently active of ${repos.length} repositories, to stay inside the API rate limit. The rest will be covered on later syncs.`,
      );
    }

    for (const repo of detailed) {
      const key = `github:${repo.node_id}`;
      const commitsUrl = `${API}/repos/${repo.full_name}/commits?per_page=20${since ? `&since=${encodeURIComponent(since)}` : ''}`;
      const commits = await http.getJson<GhCommit[]>(commitsUrl);
      if (commits.ok && commits.data) {
        for (const c of commits.data.slice(0, 20)) {
          const firstLine = (c.commit?.message ?? '').split('\n')[0]!.slice(0, 200);
          out.activity.push({
            projectSourceKey: key,
            kind: 'commit',
            summary: `${c.sha.slice(0, 7)} ${firstLine}`,
            url: c.html_url,
            actor: c.author?.login ?? c.commit?.author?.name ?? null,
            occurredAt: c.commit?.author?.date ?? repo.pushed_at ?? new Date().toISOString(),
            sourceExternalId: repo.node_id,
          });
        }
        if (commits.data.length > 0) {
          out.metrics.push({
            projectSourceKey: key, key: 'commits_recent', label: 'Commits since last sync',
            value: commits.data.length, unit: '', observedAt: new Date().toISOString(),
          });
        }
      } else if (commits.status !== 409) {
        // 409 is an empty repository, which is normal and not worth reporting.
        out.warnings.push(`Commits for ${repo.full_name}: ${commits.error ?? 'failed'}`);
      }

      const runs = await http.getJson<GhWorkflowRuns>(
        `${API}/repos/${repo.full_name}/actions/runs?per_page=20&branch=${encodeURIComponent(repo.default_branch)}`,
      );
      if (runs.ok && runs.data && runs.data.workflow_runs.length > 0) {
        const finished = runs.data.workflow_runs
          .filter((r) => r.conclusion !== null)
          // Sort rather than trusting the API's order, so "latest run" is
          // actually the latest run.
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        if (finished.length > 0) {
          const passed = finished.filter((r) => r.conclusion === 'success').length;
          const observedAt = new Date().toISOString();
          out.metrics.push({
            projectSourceKey: key, key: 'ci_pass_rate', label: 'CI pass rate (last runs)',
            value: Math.round((passed / finished.length) * 100), unit: '%', target: 100, observedAt,
          });
          out.metrics.push({
            projectSourceKey: key, key: 'ci_runs_sampled', label: 'CI runs sampled',
            value: finished.length, unit: '', observedAt,
          });
          const latest = finished[0]!;
          if (latest.conclusion !== 'success') {
            out.activity.push({
              projectSourceKey: key, kind: 'ci.failed',
              summary: `CI ${latest.conclusion} on ${latest.head_branch ?? repo.default_branch}: ${latest.name ?? 'workflow'}`,
              url: latest.html_url, actor: null, occurredAt: latest.created_at,
              sourceExternalId: repo.node_id,
            });
          }
        }
      }
    }

    out.cursor = newestPushedAt;
    out.retries = http.retries;
    out.rateLimitWaits = http.rateLimitWaits;
    return out;
  }

  private client(ctx: ConnectorContext): HttpClient {
    const opts: ConstructorParameters<typeof HttpClient>[0] = {
      headers: {
        authorization: `Bearer ${ctx.credential}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ai-brain-connector',
      },
    };
    if (ctx.fetchImpl) opts.fetchImpl = ctx.fetchImpl;
    if (ctx.signal) opts.signal = ctx.signal;
    return new HttpClient(opts);
  }

  /** Empty allowlist means the token's full scope; otherwise exact or glob. */
  private allowed(fullName: string, allowlist: string[]): boolean {
    if (allowlist.length === 0) return true;
    const lower = fullName.toLowerCase();
    return allowlist.some((entry) => {
      const e = entry.trim().toLowerCase();
      if (e === '') return false;
      if (e === lower) return true;
      if (e.includes('*')) return globMatch(lower, e);
      // "owner" alone authorizes everything under that owner.
      return !e.includes('/') && lower.startsWith(`${e}/`);
    });
  }
}

function categoryFor(repo: GhRepo): ProjectCategory {
  const topics = (repo.topics ?? []).map((t) => t.toLowerCase());
  if (topics.some((t) => /research|paper|dataset/.test(t))) return 'research';
  if (topics.some((t) => /blog|content|writing/.test(t))) return 'content';
  return 'software';
}

function lifecycleFor(repo: GhRepo): Lifecycle {
  if (repo.archived) return 'archived';
  if (!repo.pushed_at) return 'idea';
  const days = (Date.now() - new Date(repo.pushed_at).getTime()) / 86_400_000;
  if (days > 365) return 'paused';
  return 'active';
}

/** Stable hash of the fields we care about, so unchanged repos are no-ops. */
export function repoPayloadHash(payload: Record<string, unknown>): string {
  return contentHash(
    String(payload.full_name ?? ''), String(payload.description ?? ''),
    String(payload.pushed_at ?? ''), String(payload.archived ?? ''),
    String(payload.open_issues_count ?? ''), String(payload.stargazers_count ?? ''),
    String(payload.default_branch ?? ''), JSON.stringify(payload.topics ?? []),
  );
}

/* ---------------------------------------------------------------- */
/* Webhooks                                                          */
/* ---------------------------------------------------------------- */

/**
 * Verifies a GitHub webhook signature.
 *
 * Constant-time comparison, and a missing secret is a hard failure rather than
 * a skipped check — an unverified webhook is an open write endpoint.
 */
export async function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const [algo, provided] = signatureHeader.split('=');
  if (algo !== 'sha256' || !provided) return false;
  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}

export interface WebhookOutcome {
  handled: boolean;
  event: string;
  /** Candidate to run through discovery, when the event names a repository. */
  candidate: ProjectCandidate | null;
  source: SourcePayload | null;
  activity: FetchResult['activity'];
  note: string;
}

/** Maps a webhook body to the same shapes a poll produces. */
export function interpretGitHubWebhook(event: string, body: Record<string, unknown>): WebhookOutcome {
  const repo = body.repository as GhRepo | undefined;
  const base: WebhookOutcome = { handled: false, event, candidate: null, source: null, activity: [], note: '' };
  if (!repo?.node_id) return { ...base, note: 'event carries no repository, so there is nothing to attach it to' };

  const observedAt = new Date().toISOString();
  const key = `github:${repo.node_id}`;
  const source: SourcePayload = {
    kind: 'repository',
    externalId: repo.node_id,
    locator: repo.full_name,
    url: repo.html_url,
    payload: {
      id: repo.id, full_name: repo.full_name, name: repo.name, description: repo.description,
      private: repo.private, fork: repo.fork, archived: repo.archived, language: repo.language,
      default_branch: repo.default_branch, topics: repo.topics ?? [],
      stargazers_count: repo.stargazers_count ?? 0, forks_count: repo.forks_count ?? 0,
      open_issues_count: repo.open_issues_count ?? 0, size_kb: repo.size ?? 0,
      pushed_at: repo.pushed_at, created_at: repo.created_at, owner: repo.owner?.login,
    },
    observedAt,
  };

  const candidate: ProjectCandidate = {
    connector: 'github', externalId: repo.node_id, name: repo.name,
    description: repo.description ?? '', category: categoryFor(repo), lifecycle: lifecycleFor(repo),
    tags: repo.topics ?? [], url: repo.html_url, locator: repo.full_name, sourceId: null,
    lastActivityAt: repo.pushed_at ?? observedAt, aliases: [repo.full_name],
    connectorConfidence: 0.9,
  };

  const activity: FetchResult['activity'] = [];
  let note = '';

  switch (event) {
    case 'repository': {
      const action = String(body.action ?? '');
      if (action === 'renamed') {
        const from = (body.changes as { repository?: { name?: { from?: string } } } | undefined)?.repository?.name?.from;
        if (from) candidate.aliases = [...(candidate.aliases ?? []), from];
        note = `repository renamed${from ? ` from ${from}` : ''}`;
      } else {
        note = `repository ${action}`;
      }
      activity.push({
        projectSourceKey: key, kind: `repository.${action}`,
        summary: `Repository ${action}: ${repo.full_name}`, url: repo.html_url,
        actor: (body.sender as { login?: string } | undefined)?.login ?? null,
        occurredAt: observedAt, sourceExternalId: repo.node_id,
      });
      break;
    }
    case 'push': {
      const commits = Array.isArray(body.commits) ? body.commits : [];
      note = `${commits.length} commit(s) pushed`;
      activity.push({
        projectSourceKey: key, kind: 'repository.pushed',
        summary: `Pushed ${commits.length} commit(s) to ${String(body.ref ?? '').replace('refs/heads/', '')}`,
        url: typeof body.compare === 'string' ? body.compare : repo.html_url,
        actor: (body.pusher as { name?: string } | undefined)?.name ?? null,
        occurredAt: observedAt, sourceExternalId: repo.node_id,
      });
      break;
    }
    case 'create':
    case 'workflow_run':
    case 'pull_request':
    case 'issues': {
      const action = String(body.action ?? body.ref_type ?? '');
      note = `${event} ${action}`;
      activity.push({
        projectSourceKey: key, kind: `${event}.${action || 'event'}`,
        summary: `${event} ${action} in ${repo.full_name}`, url: repo.html_url,
        actor: (body.sender as { login?: string } | undefined)?.login ?? null,
        occurredAt: observedAt, sourceExternalId: repo.node_id,
      });
      break;
    }
    default:
      return { ...base, source, candidate, note: `event "${event}" is recorded as a source update but not mapped to activity` };
  }

  return { handled: true, event, candidate, source, activity, note };
}
