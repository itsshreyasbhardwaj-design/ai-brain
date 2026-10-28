/**
 * Canonical data model for AI BRAIN.
 *
 * Every record that can originate outside the user's own typing carries
 * provenance: which connected source produced it, which upstream identifier it
 * has, and when it was last confirmed. Nothing in this system is allowed to
 * present a generated value as an observed one, so the distinction is encoded
 * in the types rather than left to convention.
 */

export type Id = string;
export type Iso = string;

/** How a record came to exist. Drives every "is this real?" decision downstream. */
export type Origin =
  /** The user typed it. */
  | 'manual'
  /** Pulled from an authorized connected account. */
  | 'connector'
  /** Parsed from a file the user explicitly imported. */
  | 'import'
  /** Produced by a deterministic rule over other records. */
  | 'derived'
  /** Produced by a language model. Never treated as fact. */
  | 'generated';

/** Confidence in a record or inference. Shown to the user, never hidden. */
export type Confidence = 'observed' | 'high' | 'medium' | 'low' | 'unverified';

export type Lifecycle =
  | 'idea'
  | 'planning'
  | 'active'
  | 'blocked'
  | 'paused'
  | 'shipped'
  | 'archived';

export type ProjectCategory =
  | 'software'
  | 'business'
  | 'product'
  | 'content'
  | 'research'
  | 'client'
  | 'personal'
  | 'study'
  | 'other';

/** The modules a brain can switch on. Profiles are presets over this set. */
export type ModuleKey =
  | 'projects'
  | 'knowledge'
  | 'tasks'
  | 'goals'
  | 'decisions'
  | 'developer'
  | 'business'
  | 'resources'
  | 'calendar'
  | 'reports'
  | 'productivity'
  | 'assistant'
  | 'integrations';

export type BrainProfileKey =
  | 'founder'
  | 'developer'
  | 'creator'
  | 'freelancer'
  | 'research'
  | 'personal'
  | 'student'
  | 'custom';

export type ConnectorKey =
  | 'github'
  | 'local-directory'
  | 'claude-code'
  | 'codex'
  | 'markdown-import'
  | 'conversation-import';

export interface User {
  id: Id;
  email: string;
  displayName: string;
  /** scrypt; see security/password.ts. Never leaves the server. */
  passwordHash: string;
  createdAt: Iso;
  updatedAt: Iso;
  /** Age-appropriate protections for the student profile. */
  isMinorAccount: boolean;
}

export interface Workspace {
  id: Id;
  ownerId: Id;
  name: string;
  slug: string;
  /** 'personal' keeps academic and private records out of shared surfaces. */
  kind: 'personal' | 'team';
  createdAt: Iso;
  updatedAt: Iso;
}

export interface WorkspaceMember {
  id: Id;
  workspaceId: Id;
  userId: Id;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  createdAt: Iso;
}

/** Reporting cadence the review engine schedules against. */
export type Cadence = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'manual';

export interface PrivacyPreferences {
  /** Categories the user has excluded from import and from AI context. */
  excludedCategories: string[];
  /** Paths/globs never read, even inside an authorized directory. */
  excludedPaths: string[];
  /** Whether project bodies may be sent to a remote AI provider. */
  allowRemoteAi: boolean;
  /** Whether file contents (vs. metadata only) may be imported. */
  allowFileContentImport: boolean;
  /** Days after which synced source payloads are discarded. 0 = keep. */
  sourceRetentionDays: number;
}

export interface BrainConfiguration {
  id: Id;
  workspaceId: Id;
  /** Monotonic; every edit writes a new version and keeps the old one. */
  version: number;
  schemaVersion: number;
  profile: BrainProfileKey;
  displayName: string;
  /** What the user said they want help with, in their own words. */
  intents: string[];
  modules: ModuleKey[];
  knowledgeCategories: string[];
  goalHierarchy: GoalSeed[];
  projectTaxonomy: string[];
  preferredMetrics: string[];
  reportingCadence: Cadence;
  recommendedConnectors: ConnectorKey[];
  privacy: PrivacyPreferences;
  dashboardLayout: DashboardLayout;
  /** Optional free-text instructions handed to AI assistants as context. */
  assistantInstructions: string;
  automationLevel: 'manual' | 'review' | 'automatic';
  workingStyle: 'deep-work' | 'balanced' | 'reactive';
  createdAt: Iso;
  createdBy: Origin;
}

