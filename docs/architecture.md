# Architecture

## The shape of it

```
                        ┌──────────────────────────┐
   browser ────────────▶│  apps/web (Next.js 15)   │
                        │  Server Components +     │
                        │  Server Actions          │
                        └───────────┬──────────────┘
                                    │
   MCP client ──stdio──▶ tools/mcp-server ──┐
                                            │
   terminal ──────────▶ tools/cli ──────────┤
                                            ▼
                        ┌──────────────────────────────────────┐
                        │  packages/core                       │
                        │                                      │
                        │  engines/     discovery, knowledge,  │
                        │               resources, review,     │
                        │               assistant, passport    │
                        │  connectors/  adapters + sync runner │
                        │  ai/          providers, ledger      │
                        │  security/    crypto, redaction      │
                        │  db/          repositories           │
                        └───────────────┬──────────────────────┘
                                        ▼
                               node:sqlite  →  ./data/brain.db
```

Three clients, one core, one file. The web app, the CLI and the MCP server all go
through the same engines, which is why `brain ask` and the Assistant page give
identical answers.

## Why these choices

### `node:sqlite` instead of Postgres

The brief asked for Postgres. This release ships SQLite, and that is a deliberate
trade rather than a shortcut.

The promise is a one-command install. A Postgres dependency makes that
"install Docker, start a container, wait for it to be healthy, run migrations" —
which is the step where people give up on self-hosted software. `node:sqlite`
ships inside Node itself, so there is no server, no native build step, no
connection pool and no `docker compose` prerequisite. It also gives FTS5, which
is where full-text search comes from.

What it costs: one writer at a time, and no network access to the database. For a
single-user personal system, neither matters. For a shared team deployment, both
would, which is why Postgres is on the roadmap and the `Db` interface is four
methods wide so an adapter can slot in underneath.

### Zero runtime dependencies in the core

`packages/core` imports nothing outside the Node standard library. The validation
layer is ninety lines, the glob matcher is twelve, the HTTP client with retry and
rate-limit handling is a hundred and forty.

This is not minimalism for its own sake. A personal data system's audit surface
is its dependency tree; keeping the part that touches your records at zero
dependencies means a reader can actually review it, and `pnpm install` cannot
break on a transitive package.

### Server Actions instead of an API layer

Every mutation is a Server Action in `apps/web/src/lib/actions.ts`. They are real
`<form>` posts, so the application works with JavaScript disabled, and there is
no second validation layer to drift from the first.

Route handlers exist only where something external has to reach in: the webhook
receiver, the agent event ingest, data export, and health.

## The data model

Read [`packages/core/src/domain/types.ts`](../packages/core/src/domain/types.ts)
first. The load-bearing idea:

```ts
export type Origin = 'manual' | 'connector' | 'import' | 'derived' | 'generated';
export type Confidence = 'observed' | 'high' | 'medium' | 'low' | 'unverified';
```

Every record carries both. This is a type, not a convention, so a new engine
cannot forget to say where its output came from — and `'generated'` is visibly
different from `'observed'` at every layer from the database to the badge in the
interface.

### Records

`User`, `Workspace`, `BrainConfiguration`, `Module`, `Project`,
`ProjectRelationship`, `Goal`, `Task`, `Decision`, `KnowledgeRecord`,
`SourceRecord`, `Evidence`, `ActivityEvent`, `Resource`, `Metric`, `TimeEntry`,
`ConnectedAccount`, `SyncRun`, `ImportBatch`, `Report`, `AuditLog`, `Session`,
`AccessToken`.

`SourceRecord` is the one that makes the rest honest: it is the raw observation a
connector made, and `Evidence` ties a claim back to it. Without those two, a
project's "last activity" would be a number with no provenance.

## The engines

| Engine | What it decides | The interesting part |
|---|---|---|
| `discovery` | Is this a project? Is it one I already have? | Four matching rules, ordered by trustworthiness. Rule 4 (name similarity) is capped below the merge threshold so it can never decide alone. |
| `passport` | What is known about this project? | Sections vary by category; an empty section reports `lastVerifiedAt: null` rather than a zero. |
| `knowledge` | What class is this? Does it contradict something? | Rule-based classification. Contradiction detection is scoped to polarity reversal on a matching subject — a false contradiction is worse than a missed one. |
| `resources` | Where did time and money go? | Returns `hasData: false` rather than zeros. Anomalies need four items for a baseline. |
| `review` | How is the system itself doing? | Four Cs, each reporting what it could *not* measure. |
| `assistant` | What is the answer? | Intent matching over records. No model. Every answer carries citations and a certainty label. |

## The sync pipeline

```
connector.fetch()
   ↓  SourcePayload[], ProjectCandidate[], ActivityPayload[], MetricPayload[]
SyncRunner.apply()           ← one transaction
   ↓
   1. upsert source records          (idempotent by external id + payload hash)
   2. candidates → DiscoveryEngine   (created / updated / queued / unchanged)
   3. activity   → attach to project (deduplicated by source + kind + time)
   4. metrics    → record if changed (identical values are not re-stored)
   5. documents  → KnowledgeEngine   (redacted, hashed, classified)
   ↓
SyncRun with real counters
```

A connector never writes to the database, never decides whether a project is new,
and never reads outside its allowlist. That separation is what keeps the privacy
rules in one place and makes a new connector a contained piece of work.

Running the same sync twice over unchanged data writes nothing, and the stats say
so — which is what makes the freshness display on the integrations page mean
something.

## Request flow

**Page load:** Server Component → `requireContext()` resolves the session cookie
and workspace → engine call → render. No client-side data fetching.

**Mutation:** `<form action={serverAction}>` → validate with core validators →
engine call → `revalidatePath` → re-render.

**MCP:** stdio JSON-RPC → scope check against the token → engine call → JSON.

All three paths resolve the workspace from a credential, never from a
client-supplied value.

## Testing

```
packages/core/test/
  onboarding.test.ts   personalization, config portability, versioning
  discovery.test.ts    identity, deduplication, relationships, passports
  knowledge.test.ts    classification, import, search, contradictions
  resources.test.ts    time, cost, allocation, reviews, dashboard, assistant
  integration.test.ts  GitHub (mocked HTTP), sync, webhooks, agent events
  privacy.test.ts      isolation, crypto, redaction, injection, deletion
  e2e-tools.test.ts    the MCP server and CLI as real spawned processes
  perf.test.ts         measured numbers at realistic scale
```

Node's own test runner, running TypeScript directly. No build step, no mocking
framework, no transpiler in the test path.

The end-to-end tests spawn the real binaries and speak the real protocols, which
is the only way to know the MCP server actually works.
