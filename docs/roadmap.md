# Roadmap

What is **not** in 0.1.0, stated plainly so nothing in the README has to be read
generously.

## Not implemented

### PostgreSQL
SQLite is the only tested backend. The `Db` interface is four methods and the SQL
is a portable subset, with the FTS5-specific parts isolated in migration 2 and a
documented `tsvector` equivalent — but no adapter is shipped and none is tested,
so none is claimed.

### More connectors
GitLab, Vercel, Supabase, Notion, Google Drive, Linear and Jira are listed in the
product as unavailable. The adapter interface is documented in
[`connectors.md`](connectors.md) and a new one is a contained piece of work.

### Scheduled reviews
Reviews are run by you, from the app or the CLI. There is no scheduler, no cron
and no background worker. Wiring `pnpm brain review` to a system cron works
today; shipping a scheduler that claims reliability it does not have does not.

### Semantic search
Full-text search is FTS5 with Porter stemming. Embeddings would need either a
local model or a paid API, and the first is a real dependency while the second
contradicts the zero-cost default. Planned behind pgvector once Postgres exists.

### Module marketplace
Modules are first-party and enabled through configuration. The brief is explicit
that executing arbitrary third-party code needs signing, review and versioning
first, and this release has none of those.

### Community templates
Configuration export and import works today, so sharing a setup is a file. A
gallery needs moderation and hosting, which a local-first project does not have.

### Multi-user teams
The data model has workspaces, members and roles, and isolation is enforced and
tested. But this release targets one person per installation: there are no
invitations, and the isolation has not been audited as a multi-tenant boundary.
Treating it as one would be a mistake.

## Partly implemented

### Webhooks
GitHub webhook receiving works, with signature verification. You configure the
webhook on the repository yourself; the app does not create it for you.

### Agent integrations
Claude Code and Codex are **receivers**, not pollers — neither offers a documented
interface for a third-party application to read your activity. You install a hook
or a wrapper, which the app prints for you to copy. It never edits your config.

### Business intelligence
Metrics can be recorded and are displayed, but nothing imports them from an
accounting or payments system.

## Known limitations

- **One writer at a time.** SQLite with WAL. Not a constraint for one user.
- **In-process rate limiting.** Fine for one process; a multi-instance deployment
  would need something shared.
- **The local-directory connector reads the server's filesystem.** On a remote
  deployment that is the server's disk, not your laptop's.
- **Contradiction detection is narrow.** It catches polarity reversal on a
  matching subject and nothing subtler, because a false contradiction is worse
  than a missed one.
- **Overlap detection matches tool names.** It is offered as a question, never as
  a claim.
- **The Docker path has not been executed.** See [`self-hosting.md`](self-hosting.md).

## Next

Roughly in order:

1. Postgres adapter behind the existing `Db` interface
2. GitLab connector, as the second API connector to prove the interface
3. Optional scheduler for reviews and syncs, opt-in and honest about reliability
4. Notion and Google Drive, which need OAuth apps
5. pgvector semantic search, once Postgres exists
6. Signed, reviewed modules — the prerequisite for anything like a marketplace
