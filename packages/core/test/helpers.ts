/**
 * Test fixtures.
 *
 * Every test gets its own in-memory database, so tests are order-independent
 * and leave nothing behind. `makeWorkspace` goes through the real registration
 * path rather than inserting rows directly, which means the fixtures exercise
 * the same code the application does.
 */

import { openDb, type Db } from '../src/db/client.ts';
import { Store } from '../src/db/repositories.ts';
import { AuthService } from '../src/engines/auth.ts';
import type { OnboardingAnswers } from '../src/engines/brain-config.ts';
import type { BrainConfiguration, User, Workspace } from '../src/domain/types.ts';

export interface Fixture {
  db: Db;
  store: Store;
  auth: AuthService;
  user: User;
  workspace: Workspace;
  config: BrainConfiguration;
  token: string;
  close(): void;
}

let counter = 0;

export function makeWorkspace(onboarding?: OnboardingAnswers): Fixture {
  const db = openDb({ path: ':memory:' });
  const store = new Store(db);
  const auth = new AuthService(store);
  const n = ++counter;
  const { user, workspace, token } = auth.register({
    email: `user${n}@example.test`,
    displayName: `User ${n}`,
    password: 'a-sufficiently-long-password',
    workspaceName: `Workspace ${n}`,
    ...(onboarding ? { onboarding } : {}),
  });
  const config = store.brainConfig.current(workspace.id)!;
  return { db, store, auth, user, workspace, config, token, close: () => db.close() };
}

/** A second account in the same database, for isolation tests. */
export function addSecondUser(f: Fixture): { user: User; workspace: Workspace; token: string } {
  const n = ++counter;
  return f.auth.register(
    {
      email: `other${n}@example.test`,
      displayName: `Other ${n}`,
      password: 'another-sufficiently-long-password',
      workspaceName: `Other workspace ${n}`,
    },
    { allowAdditional: true },
  );
}

/** A fetch stand-in that replays scripted responses and records requests. */
export function mockFetch(
  routes: Array<{ match: RegExp; status?: number; body?: unknown; headers?: Record<string, string>; throws?: string }>,
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const route = routes.find((r) => r.match.test(url));
    if (!route) {
      return new Response(JSON.stringify({ message: 'no mock route' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    if (route.throws) throw new Error(route.throws);
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...route.headers },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** A fake GitHub repository payload. */
export function ghRepo(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const name = String(over.name ?? 'hello-world');
  return {
    id: 1296269,
    // Deliberately NOT derived from the name: GitHub's node_id survives a
    // rename, and the deduplication tests depend on that being true here too.
    node_id: 'MDEwOlJlcG9zaXRvcnkxMjk2MjY5',
    name,
    full_name: `octocat/${name}`,
    description: 'A repository that exists',
    private: false,
    fork: false,
    archived: false,
    html_url: `https://github.com/octocat/${name}`,
    language: 'TypeScript',
    default_branch: 'main',
    topics: ['cli'],
    stargazers_count: 42,
    forks_count: 3,
    open_issues_count: 5,
    size: 108,
    pushed_at: '2026-10-01T12:00:00Z',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2026-10-01T12:00:00Z',
    owner: { login: 'octocat', type: 'User' },
    ...over,
  };
}

/** Sleeps zero ms, for exercising retry paths without real delay. */
export const noSleep = async (): Promise<void> => {};

export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

export function dayStringAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}
