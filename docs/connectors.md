# Writing a connector

A connector turns an authorized source into records. It is two methods, and it
never touches the database.

## The interface

```ts
export interface ConnectorAdapter {
  key: ConnectorKey;
  verify(ctx: ConnectorContext): Promise<{ ok: boolean; accountLabel: string; scopes: string[]; error?: string }>;
  fetch(ctx: ConnectorContext): Promise<FetchResult>;
}
```

`verify` confirms the credential works and reports who it belongs to. It runs
when the user connects the account, before anything is stored, so a bad token
produces a clear error instead of a mysterious empty sync.

`fetch` does one incremental pass and returns what it saw.

## What a connector must not do

- **Write to the database.** Return payloads; the sync runner persists them.
- **Decide whether a project is new.** Emit a `ProjectCandidate` with a stable
  `externalId`; the discovery engine decides.
- **Read outside `ctx.allowlist`.** Count anything you skip in `skippedByPrivacy`
  so the user can see it was skipped rather than missed.
- **Invent a `sourceId`.** Leave it `null`. The runner fills it in once the source
  row exists.

These are not style rules. They are what keeps the privacy logic in one place
and makes a connector reviewable on its own.

## What it returns

```ts
export interface FetchResult {
  sources: SourcePayload[];        // raw observations, for provenance
  candidates: ProjectCandidate[];  // things that might be projects
  activity: ActivityPayload[];     // events, attached by project source key
  metrics: MetricPayload[];        // numbers, recorded only when they change
  documents: IngestDocument[];     // text for the knowledge base
  cursor: string | null;           // persist for the next incremental run
  hasMore: boolean;                // more remains; schedule another page
  warnings: string[];              // non-fatal problems; run finishes 'partial'
  skippedByPrivacy: number;
  rateLimitWaits: number;
  retries: number;
}
```

## The identifier rule

`ProjectCandidate.externalId` must be **stable across renames**. GitHub's
`node_id` is; `full_name` is not. If you use a name as the identifier, a rename
produces a duplicate project, which is the single worst failure mode this system
has.

If your source has no stable id, say so in `limitations` and set
`connectorConfidence` low enough that everything lands in the review queue.

## Confidence

`connectorConfidence` (0–1) is your honest assessment that this is a real
project the user cares about. The discovery engine adjusts it — up for a
description or recent activity, down for noise-shaped names and ambiguous
matches — and compares the result to the auto-register threshold (0.75).

Reference points from the shipped connectors:

| Signal | Confidence |
|---|---|
| A repository you own, with a description | 0.90 |
| A directory with a `.git` | 0.90 |
| A directory with two or more project markers | 0.82 |
| A repository you own, no description | 0.82 |
| A directory with a single marker | 0.68 |
| A directory an agent happened to run in | 0.60 |
| A fork | 0.55 |

When in doubt, go lower. The review queue is cheap; a wrong merge is not.

## Declaring what you cannot do

Add an entry to `CONNECTORS` in `connectors/registry.ts`:

```ts
gitlab: {
  key: 'gitlab',
  label: 'GitLab',
  capabilities: ['discover', 'activity'],
  mode: 'api-poll',
  limitations:
    'Reads only projects you allowlist, with a read_api token. Merge request ' +
    'detail is fetched for the 25 most recently active projects per run to ' +
    'stay inside the rate limit; the rest are covered on later syncs.',
  status: 'experimental',
},
```

`limitations` is rendered verbatim in the product. Write it for the user, and
write the honest version — a test asserts that manual-export connectors say they
are not live, and that the conversation connector does not claim account-wide
chat access.

## HTTP

Use `HttpClient` from `connectors/http.ts`. It handles retry with exponential
backoff and jitter, rate-limit headers (`retry-after`, `x-ratelimit-reset`), a
ceiling on total wait, and `Link` header pagination. It never throws; it returns
a result with an `error` string, so a sync degrades to `partial` rather than
dying.

## Budgeting

A user with 300 repositories should not spend their whole rate limit on one sync.
The GitHub connector fetches detail for the 25 most recently active repositories
and **says so in `warnings`**:

> Commit and CI detail was fetched for the 25 most recently active of 300
> repositories, to stay inside the API rate limit. The rest will be covered on
> later syncs.

Silently truncating would be the bug. Truncating and saying so is the feature.

## Testing

`mockFetch` in `test/helpers.ts` replays scripted responses and records the URLs
called, so a connector test runs offline. Cover at minimum:

- a successful fetch producing the right shapes
- the allowlist excluding something, with `skippedByPrivacy` incremented
- the cursor short-circuiting an unchanged source
- a 500 and a 429, which the client should retry and survive
- a hard failure surfacing as a warning rather than an exception

## Registering it

```ts
// connectors/sync.ts
export const ADAPTERS: Partial<Record<ConnectorKey, ConnectorAdapter>> = {
  github: new GitHubConnector(),
  'local-directory': new LocalDirectoryConnector(),
  gitlab: new GitLabConnector(),   // ← yours
};
```

Add `'gitlab'` to `ConnectorKey` in `domain/types.ts`, and a connect form in
`apps/web/src/app/(app)/integrations/page.tsx`. That is the whole integration.
