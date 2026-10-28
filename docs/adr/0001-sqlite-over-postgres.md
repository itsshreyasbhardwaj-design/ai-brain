# 0001 — SQLite via `node:sqlite` rather than PostgreSQL

**Status:** Accepted · **Date:** 2026-10-28

## Context

The brief asked for PostgreSQL as the primary production database, with a
lightweight local development mode. It also asked for an install that is
"unusually easy", demonstrated by a short documented command sequence.

Those two requirements pull in opposite directions. A Postgres dependency turns
"clone and run" into "install Docker, start a container, wait for it to be
healthy, run migrations, then run the app" — and that is the step where people
abandon self-hosted software.

## Decision

Ship SQLite through `node:sqlite`, which is part of the Node runtime, as the only
backend in 0.1.0. Do not claim Postgres support.

## Consequences

**What this buys**

- `pnpm install && pnpm dev` is the entire install. No server, no container, no
  native build step, no connection pool.
- FTS5 comes with it, so full-text search needs no extra service.
- The core package keeps zero runtime dependencies, because the driver is the
  runtime.
- One file is the whole backup story.

**What it costs**

- One writer at a time. Irrelevant for one user; disqualifying for a team.
- No network access to the database, so the app and its data must share a host.
- Postgres-specific features — `pgvector` for semantic search in particular —
  are unavailable, which pushes semantic search onto the roadmap.

**How the cost is contained**

The `Db` interface is four methods (`query`, `one`, `run`, `transaction`). The
SQL is written in a portable subset: no SQLite-only column types, no
`AUTOINCREMENT`, identifiers generated in application code. The one genuinely
SQLite-specific piece — the FTS5 virtual table and its triggers — is isolated in
migration 2, with the `tsvector` equivalent noted in a comment.

A Postgres adapter is therefore an additive change rather than a rewrite.

## Rejected alternatives

**Postgres in Docker, required.** Rejected because it breaks the central promise.

**Both from day one.** Rejected because two backends means two tested paths, and
the second would have been tested worse. Shipping one that works beats shipping
two that might.

**`better-sqlite3`.** Rejected because it needs a native build on every platform,
which reintroduces the install friction `node:sqlite` removes.