export interface GoalSeed {
  title: string;
  horizon: 'quarter' | 'year' | 'long-term';
  children?: GoalSeed[];
}

export interface DashboardWidget {
  key: string;
  /** Grid column span, 1-12. */
  span: number;
  visible: boolean;
}

export interface DashboardLayout {
  columns: number;
  widgets: DashboardWidget[];
}

export interface ModuleState {
  id: Id;
  workspaceId: Id;
  key: ModuleKey;
  enabled: boolean;
  settings: Record<string, unknown>;
  updatedAt: Iso;
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export interface Project {
  id: Id;
  workspaceId: Id;
  name: string;
  slug: string;
  description: string;
  category: ProjectCategory;
  lifecycle: Lifecycle;
  origin: Origin;
  /** Stable upstream key, e.g. "github:repo:123456". Unique per workspace. */
  sourceKey: string | null;
  sourceId: Id | null;
  /** Alternate names seen in the wild; used for dedup, never for matching alone. */
  aliases: string[];
  tags: string[];
  /** Set when discovery was not certain enough to auto-register. */
  reviewState: 'confirmed' | 'pending-review' | 'rejected';
  confidence: Confidence;
  /** 0-1. How sure discovery was that this is a distinct, real project. */
  matchScore: number;
  parentProjectId: Id | null;
  archivedAt: Iso | null;
  lastActivityAt: Iso | null;
  createdAt: Iso;
  updatedAt: Iso;
}

export type RelationshipKind =
  | 'monorepo-member'
  | 'fork-of'
  | 'deployment-of'
  | 'related'
  | 'product-of'
  | 'duplicate-of';

export interface ProjectRelationship {
  id: Id;
  workspaceId: Id;
  fromProjectId: Id;
  toProjectId: Id;
  kind: RelationshipKind;
  /** Why we believe this link exists. Empty means user-asserted. */
  evidenceId: Id | null;
  confidence: Confidence;
  createdAt: Iso;
}

/** A typed section of a Project Passport. Sections vary by project category. */
export type PassportSectionKey =
  | 'identity'
  | 'objectives'
  | 'activity'
  | 'resources'
  | 'documents'
  | 'decisions'
  | 'performance'
  | 'risks'
  | 'history'
  | 'recommendations'
  | 'repositories'
  | 'architecture'
  | 'dependencies'
  | 'ci'
  | 'tests'
  | 'security'
  | 'deployments'
  | 'financials';

export interface PassportSection {
  key: PassportSectionKey;
  title: string;
  /** Rendered rows. Empty array means "nothing known yet", not "zero". */
  rows: PassportRow[];
  /** Where the content came from. */
  origin: Origin;
  confidence: Confidence;
  /** Null when no source has ever populated this section. */
  lastVerifiedAt: Iso | null;
  sourceRefs: SourceRef[];
}

export interface PassportRow {
  label: string;
  value: string;
  href?: string;
  /** Marks a value the user should treat as uncertain. */
  uncertain?: boolean;
}

export interface SourceRef {
  connector: ConnectorKey | 'manual';
  /** Human-readable locator, e.g. "octocat/hello-world@main". */
  locator: string;
  url?: string;
  observedAt: Iso;
}

export interface ProjectPassport {
  projectId: Id;
  project: Project;
  sections: PassportSection[];
  completeness: number;
  generatedAt: Iso;
}

/* ------------------------------------------------------------------ */
/* Knowledge, goals, tasks, decisions                                  */
/* ------------------------------------------------------------------ */

export type KnowledgeClass = 'fact' | 'decision' | 'idea' | 'action' | 'insight';

export interface KnowledgeRecord {
  id: Id;
  workspaceId: Id;
  projectId: Id | null;
  title: string;
  body: string;
  klass: KnowledgeClass;
  origin: Origin;
  confidence: Confidence;
  sourceId: Id | null;
  /** Content hash; drives duplicate detection. */
  contentHash: string;
  tags: string[];
  /** Supersedes an earlier record; the old one is kept. */
  supersedesId: Id | null;
  /** Set when another record contradicts this one. */
  contradictsId: Id | null;
  observedAt: Iso;
  createdAt: Iso;
  updatedAt: Iso;
  archivedAt: Iso | null;
}

export interface Goal {
  id: Id;
  workspaceId: Id;
  parentGoalId: Id | null;
  projectId: Id | null;
  title: string;
  description: string;
  horizon: 'quarter' | 'year' | 'long-term';
  status: 'active' | 'achieved' | 'dropped' | 'at-risk';
  /** 0-100, user-maintained or derived from key results. */
  progress: number;
  progressOrigin: Origin;
  targetDate: Iso | null;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface Task {
  id: Id;
  workspaceId: Id;
  projectId: Id | null;
  goalId: Id | null;
  title: string;
  notes: string;
  status: 'todo' | 'doing' | 'done' | 'blocked' | 'dropped';
  priority: 1 | 2 | 3 | 4;
  dueAt: Iso | null;
  /** Minutes. User estimate, used by the time engine. */
  estimateMinutes: number | null;
  completedAt: Iso | null;
  origin: Origin;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface Decision {
  id: Id;
  workspaceId: Id;
  projectId: Id | null;
  title: string;
  context: string;
  choice: string;
  rationale: string;
  alternatives: string[];
  status: 'proposed' | 'accepted' | 'superseded' | 'reversed';
  supersedesId: Id | null;
  outcome: string;
  decidedAt: Iso;
  createdAt: Iso;
  updatedAt: Iso;
}

/* ------------------------------------------------------------------ */
/* Sources, evidence, activity                                         */
/* ------------------------------------------------------------------ */

/** A raw record retrieved from a source, kept so claims stay traceable. */
export interface SourceRecord {
  id: Id;
  workspaceId: Id;
  connectedAccountId: Id | null;
  connector: ConnectorKey | 'manual';
  /** Upstream type, e.g. "repository", "commit", "file". */
  kind: string;
  /** Upstream stable id. Unique with connector per workspace. */
  externalId: string;
  locator: string;
  url: string | null;
  /** Raw-ish payload, already filtered by privacy preferences. */
  payload: Record<string, unknown>;
  payloadHash: string;
  observedAt: Iso;
  createdAt: Iso;
}

/** Ties a claim to the source record that justifies it. */
export interface Evidence {
  id: Id;
  workspaceId: Id;
  /** Which record this supports: "project:abc", "metric:xyz". */
  subject: string;
  claim: string;
  sourceId: Id | null;
  confidence: Confidence;
  observedAt: Iso;
  createdAt: Iso;
}

export interface ActivityEvent {
  id: Id;
  workspaceId: Id;
  projectId: Id | null;
  connector: ConnectorKey | 'manual';
  kind: string;
  summary: string;
  url: string | null;
  sourceId: Id | null;
  actor: string | null;
  occurredAt: Iso;
  createdAt: Iso;
}

/* ------------------------------------------------------------------ */
/* Resources and metrics                                               */
/* ------------------------------------------------------------------ */

export type ResourceKind =
  | 'time'
  | 'subscription'
  | 'infrastructure'
  | 'tool'
  | 'person'
  | 'budget'
  | 'ai-api';

export interface Resource {
  id: Id;
  workspaceId: Id;
  projectId: Id | null;
  kind: ResourceKind;
  name: string;
  /** Minor units (cents) to avoid float drift. Null when not a cost. */
  amountMinor: number | null;
  currency: string;
  period: 'one-off' | 'monthly' | 'yearly' | null;
  /** Minutes, for time resources. */
  minutes: number | null;
  origin: Origin;
  notes: string;
  /** Last time the user or a source confirmed this is still in use. */
  lastConfirmedAt: Iso | null;
  startedAt: Iso | null;
  endedAt: Iso | null;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface Metric {
  id: Id;
  workspaceId: Id;
  projectId: Id | null;
  key: string;
  label: string;
  value: number;
  unit: string;
  origin: Origin;
  sourceId: Id | null;
  target: number | null;
  observedAt: Iso;
  createdAt: Iso;
}

/* ------------------------------------------------------------------ */
/* Connections and sync                                                */
/* ------------------------------------------------------------------ */

export interface Connector {
  key: ConnectorKey;
  label: string;
  /** What the connector can actually do today, in this release. */
  capabilities: Array<'discover' | 'activity' | 'metrics' | 'documents' | 'webhook'>;
  /** How data arrives. Honest about manual-export-only paths. */
  mode: 'api-poll' | 'api-webhook' | 'local-filesystem' | 'manual-export';
  /** Blank when fully supported; otherwise shown in the UI verbatim. */
  limitations: string;
  status: 'supported' | 'experimental' | 'roadmap';
}

export interface ConnectedAccount {
  id: Id;
  workspaceId: Id;
  connector: ConnectorKey;
  /** Account label, e.g. the GitHub login. */
  accountLabel: string;
  /** Encrypted at rest; see security/secrets.ts. */
  credentialCipher: string | null;
  /** Granted scopes as reported by the provider or chosen by the user. */
  scopes: string[];
  /** Explicit allowlist: only these repos/dirs are ever read. */
  allowlist: string[];
  status: 'active' | 'revoked' | 'error';
  lastError: string | null;
  lastSyncAt: Iso | null;
  /** Opaque incremental cursor per connector. */
  cursor: string | null;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface SyncRun {
  id: Id;
  workspaceId: Id;
  connectedAccountId: Id;
  connector: ConnectorKey;
  trigger: 'manual' | 'scheduled' | 'webhook';
  status: 'running' | 'success' | 'partial' | 'failed';
  startedAt: Iso;
  finishedAt: Iso | null;
  /** Counters, so the UI can show real freshness instead of a green dot. */
  stats: SyncStats;
  error: string | null;
  cursorBefore: string | null;
  cursorAfter: string | null;
}

export interface SyncStats {
  sourcesSeen: number;
  sourcesWritten: number;
  projectsCreated: number;
  projectsUpdated: number;
  projectsQueuedForReview: number;
  activityWritten: number;
  metricsWritten: number;
  skippedByPrivacy: number;
  rateLimitWaits: number;
  retries: number;
}

export interface ImportBatch {
  id: Id;
  workspaceId: Id;
  kind: 'markdown' | 'text' | 'json' | 'conversation-export' | 'csv';
  label: string;
  fileCount: number;
  recordsCreated: number;
  recordsSkipped: number;
  redactions: number;
  status: 'running' | 'success' | 'partial' | 'failed';
  error: string | null;
  createdAt: Iso;
  finishedAt: Iso | null;
}

/* ------------------------------------------------------------------ */
/* Reports and audit                                                   */
/* ------------------------------------------------------------------ */

export interface Report {
  id: Id;
  workspaceId: Id;
  cadence: Cadence;
  periodStart: Iso;
  periodEnd: Iso;
  /** Structured review payload; see engines/review.ts. */
  body: Record<string, unknown>;
  origin: Origin;
  createdAt: Iso;
}

export interface AuditLog {
  id: Id;
  workspaceId: Id | null;
  actorUserId: Id | null;
  action: string;
  subject: string;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: Iso;
}

export interface Session {
  id: Id;
  userId: Id;
  /** SHA-256 of the cookie value; the raw token is never stored. */
  tokenHash: string;
  expiresAt: Iso;
  createdAt: Iso;
  lastSeenAt: Iso;
}

/** Scoped token for MCP clients and context exports. */
export interface AccessToken {
  id: Id;
  workspaceId: Id;
  userId: Id;
  label: string;
  tokenHash: string;
  scopes: TokenScope[];
  lastUsedAt: Iso | null;
  revokedAt: Iso | null;
  expiresAt: Iso | null;
  createdAt: Iso;
}

export type TokenScope =
  | 'brain:read'
  | 'projects:read'
  | 'knowledge:read'
  | 'resources:read'
  | 'activity:read'
  | 'propose:write';
