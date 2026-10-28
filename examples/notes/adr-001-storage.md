---
title: Use node:sqlite for storage
tags: [architecture, storage, adr]
---

# Use node:sqlite for storage

We decided to use the SQLite build that ships inside Node rather than running
Postgres. There is no server to install, FTS5 gives us full-text search for
free, and the core package stays at zero runtime dependencies.

Rejected: Postgres, because it makes the install a multi-step process.
Rejected: better-sqlite3, because it needs a native build on every platform.
