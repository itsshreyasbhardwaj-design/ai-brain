/**
 * Workspace-scoped data access.
 *
 * Every read and write below takes a `workspaceId` as its first argument and
 * puts it in the WHERE clause. That is the isolation boundary: there is no
 * method on this layer that can return another workspace's rows, which is what
 * the privacy tests assert. The API layer resolves the workspace from the
 * session and never from a client-supplied value.
 */

import type { Db, SqlValue } from './client.ts';
import { parseJson, toJson, boolInt, intBool } from '../util/json.ts';
import { newId, contentHash, slugify } from '../util/id.ts';
import { nowIso, isoDay } from '../util/time.ts';
import type {
  AccessToken, ActivityEvent, AuditLog, BrainConfiguration, ConnectedAccount, Decision,
  Evidence, Goal, Id, ImportBatch, Iso, KnowledgeRecord, Metric, ModuleState, Project,
  ProjectRelationship, Report, Resource, Session, SourceRecord, SyncRun, Task, User,
  Workspace, WorkspaceMember, ModuleKey, KnowledgeClass, ConnectorKey, Origin, Confidence,
  Lifecycle, ProjectCategory, TokenScope, ResourceKind, DashboardLayout, PrivacyPreferences,
  GoalSeed, Cadence, BrainProfileKey, SyncStats, RelationshipKind,
} from '../domain/types.ts';

type R = Record<string, SqlValue>;

/* ---------------------------------------------------------------- */
/* Row mappers                                                       */
/* ---------------------------------------------------------------- */

type Cell = SqlValue | undefined;
const s = (v: Cell): string => (v == null ? '' : String(v));
const sn = (v: Cell): string | null => (v == null ? null : String(v));
const n = (v: Cell): number => Number(v ?? 0);
const nn = (v: Cell): number | null => (v == null ? null : Number(v));

function mapUser(r: R): User {
  return {
    id: s(r.id), email: s(r.email), displayName: s(r.display_name),
    passwordHash: s(r.password_hash), isMinorAccount: intBool(r.is_minor_account),
    createdAt: s(r.created_at), updatedAt: s(r.updated_at),
  };
}

function mapWorkspace(r: R): Workspace {
  return {
    id: s(r.id), ownerId: s(r.owner_id), name: s(r.name), slug: s(r.slug),
    kind: s(r.kind) as Workspace['kind'], createdAt: s(r.created_at), updatedAt: s(r.updated_at),
  };
}

function mapBrainConfig(r: R): BrainConfiguration {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), version: n(r.version),
    schemaVersion: n(r.schema_version), profile: s(r.profile) as BrainProfileKey,
    displayName: s(r.display_name),
    intents: parseJson<string[]>(r.intents, []),
    modules: parseJson<ModuleKey[]>(r.modules, []),
    knowledgeCategories: parseJson<string[]>(r.knowledge_categories, []),
    goalHierarchy: parseJson<GoalSeed[]>(r.goal_hierarchy, []),
    projectTaxonomy: parseJson<string[]>(r.project_taxonomy, []),
    preferredMetrics: parseJson<string[]>(r.preferred_metrics, []),
    reportingCadence: s(r.reporting_cadence) as Cadence,
    recommendedConnectors: parseJson<ConnectorKey[]>(r.recommended_connectors, []),
    privacy: parseJson<PrivacyPreferences>(r.privacy, {
      excludedCategories: [], excludedPaths: [], allowRemoteAi: false,
      allowFileContentImport: true, sourceRetentionDays: 0,
    }),
    dashboardLayout: parseJson<DashboardLayout>(r.dashboard_layout, { columns: 12, widgets: [] }),
    assistantInstructions: s(r.assistant_instructions),
    automationLevel: s(r.automation_level) as BrainConfiguration['automationLevel'],
    workingStyle: s(r.working_style) as BrainConfiguration['workingStyle'],
    createdBy: s(r.created_by) as Origin, createdAt: s(r.created_at),
  };
}

function mapProject(r: R): Project {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), name: s(r.name), slug: s(r.slug),
    description: s(r.description), category: s(r.category) as ProjectCategory,
    lifecycle: s(r.lifecycle) as Lifecycle, origin: s(r.origin) as Origin,
    sourceKey: sn(r.source_key), sourceId: sn(r.source_id),
    aliases: parseJson<string[]>(r.aliases, []), tags: parseJson<string[]>(r.tags, []),
    reviewState: s(r.review_state) as Project['reviewState'],
    confidence: s(r.confidence) as Confidence, matchScore: n(r.match_score),
    parentProjectId: sn(r.parent_project_id), archivedAt: sn(r.archived_at),
    lastActivityAt: sn(r.last_activity_at), createdAt: s(r.created_at), updatedAt: s(r.updated_at),
  };
}

function mapKnowledge(r: R): KnowledgeRecord {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), projectId: sn(r.project_id),
    title: s(r.title), body: s(r.body), klass: s(r.klass) as KnowledgeClass,
    origin: s(r.origin) as Origin, confidence: s(r.confidence) as Confidence,
    sourceId: sn(r.source_id), contentHash: s(r.content_hash),
    tags: parseJson<string[]>(r.tags, []), supersedesId: sn(r.supersedes_id),
    contradictsId: sn(r.contradicts_id), observedAt: s(r.observed_at),
    createdAt: s(r.created_at), updatedAt: s(r.updated_at), archivedAt: sn(r.archived_at),
  };
}

function mapGoal(r: R): Goal {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), parentGoalId: sn(r.parent_goal_id),
    projectId: sn(r.project_id), title: s(r.title), description: s(r.description),
    horizon: s(r.horizon) as Goal['horizon'], status: s(r.status) as Goal['status'],
    progress: n(r.progress), progressOrigin: s(r.progress_origin) as Origin,
    targetDate: sn(r.target_date), createdAt: s(r.created_at), updatedAt: s(r.updated_at),
  };
}

function mapTask(r: R): Task {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), projectId: sn(r.project_id),
    goalId: sn(r.goal_id), title: s(r.title), notes: s(r.notes),
    status: s(r.status) as Task['status'], priority: n(r.priority) as Task['priority'],
    dueAt: sn(r.due_at), estimateMinutes: nn(r.estimate_minutes), completedAt: sn(r.completed_at),
    origin: s(r.origin) as Origin, createdAt: s(r.created_at), updatedAt: s(r.updated_at),
  };
}

function mapDecision(r: R): Decision {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), projectId: sn(r.project_id),
    title: s(r.title), context: s(r.context), choice: s(r.choice), rationale: s(r.rationale),
    alternatives: parseJson<string[]>(r.alternatives, []),
    status: s(r.status) as Decision['status'], supersedesId: sn(r.supersedes_id),
    outcome: s(r.outcome), decidedAt: s(r.decided_at),
    createdAt: s(r.created_at), updatedAt: s(r.updated_at),
  };
}

function mapSource(r: R): SourceRecord {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), connectedAccountId: sn(r.connected_account_id),
    connector: s(r.connector) as SourceRecord['connector'], kind: s(r.kind),
    externalId: s(r.external_id), locator: s(r.locator), url: sn(r.url),
    payload: parseJson<Record<string, unknown>>(r.payload, {}), payloadHash: s(r.payload_hash),
    observedAt: s(r.observed_at), createdAt: s(r.created_at),
  };
}

function mapActivity(r: R): ActivityEvent {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), projectId: sn(r.project_id),
    connector: s(r.connector) as ActivityEvent['connector'], kind: s(r.kind),
    summary: s(r.summary), url: sn(r.url), sourceId: sn(r.source_id), actor: sn(r.actor),
    occurredAt: s(r.occurred_at), createdAt: s(r.created_at),
  };
}

function mapResource(r: R): Resource {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), projectId: sn(r.project_id),
    kind: s(r.kind) as ResourceKind, name: s(r.name), amountMinor: nn(r.amount_minor),
    currency: s(r.currency), period: sn(r.period) as Resource['period'],
    minutes: nn(r.minutes), origin: s(r.origin) as Origin, notes: s(r.notes),
    lastConfirmedAt: sn(r.last_confirmed_at), startedAt: sn(r.started_at), endedAt: sn(r.ended_at),
    createdAt: s(r.created_at), updatedAt: s(r.updated_at),
  };
}

function mapMetric(r: R): Metric {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), projectId: sn(r.project_id),
    key: s(r.key), label: s(r.label), value: n(r.value), unit: s(r.unit),
    origin: s(r.origin) as Origin, sourceId: sn(r.source_id), target: nn(r.target),
    observedAt: s(r.observed_at), createdAt: s(r.created_at),
  };
}

function mapAccount(r: R): ConnectedAccount {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), connector: s(r.connector) as ConnectorKey,
    accountLabel: s(r.account_label), credentialCipher: sn(r.credential_cipher),
    scopes: parseJson<string[]>(r.scopes, []), allowlist: parseJson<string[]>(r.allowlist, []),
    status: s(r.status) as ConnectedAccount['status'], lastError: sn(r.last_error),
    lastSyncAt: sn(r.last_sync_at), cursor: sn(r.cursor),
    createdAt: s(r.created_at), updatedAt: s(r.updated_at),
  };
}

