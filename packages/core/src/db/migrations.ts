/**
 * Versioned, forward-only migrations.
 *
 * SQL is deliberately kept to a portable subset (no SQLite-only column types,
 * no `AUTOINCREMENT`, ids generated in application code) so the Postgres
 * adapter on the roadmap can reuse these statements with mechanical edits.
 * The two exceptions are the FTS5 virtual table and its triggers, which are
 * isolated in migration 2 and have a documented `tsvector` equivalent.
 */

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-records',
    statements: [
      `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_minor_account INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'personal',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_workspaces_owner_slug ON workspaces(owner_id, slug)`,
      `CREATE TABLE workspace_members (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_members_unique ON workspace_members(workspace_id, user_id)`,
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )`,
      `CREATE TABLE access_tokens (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL DEFAULT '[]',
        last_used_at TEXT,
        revoked_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE brain_configurations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        profile TEXT NOT NULL,
        display_name TEXT NOT NULL,
        intents TEXT NOT NULL DEFAULT '[]',
        modules TEXT NOT NULL DEFAULT '[]',
        knowledge_categories TEXT NOT NULL DEFAULT '[]',
        goal_hierarchy TEXT NOT NULL DEFAULT '[]',
        project_taxonomy TEXT NOT NULL DEFAULT '[]',
        preferred_metrics TEXT NOT NULL DEFAULT '[]',
        reporting_cadence TEXT NOT NULL,
        recommended_connectors TEXT NOT NULL DEFAULT '[]',
        privacy TEXT NOT NULL,
        dashboard_layout TEXT NOT NULL,
        assistant_instructions TEXT NOT NULL DEFAULT '',
        automation_level TEXT NOT NULL DEFAULT 'review',
        working_style TEXT NOT NULL DEFAULT 'balanced',
        created_by TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_brain_cfg_version ON brain_configurations(workspace_id, version)`,
      `CREATE TABLE modules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        settings TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_modules_unique ON modules(workspace_id, key)`,
      `CREATE TABLE connected_accounts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        connector TEXT NOT NULL,
        account_label TEXT NOT NULL,
        credential_cipher TEXT,
        scopes TEXT NOT NULL DEFAULT '[]',
        allowlist TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        last_error TEXT,
        last_sync_at TEXT,
        cursor TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_accounts_ws ON connected_accounts(workspace_id, connector)`,
      `CREATE TABLE source_records (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        connected_account_id TEXT REFERENCES connected_accounts(id) ON DELETE SET NULL,
        connector TEXT NOT NULL,
        kind TEXT NOT NULL,
        external_id TEXT NOT NULL,
        locator TEXT NOT NULL,
        url TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        payload_hash TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_sources_identity ON source_records(workspace_id, connector, kind, external_id)`,
      `CREATE INDEX idx_sources_observed ON source_records(workspace_id, observed_at)`,
      `CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'other',
        lifecycle TEXT NOT NULL DEFAULT 'active',
        origin TEXT NOT NULL DEFAULT 'manual',
        source_key TEXT,
        source_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        review_state TEXT NOT NULL DEFAULT 'confirmed',
        confidence TEXT NOT NULL DEFAULT 'observed',
        match_score REAL NOT NULL DEFAULT 1,
        parent_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        archived_at TEXT,
        last_activity_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_projects_slug ON projects(workspace_id, slug)`,
      `CREATE UNIQUE INDEX idx_projects_source_key ON projects(workspace_id, source_key) WHERE source_key IS NOT NULL`,
      `CREATE INDEX idx_projects_review ON projects(workspace_id, review_state)`,
      `CREATE TABLE project_relationships (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        from_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        to_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        evidence_id TEXT,
        confidence TEXT NOT NULL DEFAULT 'medium',
        created_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_rel_unique ON project_relationships(workspace_id, from_project_id, to_project_id, kind)`,
      `CREATE TABLE knowledge_records (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        klass TEXT NOT NULL DEFAULT 'fact',
        origin TEXT NOT NULL DEFAULT 'manual',
        confidence TEXT NOT NULL DEFAULT 'observed',
        source_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
        content_hash TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        supersedes_id TEXT REFERENCES knowledge_records(id) ON DELETE SET NULL,
        contradicts_id TEXT REFERENCES knowledge_records(id) ON DELETE SET NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      )`,
      `CREATE INDEX idx_knowledge_ws ON knowledge_records(workspace_id, klass)`,
      `CREATE INDEX idx_knowledge_hash ON knowledge_records(workspace_id, content_hash)`,
      `CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        parent_goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        horizon TEXT NOT NULL DEFAULT 'quarter',
        status TEXT NOT NULL DEFAULT 'active',
        progress INTEGER NOT NULL DEFAULT 0,
        progress_origin TEXT NOT NULL DEFAULT 'manual',
        target_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        priority INTEGER NOT NULL DEFAULT 3,
        due_at TEXT,
        estimate_minutes INTEGER,
        completed_at TEXT,
        origin TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_tasks_ws_status ON tasks(workspace_id, status)`,
      `CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        choice TEXT NOT NULL DEFAULT '',
        rationale TEXT NOT NULL DEFAULT '',
        alternatives TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'accepted',
        supersedes_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
        outcome TEXT NOT NULL DEFAULT '',
        decided_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        claim TEXT NOT NULL,
        source_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
        confidence TEXT NOT NULL DEFAULT 'medium',
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_evidence_subject ON evidence(workspace_id, subject)`,
      `CREATE TABLE activity_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        connector TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        url TEXT,
        source_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
        actor TEXT,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_activity_ws_time ON activity_events(workspace_id, occurred_at)`,
      `CREATE INDEX idx_activity_project ON activity_events(project_id, occurred_at)`,
      `CREATE TABLE resources (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        amount_minor INTEGER,
        currency TEXT NOT NULL DEFAULT 'USD',
        period TEXT,
        minutes INTEGER,
        origin TEXT NOT NULL DEFAULT 'manual',
        notes TEXT NOT NULL DEFAULT '',
        last_confirmed_at TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_resources_ws_kind ON resources(workspace_id, kind)`,
      `CREATE TABLE metrics (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
        target REAL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_metrics_lookup ON metrics(workspace_id, project_id, key, observed_at)`,
      `CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        connected_account_id TEXT NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
        connector TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        stats TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        cursor_before TEXT,
        cursor_after TEXT
      )`,
      `CREATE INDEX idx_sync_ws_time ON sync_runs(workspace_id, started_at)`,
      `CREATE TABLE import_batches (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        records_created INTEGER NOT NULL DEFAULT 0,
        records_skipped INTEGER NOT NULL DEFAULT 0,
        redactions INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      )`,
      `CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        cadence TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '{}',
        origin TEXT NOT NULL DEFAULT 'derived',
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_reports_ws ON reports(workspace_id, created_at)`,
      `CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        actor_user_id TEXT,
        action TEXT NOT NULL,
        subject TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        ip TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_audit_ws ON audit_logs(workspace_id, created_at)`,
    ],
  },
  {
    version: 2,
    name: 'knowledge-full-text-search',
    statements: [
      // Postgres equivalent: a generated tsvector column plus a GIN index.
      `CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        title, body, tags,
        content='knowledge_records',
        content_rowid='rowid',
        tokenize='porter unicode61'
      )`,
      `CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge_records BEGIN
        INSERT INTO knowledge_fts(rowid, title, body, tags)
        VALUES (new.rowid, new.title, new.body, new.tags);
      END`,
      `CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge_records BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body, tags)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags);
      END`,
      `CREATE TRIGGER knowledge_fts_au AFTER UPDATE ON knowledge_records BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body, tags)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags);
        INSERT INTO knowledge_fts(rowid, title, body, tags)
        VALUES (new.rowid, new.title, new.body, new.tags);
      END`,
    ],
  },
  {
    version: 3,
    name: 'project-search-and-time-log',
    statements: [
      `CREATE TABLE time_entries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        label TEXT NOT NULL DEFAULT '',
        minutes INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'focus',
        origin TEXT NOT NULL DEFAULT 'manual',
        occurred_on TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_time_ws_day ON time_entries(workspace_id, occurred_on)`,
      `CREATE INDEX idx_projects_activity ON projects(workspace_id, last_activity_at)`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
