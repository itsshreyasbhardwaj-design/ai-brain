/**
 * Server-side context for the web app.
 *
 * One SQLite handle per process, shared across requests — `node:sqlite` is
 * synchronous and WAL-backed, so a single connection is both correct and
 * faster than a pool here. Everything that reads or writes goes through
 * `requireContext`, which resolves the workspace from the session cookie and
 * never from anything the client sends.
 */

import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { openDb, type Db } from '@ai-brain/core/db';
import { Store } from '@ai-brain/core/db';
import {
  AuthService, SESSION_COOKIE, AuthError,
  DashboardEngine, PassportEngine, ResourceEngine, ReviewEngine,
  AssistantEngine, KnowledgeEngine, DiscoveryEngine, PortabilityEngine,
} from '@ai-brain/core/engines';
import { SyncRunner } from '@ai-brain/core/connectors';
import { providerConfigFromEnv, createProvider, DbLedger } from '@ai-brain/core/ai';
import type { BrainConfiguration, User, Workspace, WorkspaceMember } from '@ai-brain/core/domain';

const DEFAULT_DB_PATH = './data/brain.db';

interface Globals {
  db?: Db;
  store?: Store;
}

// Next recreates modules across dev reloads, so the handle lives on globalThis
// to avoid leaking a connection per reload.
const globals = globalThis as unknown as { __aiBrain?: Globals };
globals.__aiBrain ??= {};

export function getStore(): Store {
  if (!globals.__aiBrain!.store) {
    const path = process.env.AI_BRAIN_DB ?? DEFAULT_DB_PATH;
    const db = openDb({ path });
    globals.__aiBrain!.db = db;
    globals.__aiBrain!.store = new Store(db);
  }
  return globals.__aiBrain!.store!;
}

export function getAuth(): AuthService {
  return new AuthService(getStore());
}

export interface AppContext {
  store: Store;
  auth: AuthService;
  user: User;
  workspace: Workspace;
  role: WorkspaceMember['role'];
  config: BrainConfiguration | null;
}

/** Resolves the signed-in user, or null. Safe to call on public pages. */
export async function getContext(): Promise<AppContext | null> {
  const store = getStore();
  const auth = new AuthService(store);
  const jar = await cookies();
  const resolved = auth.resolveSession(jar.get(SESSION_COOKIE)?.value);
  if (!resolved) return null;
  try {
    const { workspace, role } = auth.requireWorkspace(resolved.user);
    return {
      store, auth, user: resolved.user, workspace, role,
      config: store.brainConfig.current(workspace.id),
    };
  } catch {
    return null;
  }
}

/** Resolves the context or redirects. Use on every authenticated page. */
export async function requireContext(): Promise<AppContext> {
  const ctx = await getContext();
  if (!ctx) {
    const auth = getAuth();
    redirect(auth.needsSetup() ? '/setup' : '/login');
  }
  return ctx;
}

/** Throws rather than redirecting; for Server Actions and route handlers. */
export async function requireContextOrThrow(): Promise<AppContext> {
  const ctx = await getContext();
  if (!ctx) throw new AuthError('not signed in', 401);
  return ctx;
}

export async function requireWriteContext(): Promise<AppContext> {
  const ctx = await requireContextOrThrow();
  ctx.auth.requireWriteRole(ctx.role);
  return ctx;
}

/* ---------------------------------------------------------------- */
/* Engines                                                          */
/* ---------------------------------------------------------------- */

export function engines(store: Store) {
  return {
    dashboard: new DashboardEngine(store),
    passports: new PassportEngine(store),
    resources: new ResourceEngine(store),
    reviews: new ReviewEngine(store),
    assistant: new AssistantEngine(store),
    knowledge: new KnowledgeEngine(store),
    discovery: new DiscoveryEngine(store),
    portability: new PortabilityEngine(store),
    sync: new SyncRunner(store),
  };
}

/** The AI provider for a workspace. Defaults to the no-cost, no-network one. */
export function providerFor(store: Store, workspaceId: string, config: BrainConfiguration | null) {
  const cfg = providerConfigFromEnv(process.env as Record<string, string | undefined>);
  // A provider is only ever used when the user has allowed remote AI, even if
  // the environment supplies a key.
  const effective = config?.privacy.allowRemoteAi === false && cfg.kind !== 'ollama'
    ? { ...cfg, kind: 'none' as const }
    : cfg;
  return { provider: createProvider(effective, new DbLedger(store, workspaceId)), config: effective };
}

/* ---------------------------------------------------------------- */
/* Request metadata                                                 */
/* ---------------------------------------------------------------- */

export async function clientIp(): Promise<string | null> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return h.get('x-real-ip');
}

/** Absolute base URL, used for the hook snippets shown in the UI. */
export async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export function appSecret(): string | null {
  const s = process.env.APP_SECRET;
  return s && s.length >= 16 ? s : null;
}

/** Checked at the top of pages that would otherwise fail confusingly later. */
export function configurationWarnings(): string[] {
  const out: string[] = [];
  if (!appSecret()) {
    out.push(
      'APP_SECRET is not set (or is shorter than 16 characters). Everything works, but connector credentials cannot be stored until you set it in .env.',
    );
  }
  return out;
}

export { SESSION_COOKIE, AuthError };