function mapSyncRun(r: R): SyncRun {
  return {
    id: s(r.id), workspaceId: s(r.workspace_id), connectedAccountId: s(r.connected_account_id),
    connector: s(r.connector) as ConnectorKey, trigger: s(r.trigger) as SyncRun['trigger'],
    status: s(r.status) as SyncRun['status'], startedAt: s(r.started_at),
    finishedAt: sn(r.finished_at), stats: parseJson<SyncStats>(r.stats, emptyStats()),
    error: sn(r.error), cursorBefore: sn(r.cursor_before), cursorAfter: sn(r.cursor_after),
  };
}

export function emptyStats(): SyncStats {
  return {
    sourcesSeen: 0, sourcesWritten: 0, projectsCreated: 0, projectsUpdated: 0,
    projectsQueuedForReview: 0, activityWritten: 0, metricsWritten: 0,
    skippedByPrivacy: 0, rateLimitWaits: 0, retries: 0,
  };
}

/* ---------------------------------------------------------------- */
/* Users, workspaces, sessions                                       */
/* ---------------------------------------------------------------- */

export class UserRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(input: { email: string; displayName: string; passwordHash: string; isMinorAccount?: boolean }): User {
    const now = nowIso();
    const u: User = {
      id: newId('usr'), email: input.email.toLowerCase(), displayName: input.displayName,
      passwordHash: input.passwordHash, isMinorAccount: input.isMinorAccount ?? false,
      createdAt: now, updatedAt: now,
    };
    this.db.run(
      `INSERT INTO users (id,email,display_name,password_hash,is_minor_account,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      [u.id, u.email, u.displayName, u.passwordHash, boolInt(u.isMinorAccount), u.createdAt, u.updatedAt],
    );
    return u;
  }

  byEmail(email: string): User | null {
    const r = this.db.one<R>('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    return r ? mapUser(r) : null;
  }

  byId(id: Id): User | null {
    const r = this.db.one<R>('SELECT * FROM users WHERE id = ?', [id]);
    return r ? mapUser(r) : null;
  }

  count(): number {
    return n(this.db.one<R>('SELECT COUNT(*) AS c FROM users')?.c ?? 0);
  }

  delete(id: Id): void {
    this.db.run('DELETE FROM users WHERE id = ?', [id]);
  }
}

export class WorkspaceRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(input: { ownerId: Id; name: string; kind?: Workspace['kind'] }): Workspace {
    const now = nowIso();
    const w: Workspace = {
      id: newId('wsp'), ownerId: input.ownerId, name: input.name,
      slug: slugify(input.name, 'workspace'), kind: input.kind ?? 'personal',
      createdAt: now, updatedAt: now,
    };
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO workspaces (id,owner_id,name,slug,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        [w.id, w.ownerId, w.name, w.slug, w.kind, w.createdAt, w.updatedAt],
      );
      this.db.run(
        'INSERT INTO workspace_members (id,workspace_id,user_id,role,created_at) VALUES (?,?,?,?,?)',
        [newId('mem'), w.id, w.ownerId, 'owner', now],
      );
    });
    return w;
  }

  byId(id: Id): Workspace | null {
    const r = this.db.one<R>('SELECT * FROM workspaces WHERE id = ?', [id]);
    return r ? mapWorkspace(r) : null;
  }

  listForUser(userId: Id): Workspace[] {
    return this.db
      .query<R>(
        `SELECT w.* FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
         WHERE m.user_id = ? ORDER BY w.created_at ASC`,
        [userId],
      )
      .map(mapWorkspace);
  }

  memberRole(workspaceId: Id, userId: Id): WorkspaceMember['role'] | null {
    const r = this.db.one<R>(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [workspaceId, userId],
    );
    return r ? (s(r.role) as WorkspaceMember['role']) : null;
  }

  addMember(workspaceId: Id, userId: Id, role: WorkspaceMember['role']): void {
    this.db.run(
      'INSERT INTO workspace_members (id,workspace_id,user_id,role,created_at) VALUES (?,?,?,?,?)',
      [newId('mem'), workspaceId, userId, role, nowIso()],
    );
  }

  /** Cascades through every table via foreign keys. */
  delete(id: Id): void {
    this.db.run('DELETE FROM workspaces WHERE id = ?', [id]);
  }
}

export class SessionRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(userId: Id, tokenHash: string, expiresAt: Iso): Session {
    const now = nowIso();
    const sess: Session = { id: newId('ses'), userId, tokenHash, expiresAt, createdAt: now, lastSeenAt: now };
    this.db.run(
      'INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?)',
      [sess.id, sess.userId, sess.tokenHash, sess.expiresAt, sess.createdAt, sess.lastSeenAt],
    );
    return sess;
  }

  byTokenHash(tokenHash: string): Session | null {
    const r = this.db.one<R>('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
    if (!r) return null;
    const sess: Session = {
      id: s(r.id), userId: s(r.user_id), tokenHash: s(r.token_hash),
      expiresAt: s(r.expires_at), createdAt: s(r.created_at), lastSeenAt: s(r.last_seen_at),
    };
    if (new Date(sess.expiresAt).getTime() < Date.now()) {
      this.db.run('DELETE FROM sessions WHERE id = ?', [sess.id]);
      return null;
    }
    return sess;
  }

  touch(id: Id): void {
    this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [nowIso(), id]);
  }

  revoke(tokenHash: string): void {
    this.db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  revokeAllForUser(userId: Id): void {
    this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
}

export class AccessTokenRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(input: { workspaceId: Id; userId: Id; label: string; tokenHash: string; scopes: TokenScope[]; expiresAt?: Iso | null }): AccessToken {
    const t: AccessToken = {
      id: newId('tok'), workspaceId: input.workspaceId, userId: input.userId,
      label: input.label, tokenHash: input.tokenHash, scopes: input.scopes,
      lastUsedAt: null, revokedAt: null, expiresAt: input.expiresAt ?? null, createdAt: nowIso(),
    };
    this.db.run(
      `INSERT INTO access_tokens (id,workspace_id,user_id,label,token_hash,scopes,expires_at,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [t.id, t.workspaceId, t.userId, t.label, t.tokenHash, toJson(t.scopes), t.expiresAt, t.createdAt],
    );
    return t;
  }

  byTokenHash(tokenHash: string): AccessToken | null {
    const r = this.db.one<R>('SELECT * FROM access_tokens WHERE token_hash = ?', [tokenHash]);
    if (!r) return null;
    const t: AccessToken = {
      id: s(r.id), workspaceId: s(r.workspace_id), userId: s(r.user_id), label: s(r.label),
      tokenHash: s(r.token_hash), scopes: parseJson<TokenScope[]>(r.scopes, []),
      lastUsedAt: sn(r.last_used_at), revokedAt: sn(r.revoked_at),
      expiresAt: sn(r.expires_at), createdAt: s(r.created_at),
    };
    if (t.revokedAt) return null;
    if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) return null;
    return t;
  }

  list(workspaceId: Id): AccessToken[] {
    return this.db
      .query<R>('SELECT * FROM access_tokens WHERE workspace_id = ? ORDER BY created_at DESC', [workspaceId])
      .map((r) => ({
        id: s(r.id), workspaceId: s(r.workspace_id), userId: s(r.user_id), label: s(r.label),
        tokenHash: '', scopes: parseJson<TokenScope[]>(r.scopes, []),
        lastUsedAt: sn(r.last_used_at), revokedAt: sn(r.revoked_at),
        expiresAt: sn(r.expires_at), createdAt: s(r.created_at),
      }));
  }

  touch(id: Id): void {
    this.db.run('UPDATE access_tokens SET last_used_at = ? WHERE id = ?', [nowIso(), id]);
  }

  revoke(workspaceId: Id, id: Id): void {
    this.db.run('UPDATE access_tokens SET revoked_at = ? WHERE workspace_id = ? AND id = ?', [nowIso(), workspaceId, id]);
  }
}

/* ---------------------------------------------------------------- */
/* Brain configuration and modules                                   */
/* ---------------------------------------------------------------- */

