/**
 * Authentication and authorization.
 *
 * Local accounts only in this release: email plus password, server-side
 * sessions, and scoped bearer tokens for MCP clients. Authorization is always
 * resolved here from the session, never from anything the client sends — a
 * request that names a workspace still has to pass `requireWorkspace`.
 */

import type { AccessToken, Id, Session, TokenScope, User, Workspace, WorkspaceMember } from '../domain/types.ts';
import type { Store } from '../db/repositories.ts';
import { hashPassword, verifyPassword } from '../security/password.ts';
import { hashToken } from '../security/secrets.ts';
import { randomToken } from '../util/id.ts';
import { nowIso, addDays } from '../util/time.ts';
import { rateLimit } from '../security/rate-limit.ts';
import { generateBrain, type OnboardingAnswers } from './brain-config.ts';
import { PROFILE_TEMPLATES } from './profiles.ts';

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export interface SessionContext {
  user: User;
  session: Session;
  workspace: Workspace;
  role: WorkspaceMember['role'];
}

export const SESSION_COOKIE = 'ai_brain_session';
const SESSION_DAYS = 30;

export class AuthService {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** True until the first account exists; drives the first-run setup page. */
  needsSetup(): boolean {
    return this.store.users.count() === 0;
  }

  /**
   * Creates the first (or an additional) account with its workspace and brain.
   *
   * `allowAdditional` is false by default: a self-hosted instance should not
   * accept open sign-ups unless the operator turns them on.
   */
  register(
    input: { email: string; displayName: string; password: string; isMinorAccount?: boolean; workspaceName?: string; onboarding?: OnboardingAnswers },
    opts: { allowAdditional?: boolean } = {},
  ): { user: User; workspace: Workspace; token: string } {
    const isFirst = this.needsSetup();
    if (!isFirst && !opts.allowAdditional) {
      throw new AuthError('this installation already has an account and additional sign-ups are disabled', 403);
    }
    if (this.store.users.byEmail(input.email)) {
      throw new AuthError('an account with that email already exists', 409);
    }
    if (input.password.length < 10) {
      throw new AuthError('password must be at least 10 characters', 400);
    }

    return this.store.transaction(() => {
      const user = this.store.users.create({
        email: input.email,
        displayName: input.displayName,
        passwordHash: hashPassword(input.password),
        isMinorAccount: input.isMinorAccount ?? false,
      });
      const workspace = this.store.workspaces.create({
        ownerId: user.id,
        name: input.workspaceName?.trim() || `${input.displayName}'s brain`,
        kind: 'personal',
      });

      // Every workspace gets a configuration immediately, so the dashboard is
      // never in an undefined state. Skipping onboarding is allowed.
      const answers: OnboardingAnswers = {
        displayName: input.workspaceName?.trim() || `${input.displayName}'s brain`,
        isMinorAccount: input.isMinorAccount ?? false,
        ...input.onboarding,
      };
      const generated = generateBrain(workspace.id, answers);
      const config = this.store.brainConfig.save(generated.config);
      for (const key of config.modules) this.store.modules.setEnabled(workspace.id, key, true);
      for (const seed of generated.projectSeeds) {
        this.store.projects.create({
          workspaceId: workspace.id, name: seed.name,
          category: seed.category as never, origin: 'manual',
        });
      }
      for (const seed of generated.goalSeeds) {
        const parent = this.store.goals.create({ workspaceId: workspace.id, title: seed.title, horizon: seed.horizon });
        for (const child of seed.children ?? []) {
          this.store.goals.create({ workspaceId: workspace.id, title: child.title, horizon: child.horizon, parentGoalId: parent.id });
        }
      }

      const token = this.openSession(user.id);
      this.store.audit.log({
        workspaceId: workspace.id, actorUserId: user.id, action: 'account.created',
        subject: `user:${user.id}`, detail: { profile: config.profile, first: isFirst },
      });
      return { user, workspace, token };
    });
  }

  /** Rate limited per email to blunt credential stuffing. */
  login(email: string, password: string, ip: string | null): { user: User; token: string } {
    const limit = rateLimit(`login:${email.toLowerCase()}`, 10, 300);
    if (!limit.allowed) {
      throw new AuthError(`too many attempts; try again in ${limit.retryAfterSeconds} seconds`, 429);
    }
    const user = this.store.users.byEmail(email);
    // Same error and roughly the same work either way, so a wrong email and a
    // wrong password are not distinguishable.
    if (!user) {
      verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
      throw new AuthError('email or password is incorrect');
    }
    if (!verifyPassword(password, user.passwordHash)) {
      this.store.audit.log({ workspaceId: null, actorUserId: user.id, action: 'login.failed', subject: `user:${user.id}`, detail: {}, ip });
      throw new AuthError('email or password is incorrect');
    }
    const token = this.openSession(user.id);
    this.store.audit.log({ workspaceId: null, actorUserId: user.id, action: 'login', subject: `user:${user.id}`, detail: {}, ip });
    return { user, token };
  }

