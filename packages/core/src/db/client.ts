/**
 * Database client built on `node:sqlite`, which ships with Node itself.
 *
 * This is the reason AI BRAIN installs with no database server, no Docker and
 * no native build step: the engine, full-text search and JSON functions are
 * all already in the runtime. The surface exposed here is deliberately narrow
 * (`query`, `one`, `run`, `transaction`) so a Postgres adapter can implement
 * the same four methods later without the rest of the codebase noticing.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.ts';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface Db {
  query<T = Row>(sql: string, params?: SqlValue[]): T[];
  one<T = Row>(sql: string, params?: SqlValue[]): T | null;
  run(sql: string, params?: SqlValue[]): { changes: number };
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly schemaVersion: number;
  readonly path: string;
}

/** Normalises a prototype-less SQLite row into a plain object. */
function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

export interface OpenOptions {
  /** File path, or ':memory:' for tests. */
  path: string;
  /** Skip migrations (used by the migration CLI to report pending work). */
  skipMigrate?: boolean;
  readonly?: boolean;
}

export function openDb(opts: OpenOptions): Db {
  if (opts.path !== ':memory:') {
    mkdirSync(dirname(opts.path), { recursive: true });
  }
  const raw = new DatabaseSync(opts.path, { readOnly: opts.readonly ?? false });

  // WAL keeps readers from blocking the single writer; foreign keys are off by
  // default in SQLite and we rely on them for cascade deletes.
  if (!opts.readonly) {
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
  }
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  let depth = 0;

  const db: Db = {
    get schemaVersion() {
      return currentVersion(raw);
    },
    path: opts.path,
    query<T>(sql: string, params: SqlValue[] = []): T[] {
      return raw
        .prepare(sql)
        .all(...params)
        .map((r) => plain<T>(r));
    },
    one<T>(sql: string, params: SqlValue[] = []): T | null {
      const row = raw.prepare(sql).get(...params);
      return row === undefined ? null : plain<T>(row);
    },
    run(sql: string, params: SqlValue[] = []) {
      const res = raw.prepare(sql).run(...params);
      return { changes: Number(res.changes) };
    },
    /** Reentrant: nested calls join the outer transaction. */
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* rollback of an already-aborted transaction is not an error here */
        }
        throw err;
      } finally {
        depth--;
      }
    },
    close() {
      raw.close();
    },
  };

  if (!opts.skipMigrate && !opts.readonly) migrate(raw);
  return db;
}

function currentVersion(raw: DatabaseSync): number {
  const row = raw.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** Applies every migration above the stored `user_version`, one transaction each. */
export function migrate(raw: DatabaseSync): { from: number; to: number; applied: string[] } {
  const from = currentVersion(raw);
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    raw.exec('BEGIN');
    try {
      for (const stmt of m.statements) raw.exec(stmt);
      raw.exec(`PRAGMA user_version = ${m.version}`);
      raw.exec('COMMIT');
      applied.push(`${m.version}:${m.name}`);
    } catch (err) {
      raw.exec('ROLLBACK');
      throw new Error(
        `migration ${m.version} (${m.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { from, to: currentVersion(raw), applied };
}

export function pendingMigrations(db: Db): number[] {
  return MIGRATIONS.filter((m) => m.version > db.schemaVersion).map((m) => m.version);
}

export { LATEST_SCHEMA_VERSION };