export class BrainConfigRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** Writes a new version; previous versions are never mutated or deleted. */
  save(cfg: Omit<BrainConfiguration, 'id' | 'version' | 'createdAt'>): BrainConfiguration {
    const nextVersion = n(
      this.db.one<R>('SELECT COALESCE(MAX(version),0) + 1 AS v FROM brain_configurations WHERE workspace_id = ?', [
        cfg.workspaceId,
      ])?.v ?? 1,
    );
    const full: BrainConfiguration = { ...cfg, id: newId('brn'), version: nextVersion, createdAt: nowIso() };
    this.db.run(
      `INSERT INTO brain_configurations
        (id,workspace_id,version,schema_version,profile,display_name,intents,modules,knowledge_categories,
         goal_hierarchy,project_taxonomy,preferred_metrics,reporting_cadence,recommended_connectors,privacy,
         dashboard_layout,assistant_instructions,automation_level,working_style,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        full.id, full.workspaceId, full.version, full.schemaVersion, full.profile, full.displayName,
        toJson(full.intents), toJson(full.modules), toJson(full.knowledgeCategories),
        toJson(full.goalHierarchy), toJson(full.projectTaxonomy), toJson(full.preferredMetrics),
        full.reportingCadence, toJson(full.recommendedConnectors), toJson(full.privacy),
        toJson(full.dashboardLayout), full.assistantInstructions, full.automationLevel,
        full.workingStyle, full.createdBy, full.createdAt,
      ],
    );
    return full;
  }

  current(workspaceId: Id): BrainConfiguration | null {
    const r = this.db.one<R>(
      'SELECT * FROM brain_configurations WHERE workspace_id = ? ORDER BY version DESC LIMIT 1',
      [workspaceId],
    );
    return r ? mapBrainConfig(r) : null;
  }

  version(workspaceId: Id, version: number): BrainConfiguration | null {
    const r = this.db.one<R>('SELECT * FROM brain_configurations WHERE workspace_id = ? AND version = ?', [
      workspaceId, version,
    ]);
    return r ? mapBrainConfig(r) : null;
  }

  history(workspaceId: Id): BrainConfiguration[] {
    return this.db
      .query<R>('SELECT * FROM brain_configurations WHERE workspace_id = ? ORDER BY version DESC', [workspaceId])
      .map(mapBrainConfig);
  }
}

export class ModuleRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  setEnabled(workspaceId: Id, key: ModuleKey, enabled: boolean, settings: Record<string, unknown> = {}): void {
    const existing = this.db.one<R>('SELECT id FROM modules WHERE workspace_id = ? AND key = ?', [workspaceId, key]);
    if (existing) {
      this.db.run('UPDATE modules SET enabled = ?, settings = ?, updated_at = ? WHERE id = ?', [
        boolInt(enabled), toJson(settings), nowIso(), s(existing.id),
      ]);
    } else {
      this.db.run('INSERT INTO modules (id,workspace_id,key,enabled,settings,updated_at) VALUES (?,?,?,?,?,?)', [
        newId('mod'), workspaceId, key, boolInt(enabled), toJson(settings), nowIso(),
      ]);
    }
  }

  list(workspaceId: Id): ModuleState[] {
    return this.db
      .query<R>('SELECT * FROM modules WHERE workspace_id = ? ORDER BY key', [workspaceId])
      .map((r) => ({
        id: s(r.id), workspaceId: s(r.workspace_id), key: s(r.key) as ModuleKey,
        enabled: intBool(r.enabled), settings: parseJson<Record<string, unknown>>(r.settings, {}),
        updatedAt: s(r.updated_at),
      }));
  }

  enabledKeys(workspaceId: Id): ModuleKey[] {
    return this.list(workspaceId).filter((m) => m.enabled).map((m) => m.key);
  }
}

/* ---------------------------------------------------------------- */
/* Projects                                                          */
/* ---------------------------------------------------------------- */

export interface ProjectFilter {
  lifecycle?: Lifecycle[];
  category?: ProjectCategory[];
  reviewState?: Project['reviewState'][];
  search?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export class ProjectRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(input: Partial<Project> & { workspaceId: Id; name: string }): Project {
    const now = nowIso();
    const base: Project = {
      id: newId('prj'), workspaceId: input.workspaceId, name: input.name,
      slug: this.uniqueSlug(input.workspaceId, input.slug ?? slugify(input.name, 'project')),
      description: input.description ?? '', category: input.category ?? 'other',
      lifecycle: input.lifecycle ?? 'active', origin: input.origin ?? 'manual',
      sourceKey: input.sourceKey ?? null, sourceId: input.sourceId ?? null,
      aliases: input.aliases ?? [], tags: input.tags ?? [],
      reviewState: input.reviewState ?? 'confirmed', confidence: input.confidence ?? 'observed',
      matchScore: input.matchScore ?? 1, parentProjectId: input.parentProjectId ?? null,
      archivedAt: input.archivedAt ?? null, lastActivityAt: input.lastActivityAt ?? null,
      createdAt: now, updatedAt: now,
    };
    this.db.run(
      `INSERT INTO projects
        (id,workspace_id,name,slug,description,category,lifecycle,origin,source_key,source_id,aliases,tags,
         review_state,confidence,match_score,parent_project_id,archived_at,last_activity_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        base.id, base.workspaceId, base.name, base.slug, base.description, base.category,
        base.lifecycle, base.origin, base.sourceKey, base.sourceId, toJson(base.aliases),
        toJson(base.tags), base.reviewState, base.confidence, base.matchScore,
        base.parentProjectId, base.archivedAt, base.lastActivityAt, base.createdAt, base.updatedAt,
      ],
    );
    return base;
  }

  private uniqueSlug(workspaceId: Id, desired: string): string {
    let slug = desired;
    let i = 2;
    while (this.db.one<R>('SELECT 1 AS x FROM projects WHERE workspace_id = ? AND slug = ?', [workspaceId, slug])) {
      slug = `${desired}-${i++}`;
      if (i > 500) { slug = `${desired}-${newId('x').slice(2, 8)}`; break; }
    }
    return slug;
  }

  update(workspaceId: Id, id: Id, patch: Partial<Project>): Project | null {
    const current = this.byId(workspaceId, id);
    if (!current) return null;
    const next: Project = { ...current, ...patch, id: current.id, workspaceId, updatedAt: nowIso() };
    this.db.run(
      `UPDATE projects SET name=?, description=?, category=?, lifecycle=?, source_key=?, source_id=?,
        aliases=?, tags=?, review_state=?, confidence=?, match_score=?, parent_project_id=?,
        archived_at=?, last_activity_at=?, updated_at=?
       WHERE workspace_id=? AND id=?`,
      [
        next.name, next.description, next.category, next.lifecycle, next.sourceKey, next.sourceId,
        toJson(next.aliases), toJson(next.tags), next.reviewState, next.confidence, next.matchScore,
        next.parentProjectId, next.archivedAt, next.lastActivityAt, next.updatedAt, workspaceId, id,
      ],
    );
    return next;
  }

  byId(workspaceId: Id, id: Id): Project | null {
    const r = this.db.one<R>('SELECT * FROM projects WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
    return r ? mapProject(r) : null;
  }

  bySlug(workspaceId: Id, slug: string): Project | null {
    const r = this.db.one<R>('SELECT * FROM projects WHERE workspace_id = ? AND slug = ?', [workspaceId, slug]);
    return r ? mapProject(r) : null;
  }

  bySourceKey(workspaceId: Id, sourceKey: string): Project | null {
    const r = this.db.one<R>('SELECT * FROM projects WHERE workspace_id = ? AND source_key = ?', [workspaceId, sourceKey]);
    return r ? mapProject(r) : null;
  }

  list(workspaceId: Id, f: ProjectFilter = {}): Project[] {
    const where: string[] = ['workspace_id = ?'];
    const params: SqlValue[] = [workspaceId];
    if (!f.includeArchived) where.push('archived_at IS NULL');
    if (f.lifecycle?.length) {
      where.push(`lifecycle IN (${f.lifecycle.map(() => '?').join(',')})`);
      params.push(...f.lifecycle);
    }
    if (f.category?.length) {
      where.push(`category IN (${f.category.map(() => '?').join(',')})`);
      params.push(...f.category);
    }
    if (f.reviewState?.length) {
      where.push(`review_state IN (${f.reviewState.map(() => '?').join(',')})`);
      params.push(...f.reviewState);
    } else {
      where.push(`review_state != 'rejected'`);
    }
    if (f.search) {
      where.push('(LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(aliases) LIKE ?)');
      const like = `%${f.search.toLowerCase()}%`;
      params.push(like, like, like);
    }
    params.push(f.limit ?? 200, f.offset ?? 0);
    return this.db
      .query<R>(
        `SELECT * FROM projects WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT ? OFFSET ?`,
        params,
      )
      .map(mapProject);
  }

  count(workspaceId: Id, f: ProjectFilter = {}): number {
    return this.list(workspaceId, { ...f, limit: 100_000, offset: 0 }).length;
  }

  /**
   * Rows worth scoring against a candidate.
   *
   * Deliberately generous: an exact normalised match, a shared word, or a
   * common prefix all qualify. Narrowing this to exact matches would make the
   * name-similarity rule in the discovery engine unreachable, so a renamed or
   * slightly-differently-spelled project would silently become a duplicate.
   * Scoring, not this filter, decides what actually matches.
   */
  dedupCandidates(workspaceId: Id, name: string, aliases: string[]): Project[] {
    const needles = [name, ...aliases].map((x) => slugify(x)).filter((x) => x !== '');
    const needleTokens = new Set(needles.flatMap((x) => x.split('-').filter((t) => t.length > 2)));
    const rows = this.db.query<R>(
      `SELECT * FROM projects WHERE workspace_id = ? AND archived_at IS NULL LIMIT 2000`,
      [workspaceId],
    ).map(mapProject);

    return rows.filter((p) => {
      const pool = [p.name, p.slug, ...p.aliases].map((x) => slugify(x)).filter((x) => x !== '');
      if (pool.some((x) => needles.includes(x))) return true;
      for (const x of pool) {
        if (x.split('-').some((t) => t.length > 2 && needleTokens.has(t))) return true;
        // Catches singular/plural and short suffix drift, e.g. "api" / "apis".
        if (needles.some((nd) => nd.length >= 4 && x.length >= 4 && (nd.startsWith(x.slice(0, 4)) || x.startsWith(nd.slice(0, 4))))) return true;
      }
      return false;
    });
  }

  touchActivity(workspaceId: Id, id: Id, at: Iso): void {
    this.db.run(
      `UPDATE projects SET last_activity_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)`,
      [at, nowIso(), workspaceId, id, at],
    );
  }

  delete(workspaceId: Id, id: Id): void {
    this.db.run('DELETE FROM projects WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  }
}

export class RelationshipRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  link(input: { workspaceId: Id; fromProjectId: Id; toProjectId: Id; kind: RelationshipKind; evidenceId?: Id | null; confidence?: Confidence }): ProjectRelationship | null {
    if (input.fromProjectId === input.toProjectId) return null;
    const rel: ProjectRelationship = {
      id: newId('rel'), workspaceId: input.workspaceId, fromProjectId: input.fromProjectId,
      toProjectId: input.toProjectId, kind: input.kind, evidenceId: input.evidenceId ?? null,
      confidence: input.confidence ?? 'medium', createdAt: nowIso(),
    };
    const exists = this.db.one<R>(
      'SELECT 1 AS x FROM project_relationships WHERE workspace_id=? AND from_project_id=? AND to_project_id=? AND kind=?',
      [rel.workspaceId, rel.fromProjectId, rel.toProjectId, rel.kind],
    );
    if (exists) return null;
    this.db.run(
      `INSERT INTO project_relationships (id,workspace_id,from_project_id,to_project_id,kind,evidence_id,confidence,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [rel.id, rel.workspaceId, rel.fromProjectId, rel.toProjectId, rel.kind, rel.evidenceId, rel.confidence, rel.createdAt],
    );
    return rel;
  }

  list(workspaceId: Id): ProjectRelationship[] {
    return this.db
      .query<R>('SELECT * FROM project_relationships WHERE workspace_id = ?', [workspaceId])
      .map((r) => ({
        id: s(r.id), workspaceId: s(r.workspace_id), fromProjectId: s(r.from_project_id),
        toProjectId: s(r.to_project_id), kind: s(r.kind) as RelationshipKind,
        evidenceId: sn(r.evidence_id), confidence: s(r.confidence) as Confidence, createdAt: s(r.created_at),
      }));
  }

  forProject(workspaceId: Id, projectId: Id): ProjectRelationship[] {
    return this.list(workspaceId).filter((r) => r.fromProjectId === projectId || r.toProjectId === projectId);
  }
}

/* ---------------------------------------------------------------- */
/* Knowledge                                                         */
/* ---------------------------------------------------------------- */

export interface KnowledgeSearchOptions {
  klass?: KnowledgeClass[];
  projectId?: Id | null;
  tags?: string[];
  origin?: Origin[];
  limit?: number;
  offset?: number;
}

export interface KnowledgeHit {
  record: KnowledgeRecord;
  /** FTS5 bm25 rank, lower is better; 0 for metadata-only matches. */
  score: number;
  snippet: string;
}

export class KnowledgeRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(input: Partial<KnowledgeRecord> & { workspaceId: Id; title: string }): KnowledgeRecord {
    const now = nowIso();
    const rec: KnowledgeRecord = {
      id: newId('knw'), workspaceId: input.workspaceId, projectId: input.projectId ?? null,
      title: input.title, body: input.body ?? '', klass: input.klass ?? 'fact',
      origin: input.origin ?? 'manual', confidence: input.confidence ?? 'observed',
      sourceId: input.sourceId ?? null,
      contentHash: input.contentHash ?? contentHash(input.title, input.body ?? ''),
      tags: input.tags ?? [], supersedesId: input.supersedesId ?? null,
      contradictsId: input.contradictsId ?? null, observedAt: input.observedAt ?? now,
      createdAt: now, updatedAt: now, archivedAt: null,
    };
    this.db.run(
      `INSERT INTO knowledge_records
        (id,workspace_id,project_id,title,body,klass,origin,confidence,source_id,content_hash,tags,
         supersedes_id,contradicts_id,observed_at,created_at,updated_at,archived_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      [
        rec.id, rec.workspaceId, rec.projectId, rec.title, rec.body, rec.klass, rec.origin,
        rec.confidence, rec.sourceId, rec.contentHash, toJson(rec.tags), rec.supersedesId,
        rec.contradictsId, rec.observedAt, rec.createdAt, rec.updatedAt,
      ],
    );
    return rec;
  }

  byId(workspaceId: Id, id: Id): KnowledgeRecord | null {
    const r = this.db.one<R>('SELECT * FROM knowledge_records WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
    return r ? mapKnowledge(r) : null;
  }

  byHash(workspaceId: Id, hash: string): KnowledgeRecord | null {
    const r = this.db.one<R>(
      'SELECT * FROM knowledge_records WHERE workspace_id = ? AND content_hash = ? AND archived_at IS NULL',
      [workspaceId, hash],
    );
    return r ? mapKnowledge(r) : null;
  }

  update(workspaceId: Id, id: Id, patch: Partial<KnowledgeRecord>): KnowledgeRecord | null {
    const cur = this.byId(workspaceId, id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, workspaceId, updatedAt: nowIso() };
    next.contentHash = contentHash(next.title, next.body);
    this.db.run(
      `UPDATE knowledge_records SET project_id=?, title=?, body=?, klass=?, confidence=?, content_hash=?,
        tags=?, supersedes_id=?, contradicts_id=?, observed_at=?, updated_at=?, archived_at=?
       WHERE workspace_id=? AND id=?`,
      [
        next.projectId, next.title, next.body, next.klass, next.confidence, next.contentHash,
        toJson(next.tags), next.supersedesId, next.contradictsId, next.observedAt,
        next.updatedAt, next.archivedAt, workspaceId, id,
      ],
    );
    return next;
  }

  /** Full-text search over title, body and tags; falls back to LIKE for short queries. */
  search(workspaceId: Id, query: string, opts: KnowledgeSearchOptions = {}): KnowledgeHit[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const filters: string[] = ['k.workspace_id = ?', 'k.archived_at IS NULL'];
    const params: SqlValue[] = [workspaceId];
    if (opts.klass?.length) {
      filters.push(`k.klass IN (${opts.klass.map(() => '?').join(',')})`);
      params.push(...opts.klass);
    }
    if (opts.origin?.length) {
      filters.push(`k.origin IN (${opts.origin.map(() => '?').join(',')})`);
      params.push(...opts.origin);
    }
    if (opts.projectId !== undefined) {
      if (opts.projectId === null) filters.push('k.project_id IS NULL');
      else { filters.push('k.project_id = ?'); params.push(opts.projectId); }
    }
    for (const tag of opts.tags ?? []) {
      filters.push('LOWER(k.tags) LIKE ?');
      params.push(`%"${tag.toLowerCase()}"%`);
    }

    const q = query.trim();
    if (q === '') {
      const rows = this.db.query<R>(
        `SELECT k.* FROM knowledge_records k WHERE ${filters.join(' AND ')}
         ORDER BY k.observed_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      );
      return rows.map((r) => ({ record: mapKnowledge(r), score: 0, snippet: snippetOf(s(r.body)) }));
    }

    const match = toFtsQuery(q);
    if (match) {
      try {
        const rows = this.db.query<R>(
          `SELECT k.*, bm25(knowledge_fts) AS rank,
                  snippet(knowledge_fts, 1, '[', ']', ' … ', 18) AS snip
           FROM knowledge_fts
           JOIN knowledge_records k ON k.rowid = knowledge_fts.rowid
           WHERE knowledge_fts MATCH ? AND ${filters.join(' AND ')}
           ORDER BY rank LIMIT ? OFFSET ?`,
          [match, ...params, limit, offset],
        );
        if (rows.length > 0) {
          return rows.map((r) => ({
            record: mapKnowledge(r), score: n(r.rank), snippet: s(r.snip) || snippetOf(s(r.body)),
          }));
        }
      } catch {
        // Malformed FTS expression: fall through to LIKE.
      }
    }

    const like = `%${q.toLowerCase()}%`;
    const rows = this.db.query<R>(
      `SELECT k.* FROM knowledge_records k
       WHERE ${filters.join(' AND ')} AND (LOWER(k.title) LIKE ? OR LOWER(k.body) LIKE ?)
       ORDER BY k.observed_at DESC LIMIT ? OFFSET ?`,
      [...params, like, like, limit, offset],
    );
    return rows.map((r) => ({ record: mapKnowledge(r), score: 0, snippet: snippetOf(s(r.body), q) }));
  }

  list(workspaceId: Id, opts: KnowledgeSearchOptions = {}): KnowledgeRecord[] {
    return this.search(workspaceId, '', opts).map((h) => h.record);
  }

  countByClass(workspaceId: Id): Record<KnowledgeClass, number> {
    const out: Record<KnowledgeClass, number> = { fact: 0, decision: 0, idea: 0, action: 0, insight: 0 };
    for (const r of this.db.query<R>(
      'SELECT klass, COUNT(*) AS c FROM knowledge_records WHERE workspace_id = ? AND archived_at IS NULL GROUP BY klass',
      [workspaceId],
    )) {
      const k = s(r.klass) as KnowledgeClass;
      if (k in out) out[k] = n(r.c);
    }
    return out;
  }

  total(workspaceId: Id): number {
    return n(
      this.db.one<R>('SELECT COUNT(*) AS c FROM knowledge_records WHERE workspace_id = ? AND archived_at IS NULL', [
        workspaceId,
      ])?.c ?? 0,
    );
  }

  archive(workspaceId: Id, id: Id): void {
    this.db.run('UPDATE knowledge_records SET archived_at = ? WHERE workspace_id = ? AND id = ?', [nowIso(), workspaceId, id]);
  }

  delete(workspaceId: Id, id: Id): void {
    this.db.run('DELETE FROM knowledge_records WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  }

  /** Deletes every record imported from one source. Used by "forget this source". */
  deleteBySource(workspaceId: Id, sourceIds: Id[]): number {
    if (sourceIds.length === 0) return 0;
    const res = this.db.run(
      `DELETE FROM knowledge_records WHERE workspace_id = ? AND source_id IN (${sourceIds.map(() => '?').join(',')})`,
      [workspaceId, ...sourceIds],
    );
    return res.changes;
  }
}

/** Builds a safe FTS5 expression: quoted prefix terms joined by AND. */
export function toFtsQuery(raw: string): string | null {
  const terms = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' AND ');
}

function snippetOf(body: string, around?: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!around) return flat.slice(0, 180);
  const i = flat.toLowerCase().indexOf(around.toLowerCase());
  if (i < 0) return flat.slice(0, 180);
  return `${i > 20 ? '… ' : ''}${flat.slice(Math.max(0, i - 20), i + 160)}`;
}

/* ---------------------------------------------------------------- */
/* Goals, tasks, decisions                                           */
/* ---------------------------------------------------------------- */

export class GoalRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(input: Partial<Goal> & { workspaceId: Id; title: string }): Goal {
    const now = nowIso();
    const g: Goal = {
      id: newId('gol'), workspaceId: input.workspaceId, parentGoalId: input.parentGoalId ?? null,
      projectId: input.projectId ?? null, title: input.title, description: input.description ?? '',
      horizon: input.horizon ?? 'quarter', status: input.status ?? 'active',
      progress: input.progress ?? 0, progressOrigin: input.progressOrigin ?? 'manual',
      targetDate: input.targetDate ?? null, createdAt: now, updatedAt: now,
    };
    this.db.run(
      `INSERT INTO goals (id,workspace_id,parent_goal_id,project_id,title,description,horizon,status,progress,progress_origin,target_date,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [g.id, g.workspaceId, g.parentGoalId, g.projectId, g.title, g.description, g.horizon, g.status, g.progress, g.progressOrigin, g.targetDate, g.createdAt, g.updatedAt],
    );
    return g;
  }

  list(workspaceId: Id): Goal[] {
    return this.db
      .query<R>('SELECT * FROM goals WHERE workspace_id = ? ORDER BY horizon, created_at', [workspaceId])
      .map(mapGoal);
  }

  byId(workspaceId: Id, id: Id): Goal | null {
    const r = this.db.one<R>('SELECT * FROM goals WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
    return r ? mapGoal(r) : null;
  }

  update(workspaceId: Id, id: Id, patch: Partial<Goal>): Goal | null {
    const cur = this.byId(workspaceId, id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: nowIso() };
    this.db.run(
      `UPDATE goals SET parent_goal_id=?, project_id=?, title=?, description=?, horizon=?, status=?,
        progress=?, progress_origin=?, target_date=?, updated_at=? WHERE workspace_id=? AND id=?`,
      [next.parentGoalId, next.projectId, next.title, next.description, next.horizon, next.status, next.progress, next.progressOrigin, next.targetDate, next.updatedAt, workspaceId, id],
    );
    return next;
  }

  delete(workspaceId: Id, id: Id): void {
    this.db.run('DELETE FROM goals WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  }
}

export class TaskRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(input: Partial<Task> & { workspaceId: Id; title: string }): Task {
    const now = nowIso();
    const t: Task = {
      id: newId('tsk'), workspaceId: input.workspaceId, projectId: input.projectId ?? null,
      goalId: input.goalId ?? null, title: input.title, notes: input.notes ?? '',
      status: input.status ?? 'todo', priority: input.priority ?? 3, dueAt: input.dueAt ?? null,
      estimateMinutes: input.estimateMinutes ?? null, completedAt: input.completedAt ?? null,
      origin: input.origin ?? 'manual', createdAt: now, updatedAt: now,
    };
    this.db.run(
      `INSERT INTO tasks (id,workspace_id,project_id,goal_id,title,notes,status,priority,due_at,estimate_minutes,completed_at,origin,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t.id, t.workspaceId, t.projectId, t.goalId, t.title, t.notes, t.status, t.priority, t.dueAt, t.estimateMinutes, t.completedAt, t.origin, t.createdAt, t.updatedAt],
    );
    return t;
  }

  list(workspaceId: Id, opts: { status?: Task['status'][]; projectId?: Id; limit?: number } = {}): Task[] {
    const where = ['workspace_id = ?'];
    const params: SqlValue[] = [workspaceId];
    if (opts.status?.length) {
      where.push(`status IN (${opts.status.map(() => '?').join(',')})`);
      params.push(...opts.status);
    }
    if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
    params.push(opts.limit ?? 500);
    return this.db
      .query<R>(
        `SELECT * FROM tasks WHERE ${where.join(' AND ')}
         ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END,
                  priority ASC, COALESCE(due_at, '9999') ASC LIMIT ?`,
        params,
      )
      .map(mapTask);
  }

  byId(workspaceId: Id, id: Id): Task | null {
    const r = this.db.one<R>('SELECT * FROM tasks WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
    return r ? mapTask(r) : null;
  }

  update(workspaceId: Id, id: Id, patch: Partial<Task>): Task | null {
    const cur = this.byId(workspaceId, id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: nowIso() };
    if (patch.status === 'done' && !next.completedAt) next.completedAt = nowIso();
    if (patch.status && patch.status !== 'done') next.completedAt = null;
    this.db.run(
      `UPDATE tasks SET project_id=?, goal_id=?, title=?, notes=?, status=?, priority=?, due_at=?,
        estimate_minutes=?, completed_at=?, updated_at=? WHERE workspace_id=? AND id=?`,
      [next.projectId, next.goalId, next.title, next.notes, next.status, next.priority, next.dueAt, next.estimateMinutes, next.completedAt, next.updatedAt, workspaceId, id],
    );
    return next;
  }

  completedBetween(workspaceId: Id, start: Iso, end: Iso): Task[] {
    return this.db
      .query<R>(
        `SELECT * FROM tasks WHERE workspace_id = ? AND completed_at IS NOT NULL
         AND completed_at >= ? AND completed_at <= ? ORDER BY completed_at DESC`,
        [workspaceId, start, end],
      )
      .map(mapTask);
  }

  delete(workspaceId: Id, id: Id): void {
    this.db.run('DELETE FROM tasks WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  }
}

export class DecisionRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(input: Partial<Decision> & { workspaceId: Id; title: string }): Decision {
    const now = nowIso();
    const d: Decision = {
      id: newId('dec'), workspaceId: input.workspaceId, projectId: input.projectId ?? null,
      title: input.title, context: input.context ?? '', choice: input.choice ?? '',
      rationale: input.rationale ?? '', alternatives: input.alternatives ?? [],
      status: input.status ?? 'accepted', supersedesId: input.supersedesId ?? null,
      outcome: input.outcome ?? '', decidedAt: input.decidedAt ?? now, createdAt: now, updatedAt: now,
    };
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO decisions (id,workspace_id,project_id,title,context,choice,rationale,alternatives,status,supersedes_id,outcome,decided_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [d.id, d.workspaceId, d.projectId, d.title, d.context, d.choice, d.rationale, toJson(d.alternatives), d.status, d.supersedesId, d.outcome, d.decidedAt, d.createdAt, d.updatedAt],
      );
      if (d.supersedesId) {
        this.db.run(`UPDATE decisions SET status='superseded', updated_at=? WHERE workspace_id=? AND id=?`, [now, d.workspaceId, d.supersedesId]);
      }
    });
    return d;
  }

  list(workspaceId: Id, opts: { projectId?: Id; since?: Iso; limit?: number } = {}): Decision[] {
    const where = ['workspace_id = ?'];
    const params: SqlValue[] = [workspaceId];
    if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
    if (opts.since) { where.push('decided_at >= ?'); params.push(opts.since); }
    params.push(opts.limit ?? 200);
    return this.db
      .query<R>(`SELECT * FROM decisions WHERE ${where.join(' AND ')} ORDER BY decided_at DESC LIMIT ?`, params)
      .map(mapDecision);
  }

  byId(workspaceId: Id, id: Id): Decision | null {
    const r = this.db.one<R>('SELECT * FROM decisions WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
    return r ? mapDecision(r) : null;
  }

  update(workspaceId: Id, id: Id, patch: Partial<Decision>): Decision | null {
    const cur = this.byId(workspaceId, id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: nowIso() };
    this.db.run(
      `UPDATE decisions SET project_id=?, title=?, context=?, choice=?, rationale=?, alternatives=?,
        status=?, outcome=?, decided_at=?, updated_at=? WHERE workspace_id=? AND id=?`,
      [next.projectId, next.title, next.context, next.choice, next.rationale, toJson(next.alternatives), next.status, next.outcome, next.decidedAt, next.updatedAt, workspaceId, id],
    );
    return next;
  }

  delete(workspaceId: Id, id: Id): void {
    this.db.run('DELETE FROM decisions WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  }
}

/* ---------------------------------------------------------------- */
/* Sources, evidence, activity, sync                                 */
/* ---------------------------------------------------------------- */

export class SourceRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** Idempotent by (workspace, connector, kind, externalId). */
  upsert(input: Omit<SourceRecord, 'id' | 'createdAt'>): { record: SourceRecord; created: boolean; changed: boolean } {
    const existing = this.db.one<R>(
      'SELECT * FROM source_records WHERE workspace_id=? AND connector=? AND kind=? AND external_id=?',
      [input.workspaceId, input.connector, input.kind, input.externalId],
    );
    if (existing) {
      const prev = mapSource(existing);
      const changed = prev.payloadHash !== input.payloadHash;
      if (changed) {
        this.db.run(
          `UPDATE source_records SET locator=?, url=?, payload=?, payload_hash=?, observed_at=?, connected_account_id=?
           WHERE id=?`,
          [input.locator, input.url, toJson(input.payload), input.payloadHash, input.observedAt, input.connectedAccountId, prev.id],
        );
      } else {
        this.db.run('UPDATE source_records SET observed_at=? WHERE id=?', [input.observedAt, prev.id]);
      }
      return { record: { ...prev, ...input, id: prev.id, createdAt: prev.createdAt }, created: false, changed };
    }
    const rec: SourceRecord = { ...input, id: newId('src'), createdAt: nowIso() };
    this.db.run(
      `INSERT INTO source_records (id,workspace_id,connected_account_id,connector,kind,external_id,locator,url,payload,payload_hash,observed_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [rec.id, rec.workspaceId, rec.connectedAccountId, rec.connector, rec.kind, rec.externalId, rec.locator, rec.url, toJson(rec.payload), rec.payloadHash, rec.observedAt, rec.createdAt],
    );
    return { record: rec, created: true, changed: true };
  }

  byId(workspaceId: Id, id: Id): SourceRecord | null {
    const r = this.db.one<R>('SELECT * FROM source_records WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
    return r ? mapSource(r) : null;
  }

  byExternalId(workspaceId: Id, connector: string, kind: string, externalId: string): SourceRecord | null {
    const r = this.db.one<R>(
      'SELECT * FROM source_records WHERE workspace_id=? AND connector=? AND kind=? AND external_id=?',
      [workspaceId, connector, kind, externalId],
    );
    return r ? mapSource(r) : null;
  }

  list(workspaceId: Id, opts: { connector?: string; kind?: string; limit?: number } = {}): SourceRecord[] {
    const where = ['workspace_id = ?'];
    const params: SqlValue[] = [workspaceId];
    if (opts.connector) { where.push('connector = ?'); params.push(opts.connector); }
    if (opts.kind) { where.push('kind = ?'); params.push(opts.kind); }
    params.push(opts.limit ?? 500);
    return this.db
      .query<R>(`SELECT * FROM source_records WHERE ${where.join(' AND ')} ORDER BY observed_at DESC LIMIT ?`, params)
      .map(mapSource);
  }

  /** Drops payloads past the retention window but keeps the provenance stub. */
  pruneRetained(workspaceId: Id, olderThanIso: Iso): number {
    const res = this.db.run(
      `UPDATE source_records SET payload = '{}' WHERE workspace_id = ? AND observed_at < ? AND payload != '{}'`,
      [workspaceId, olderThanIso],
    );
    return res.changes;
  }

  deleteByConnector(workspaceId: Id, connector: string): number {
    return this.db.run('DELETE FROM source_records WHERE workspace_id = ? AND connector = ?', [workspaceId, connector]).changes;
  }

  idsByConnector(workspaceId: Id, connector: string): Id[] {
    return this.db
      .query<R>('SELECT id FROM source_records WHERE workspace_id = ? AND connector = ?', [workspaceId, connector])
      .map((r) => s(r.id));
  }
}

export class EvidenceRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  add(input: Omit<Evidence, 'id' | 'createdAt'>): Evidence {
    const e: Evidence = { ...input, id: newId('evd'), createdAt: nowIso() };
    this.db.run(
      'INSERT INTO evidence (id,workspace_id,subject,claim,source_id,confidence,observed_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [e.id, e.workspaceId, e.subject, e.claim, e.sourceId, e.confidence, e.observedAt, e.createdAt],
    );
    return e;
  }

  forSubject(workspaceId: Id, subject: string): Evidence[] {
    return this.db
      .query<R>('SELECT * FROM evidence WHERE workspace_id = ? AND subject = ? ORDER BY observed_at DESC', [workspaceId, subject])
      .map((r) => ({
        id: s(r.id), workspaceId: s(r.workspace_id), subject: s(r.subject), claim: s(r.claim),
        sourceId: sn(r.source_id), confidence: s(r.confidence) as Confidence,
        observedAt: s(r.observed_at), createdAt: s(r.created_at),
      }));
  }
}

export class ActivityRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  add(input: Omit<ActivityEvent, 'id' | 'createdAt'>): ActivityEvent {
    const a: ActivityEvent = { ...input, id: newId('act'), createdAt: nowIso() };
    this.db.run(
      `INSERT INTO activity_events (id,workspace_id,project_id,connector,kind,summary,url,source_id,actor,occurred_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [a.id, a.workspaceId, a.projectId, a.connector, a.kind, a.summary, a.url, a.sourceId, a.actor, a.occurredAt, a.createdAt],
    );
    return a;
  }

  /** Skips an event already recorded for the same source and kind. */
  addOnce(input: Omit<ActivityEvent, 'id' | 'createdAt'>): ActivityEvent | null {
    if (input.sourceId) {
      const dupe = this.db.one<R>(
        'SELECT 1 AS x FROM activity_events WHERE workspace_id=? AND source_id=? AND kind=? AND occurred_at=?',
        [input.workspaceId, input.sourceId, input.kind, input.occurredAt],
      );
      if (dupe) return null;
    }
    return this.add(input);
  }

  recent(workspaceId: Id, opts: { limit?: number; since?: Iso; projectId?: Id } = {}): ActivityEvent[] {
    const where = ['workspace_id = ?'];
    const params: SqlValue[] = [workspaceId];
    if (opts.since) { where.push('occurred_at >= ?'); params.push(opts.since); }
    if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
    params.push(opts.limit ?? 50);
    return this.db
      .query<R>(`SELECT * FROM activity_events WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC LIMIT ?`, params)
      .map(mapActivity);
  }

  countSince(workspaceId: Id, since: Iso): number {
    return n(
      this.db.one<R>('SELECT COUNT(*) AS c FROM activity_events WHERE workspace_id = ? AND occurred_at >= ?', [workspaceId, since])?.c ?? 0,
    );
  }
}

export class ConnectedAccountRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(input: Partial<ConnectedAccount> & { workspaceId: Id; connector: ConnectorKey; accountLabel: string }): ConnectedAccount {
    const now = nowIso();
    const a: ConnectedAccount = {
      id: newId('acc'), workspaceId: input.workspaceId, connector: input.connector,
      accountLabel: input.accountLabel, credentialCipher: input.credentialCipher ?? null,
      scopes: input.scopes ?? [], allowlist: input.allowlist ?? [],
      status: input.status ?? 'active', lastError: null, lastSyncAt: null,
      cursor: input.cursor ?? null, createdAt: now, updatedAt: now,
    };
    this.db.run(
      `INSERT INTO connected_accounts (id,workspace_id,connector,account_label,credential_cipher,scopes,allowlist,status,last_error,last_sync_at,cursor,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)`,
      [a.id, a.workspaceId, a.connector, a.accountLabel, a.credentialCipher, toJson(a.scopes), toJson(a.allowlist), a.status, a.cursor, a.createdAt, a.updatedAt],
    );
    return a;
  }

  byId(workspaceId: Id, id: Id): ConnectedAccount | null {
    const r = this.db.one<R>('SELECT * FROM connected_accounts WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
    return r ? mapAccount(r) : null;
  }

  list(workspaceId: Id): ConnectedAccount[] {
    return this.db
      .query<R>('SELECT * FROM connected_accounts WHERE workspace_id = ? ORDER BY created_at', [workspaceId])
      .map(mapAccount);
  }

  byConnector(workspaceId: Id, connector: ConnectorKey): ConnectedAccount[] {
    return this.list(workspaceId).filter((a) => a.connector === connector);
  }

  update(workspaceId: Id, id: Id, patch: Partial<ConnectedAccount>): ConnectedAccount | null {
    const cur = this.byId(workspaceId, id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: nowIso() };
    this.db.run(
      `UPDATE connected_accounts SET account_label=?, credential_cipher=?, scopes=?, allowlist=?, status=?,
        last_error=?, last_sync_at=?, cursor=?, updated_at=? WHERE workspace_id=? AND id=?`,
      [next.accountLabel, next.credentialCipher, toJson(next.scopes), toJson(next.allowlist), next.status, next.lastError, next.lastSyncAt, next.cursor, next.updatedAt, workspaceId, id],
    );
    return next;
  }

  /** Revocation clears the stored credential; synced records are kept unless the user deletes them. */
  revoke(workspaceId: Id, id: Id): void {
    this.db.run(
      `UPDATE connected_accounts SET status='revoked', credential_cipher=NULL, cursor=NULL, updated_at=?
       WHERE workspace_id=? AND id=?`,
      [nowIso(), workspaceId, id],
    );
  }

  delete(workspaceId: Id, id: Id): void {
    this.db.run('DELETE FROM connected_accounts WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  }
}

export class SyncRunRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  start(input: { workspaceId: Id; connectedAccountId: Id; connector: ConnectorKey; trigger: SyncRun['trigger']; cursorBefore: string | null }): SyncRun {
    const run: SyncRun = {
      id: newId('syn'), workspaceId: input.workspaceId, connectedAccountId: input.connectedAccountId,
      connector: input.connector, trigger: input.trigger, status: 'running',
      startedAt: nowIso(), finishedAt: null, stats: emptyStats(), error: null,
      cursorBefore: input.cursorBefore, cursorAfter: null,
    };
    this.db.run(
      `INSERT INTO sync_runs (id,workspace_id,connected_account_id,connector,trigger,status,started_at,finished_at,stats,error,cursor_before,cursor_after)
       VALUES (?,?,?,?,?,?,?,NULL,?,NULL,?,NULL)`,
      [run.id, run.workspaceId, run.connectedAccountId, run.connector, run.trigger, run.status, run.startedAt, toJson(run.stats), run.cursorBefore],
    );
    return run;
  }

  finish(id: Id, patch: { status: SyncRun['status']; stats: SyncStats; error?: string | null; cursorAfter?: string | null }): void {
    this.db.run(
      'UPDATE sync_runs SET status=?, stats=?, error=?, cursor_after=?, finished_at=? WHERE id=?',
      [patch.status, toJson(patch.stats), patch.error ?? null, patch.cursorAfter ?? null, nowIso(), id],
    );
  }

  latestFor(workspaceId: Id, connectedAccountId: Id): SyncRun | null {
    const r = this.db.one<R>(
      'SELECT * FROM sync_runs WHERE workspace_id = ? AND connected_account_id = ? ORDER BY started_at DESC LIMIT 1',
      [workspaceId, connectedAccountId],
    );
    return r ? mapSyncRun(r) : null;
  }

  list(workspaceId: Id, limit = 25): SyncRun[] {
    return this.db
      .query<R>('SELECT * FROM sync_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?', [workspaceId, limit])
      .map(mapSyncRun);
  }
}

export class ImportBatchRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  start(input: { workspaceId: Id; kind: ImportBatch['kind']; label: string; fileCount: number }): ImportBatch {
    const b: ImportBatch = {
      id: newId('imp'), workspaceId: input.workspaceId, kind: input.kind, label: input.label,
      fileCount: input.fileCount, recordsCreated: 0, recordsSkipped: 0, redactions: 0,
      status: 'running', error: null, createdAt: nowIso(), finishedAt: null,
    };
    this.db.run(
      `INSERT INTO import_batches (id,workspace_id,kind,label,file_count,records_created,records_skipped,redactions,status,error,created_at,finished_at)
       VALUES (?,?,?,?,?,0,0,0,'running',NULL,?,NULL)`,
      [b.id, b.workspaceId, b.kind, b.label, b.fileCount, b.createdAt],
    );
    return b;
  }

  finish(id: Id, patch: { status: ImportBatch['status']; recordsCreated: number; recordsSkipped: number; redactions: number; error?: string | null }): void {
    this.db.run(
      'UPDATE import_batches SET status=?, records_created=?, records_skipped=?, redactions=?, error=?, finished_at=? WHERE id=?',
      [patch.status, patch.recordsCreated, patch.recordsSkipped, patch.redactions, patch.error ?? null, nowIso(), id],
    );
  }

  list(workspaceId: Id, limit = 25): ImportBatch[] {
    return this.db
      .query<R>('SELECT * FROM import_batches WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?', [workspaceId, limit])
      .map((r) => ({
        id: s(r.id), workspaceId: s(r.workspace_id), kind: s(r.kind) as ImportBatch['kind'],
        label: s(r.label), fileCount: n(r.file_count), recordsCreated: n(r.records_created),
        recordsSkipped: n(r.records_skipped), redactions: n(r.redactions),
        status: s(r.status) as ImportBatch['status'], error: sn(r.error),
        createdAt: s(r.created_at), finishedAt: sn(r.finished_at),
      }));
  }
}

/* ---------------------------------------------------------------- */
/* Resources, metrics, time                                          */
/* ---------------------------------------------------------------- */

export class ResourceRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(input: Partial<Resource> & { workspaceId: Id; kind: ResourceKind; name: string }): Resource {
    const now = nowIso();
    const r: Resource = {
      id: newId('res'), workspaceId: input.workspaceId, projectId: input.projectId ?? null,
      kind: input.kind, name: input.name, amountMinor: input.amountMinor ?? null,
      currency: input.currency ?? 'USD', period: input.period ?? null, minutes: input.minutes ?? null,
      origin: input.origin ?? 'manual', notes: input.notes ?? '',
      lastConfirmedAt: input.lastConfirmedAt ?? null, startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null, createdAt: now, updatedAt: now,
    };
    this.db.run(
      `INSERT INTO resources (id,workspace_id,project_id,kind,name,amount_minor,currency,period,minutes,origin,notes,last_confirmed_at,started_at,ended_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [r.id, r.workspaceId, r.projectId, r.kind, r.name, r.amountMinor, r.currency, r.period, r.minutes, r.origin, r.notes, r.lastConfirmedAt, r.startedAt, r.endedAt, r.createdAt, r.updatedAt],
    );
    return r;
  }

  list(workspaceId: Id, opts: { kind?: ResourceKind[]; projectId?: Id; activeOnly?: boolean } = {}): Resource[] {
    const where = ['workspace_id = ?'];
    const params: SqlValue[] = [workspaceId];
    if (opts.kind?.length) {
      where.push(`kind IN (${opts.kind.map(() => '?').join(',')})`);
      params.push(...opts.kind);
    }
    if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
    if (opts.activeOnly) where.push('ended_at IS NULL');
    return this.db
      .query<R>(`SELECT * FROM resources WHERE ${where.join(' AND ')} ORDER BY kind, name`, params)
      .map(mapResource);
  }

  byId(workspaceId: Id, id: Id): Resource | null {
    const r = this.db.one<R>('SELECT * FROM resources WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
    return r ? mapResource(r) : null;
  }

  update(workspaceId: Id, id: Id, patch: Partial<Resource>): Resource | null {
    const cur = this.byId(workspaceId, id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: nowIso() };
    this.db.run(
      `UPDATE resources SET project_id=?, kind=?, name=?, amount_minor=?, currency=?, period=?, minutes=?,
        notes=?, last_confirmed_at=?, started_at=?, ended_at=?, updated_at=? WHERE workspace_id=? AND id=?`,
      [next.projectId, next.kind, next.name, next.amountMinor, next.currency, next.period, next.minutes, next.notes, next.lastConfirmedAt, next.startedAt, next.endedAt, next.updatedAt, workspaceId, id],
    );
    return next;
  }

  delete(workspaceId: Id, id: Id): void {
    this.db.run('DELETE FROM resources WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  }
}

export class MetricRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  record(input: Omit<Metric, 'id' | 'createdAt'>): Metric {
    const m: Metric = { ...input, id: newId('met'), createdAt: nowIso() };
    this.db.run(
      `INSERT INTO metrics (id,workspace_id,project_id,key,label,value,unit,origin,source_id,target,observed_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [m.id, m.workspaceId, m.projectId, m.key, m.label, m.value, m.unit, m.origin, m.sourceId, m.target, m.observedAt, m.createdAt],
    );
    return m;
  }

  /** Latest value per key for a project (or the workspace when projectId is null). */
  latest(workspaceId: Id, projectId: Id | null): Metric[] {
    const rows = projectId
      ? this.db.query<R>(
          `SELECT * FROM metrics WHERE workspace_id=? AND project_id=? AND observed_at = (
             SELECT MAX(m2.observed_at) FROM metrics m2
             WHERE m2.workspace_id=metrics.workspace_id AND m2.project_id IS metrics.project_id AND m2.key=metrics.key
           ) ORDER BY key`,
          [workspaceId, projectId],
        )
      : this.db.query<R>(
          `SELECT * FROM metrics WHERE workspace_id=? AND observed_at = (
             SELECT MAX(m2.observed_at) FROM metrics m2
             WHERE m2.workspace_id=metrics.workspace_id AND m2.key=metrics.key
           ) ORDER BY key`,
          [workspaceId],
        );
    return rows.map(mapMetric);
  }

  history(workspaceId: Id, key: string, projectId: Id | null, limit = 60): Metric[] {
    const rows = projectId
      ? this.db.query<R>(
          'SELECT * FROM metrics WHERE workspace_id=? AND key=? AND project_id=? ORDER BY observed_at DESC LIMIT ?',
          [workspaceId, key, projectId, limit],
        )
      : this.db.query<R>('SELECT * FROM metrics WHERE workspace_id=? AND key=? ORDER BY observed_at DESC LIMIT ?', [
          workspaceId, key, limit,
        ]);
    return rows.map(mapMetric);
  }
}

export interface TimeEntry {
  id: Id;
  workspaceId: Id;
  projectId: Id | null;
  taskId: Id | null;
  label: string;
  minutes: number;
  kind: 'focus' | 'meeting' | 'admin' | 'break';
  origin: Origin;
  occurredOn: string;
  createdAt: Iso;
}

export class TimeRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  log(input: Partial<TimeEntry> & { workspaceId: Id; minutes: number }): TimeEntry {
    const e: TimeEntry = {
      id: newId('tim'), workspaceId: input.workspaceId, projectId: input.projectId ?? null,
      taskId: input.taskId ?? null, label: input.label ?? '', minutes: Math.max(0, Math.round(input.minutes)),
      kind: input.kind ?? 'focus', origin: input.origin ?? 'manual',
      occurredOn: input.occurredOn ?? isoDay(), createdAt: nowIso(),
    };
    this.db.run(
      `INSERT INTO time_entries (id,workspace_id,project_id,task_id,label,minutes,kind,origin,occurred_on,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [e.id, e.workspaceId, e.projectId, e.taskId, e.label, e.minutes, e.kind, e.origin, e.occurredOn, e.createdAt],
    );
    return e;
  }

  list(workspaceId: Id, opts: { fromDay?: string; toDay?: string; projectId?: Id } = {}): TimeEntry[] {
    const where = ['workspace_id = ?'];
    const params: SqlValue[] = [workspaceId];
    if (opts.fromDay) { where.push('occurred_on >= ?'); params.push(opts.fromDay); }
    if (opts.toDay) { where.push('occurred_on <= ?'); params.push(opts.toDay); }
    if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
    return this.db
      .query<R>(`SELECT * FROM time_entries WHERE ${where.join(' AND ')} ORDER BY occurred_on DESC`, params)
      .map((r) => ({
        id: s(r.id), workspaceId: s(r.workspace_id), projectId: sn(r.project_id), taskId: sn(r.task_id),
        label: s(r.label), minutes: n(r.minutes), kind: s(r.kind) as TimeEntry['kind'],
        origin: s(r.origin) as Origin, occurredOn: s(r.occurred_on), createdAt: s(r.created_at),
      }));
  }

  delete(workspaceId: Id, id: Id): void {
    this.db.run('DELETE FROM time_entries WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  }
}

export class ReportRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(input: Omit<Report, 'id' | 'createdAt'>): Report {
    const r: Report = { ...input, id: newId('rep'), createdAt: nowIso() };
    this.db.run(
      'INSERT INTO reports (id,workspace_id,cadence,period_start,period_end,body,origin,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [r.id, r.workspaceId, r.cadence, r.periodStart, r.periodEnd, toJson(r.body), r.origin, r.createdAt],
    );
    return r;
  }

  list(workspaceId: Id, limit = 20): Report[] {
    return this.db
      .query<R>('SELECT * FROM reports WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?', [workspaceId, limit])
      .map((r) => ({
        id: s(r.id), workspaceId: s(r.workspace_id), cadence: s(r.cadence) as Cadence,
        periodStart: s(r.period_start), periodEnd: s(r.period_end),
        body: parseJson<Record<string, unknown>>(r.body, {}), origin: s(r.origin) as Origin,
        createdAt: s(r.created_at),
      }));
  }

  byId(workspaceId: Id, id: Id): Report | null {
    const r = this.db.one<R>('SELECT * FROM reports WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
    if (!r) return null;
    return {
      id: s(r.id), workspaceId: s(r.workspace_id), cadence: s(r.cadence) as Cadence,
      periodStart: s(r.period_start), periodEnd: s(r.period_end),
      body: parseJson<Record<string, unknown>>(r.body, {}), origin: s(r.origin) as Origin,
      createdAt: s(r.created_at),
    };
  }
}

export class AuditRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  log(input: { workspaceId: Id | null; actorUserId: Id | null; action: string; subject: string; detail?: Record<string, unknown>; ip?: string | null }): AuditLog {
    const a: AuditLog = {
      id: newId('aud'), workspaceId: input.workspaceId, actorUserId: input.actorUserId,
      action: input.action, subject: input.subject, detail: input.detail ?? {},
      ip: input.ip ?? null, createdAt: nowIso(),
    };
    this.db.run(
      'INSERT INTO audit_logs (id,workspace_id,actor_user_id,action,subject,detail,ip,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [a.id, a.workspaceId, a.actorUserId, a.action, a.subject, toJson(a.detail), a.ip, a.createdAt],
    );
    return a;
  }

  list(workspaceId: Id, limit = 100): AuditLog[] {
    return this.db
      .query<R>('SELECT * FROM audit_logs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?', [workspaceId, limit])
      .map((r) => ({
        id: s(r.id), workspaceId: sn(r.workspace_id), actorUserId: sn(r.actor_user_id),
        action: s(r.action), subject: s(r.subject),
        detail: parseJson<Record<string, unknown>>(r.detail, {}), ip: sn(r.ip), createdAt: s(r.created_at),
      }));
  }
}

/* ---------------------------------------------------------------- */
/* Aggregate                                                         */
/* ---------------------------------------------------------------- */

/** Every repository, bound to one database handle. */
export class Store {
  readonly users: UserRepo;
  readonly workspaces: WorkspaceRepo;
  readonly sessions: SessionRepo;
  readonly tokens: AccessTokenRepo;
  readonly brainConfig: BrainConfigRepo;
  readonly modules: ModuleRepo;
  readonly projects: ProjectRepo;
  readonly relationships: RelationshipRepo;
  readonly knowledge: KnowledgeRepo;
  readonly goals: GoalRepo;
  readonly tasks: TaskRepo;
  readonly decisions: DecisionRepo;
  readonly sources: SourceRepo;
  readonly evidence: EvidenceRepo;
  readonly activity: ActivityRepo;
  readonly accounts: ConnectedAccountRepo;
  readonly syncRuns: SyncRunRepo;
  readonly imports: ImportBatchRepo;
  readonly resources: ResourceRepo;
  readonly metrics: MetricRepo;
  readonly time: TimeRepo;
  readonly reports: ReportRepo;
  readonly audit: AuditRepo;

  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.users = new UserRepo(db);
    this.workspaces = new WorkspaceRepo(db);
    this.sessions = new SessionRepo(db);
    this.tokens = new AccessTokenRepo(db);
    this.brainConfig = new BrainConfigRepo(db);
    this.modules = new ModuleRepo(db);
    this.projects = new ProjectRepo(db);
    this.relationships = new RelationshipRepo(db);
    this.knowledge = new KnowledgeRepo(db);
    this.goals = new GoalRepo(db);
    this.tasks = new TaskRepo(db);
    this.decisions = new DecisionRepo(db);
    this.sources = new SourceRepo(db);
    this.evidence = new EvidenceRepo(db);
    this.activity = new ActivityRepo(db);
    this.accounts = new ConnectedAccountRepo(db);
    this.syncRuns = new SyncRunRepo(db);
    this.imports = new ImportBatchRepo(db);
    this.resources = new ResourceRepo(db);
    this.metrics = new MetricRepo(db);
    this.time = new TimeRepo(db);
    this.reports = new ReportRepo(db);
    this.audit = new AuditRepo(db);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }
}