  logout(rawToken: string): void {
    this.store.sessions.revoke(hashToken(rawToken));
  }

  /** Resolves a session cookie to a user, or null. Never throws on bad input. */
  resolveSession(rawToken: string | null | undefined): { user: User; session: Session } | null {
    if (!rawToken) return null;
    const session = this.store.sessions.byTokenHash(hashToken(rawToken));
    if (!session) return null;
    const user = this.store.users.byId(session.userId);
    if (!user) return null;
    this.store.sessions.touch(session.id);
    return { user, session };
  }

  /**
   * Resolves the workspace for a request and checks membership.
   *
   * When no id is given, the user's first workspace is used. A requested id the
   * user is not a member of is a 404, not a 403: the existence of another
   * person's workspace is not something to confirm.
   */
  requireWorkspace(user: User, workspaceId?: string | null): { workspace: Workspace; role: WorkspaceMember['role'] } {
    const workspaces = this.store.workspaces.listForUser(user.id);
    if (workspaces.length === 0) throw new AuthError('this account has no workspace', 404);

    const workspace = workspaceId ? workspaces.find((w) => w.id === workspaceId) : workspaces[0];
    if (!workspace) throw new AuthError('workspace not found', 404);

    const role = this.store.workspaces.memberRole(workspace.id, user.id);
    if (!role) throw new AuthError('workspace not found', 404);
    return { workspace, role };
  }

  requireWriteRole(role: WorkspaceMember['role']): void {
    if (role === 'viewer') throw new AuthError('your role on this workspace is read-only', 403);
  }

  changePassword(userId: Id, currentPassword: string, newPassword: string): void {
    const user = this.store.users.byId(userId);
    if (!user) throw new AuthError('account not found', 404);
    if (!verifyPassword(currentPassword, user.passwordHash)) throw new AuthError('current password is incorrect');
    if (newPassword.length < 10) throw new AuthError('new password must be at least 10 characters', 400);
    this.store.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      hashPassword(newPassword), nowIso(), userId,
    ]);
    // Every other session is invalidated; the caller re-authenticates.
    this.store.sessions.revokeAllForUser(userId);
    this.store.audit.log({ workspaceId: null, actorUserId: userId, action: 'password.changed', subject: `user:${userId}`, detail: {} });
  }

  /* ------------------------- scoped access tokens ------------------------- */

  /**
   * Issues a bearer token for MCP clients and agent hooks.
   *
   * The raw value is returned exactly once; only its SHA-256 is stored, so a
   * database dump does not yield working credentials.
   */
  issueToken(workspaceId: Id, userId: Id, label: string, scopes: TokenScope[], expiresInDays?: number): { token: AccessToken; raw: string } {
    const raw = `aib_${randomToken(32)}`;
    const token = this.store.tokens.create({
      workspaceId, userId, label,
      tokenHash: hashToken(raw),
      scopes,
      expiresAt: expiresInDays ? addDays(nowIso(), expiresInDays) : null,
    });
    this.store.audit.log({
      workspaceId, actorUserId: userId, action: 'token.issued',
      subject: `access_token:${token.id}`, detail: { label, scopes },
    });
    return { token, raw };
  }

  /** Validates a bearer token and checks one required scope. */
  resolveToken(rawHeader: string | null | undefined, required: TokenScope): { token: AccessToken; workspace: Workspace } {
    const raw = (rawHeader ?? '').replace(/^Bearer\s+/i, '').trim();
    if (raw === '') throw new AuthError('missing bearer token');
    const token = this.store.tokens.byTokenHash(hashToken(raw));
    if (!token) throw new AuthError('invalid or revoked token');
    if (!token.scopes.includes(required)) {
      throw new AuthError(`this token does not have the "${required}" scope`, 403);
    }
    const workspace = this.store.workspaces.byId(token.workspaceId);
    if (!workspace) throw new AuthError('the workspace for this token no longer exists', 404);
    this.store.tokens.touch(token.id);
    return { token, workspace };
  }

  revokeToken(workspaceId: Id, tokenId: Id, actorUserId: Id): void {
    this.store.tokens.revoke(workspaceId, tokenId);
    this.store.audit.log({
      workspaceId, actorUserId, action: 'token.revoked',
      subject: `access_token:${tokenId}`, detail: {},
    });
  }

  private openSession(userId: Id): string {
    const raw = randomToken(32);
    this.store.sessions.create(userId, hashToken(raw), addDays(nowIso(), SESSION_DAYS));
    return raw;
  }
}

/** Profile choices for the onboarding UI. */
export function profileChoices(): Array<{ key: string; label: string; tagline: string; audience: string; modules: string[] }> {
  return Object.values(PROFILE_TEMPLATES).map((t) => ({
    key: t.key, label: t.label, tagline: t.tagline, audience: t.audience, modules: t.modules,
  }));
}

export { SESSION_DAYS };
