# Verification

What was actually executed during development, and what was not. This exists so
nothing in the README has to be taken on trust.

Environment: macOS (Darwin 25.6, Apple Silicon), Node 24.16.0, pnpm 11.17.0.

## Executed and passing

### Automated suite

```
$ pnpm test
ℹ tests 251
ℹ suites 42
ℹ pass 251
ℹ fail 0
ℹ duration_ms 9195
```

| File | Tests | Covers |
|---|---|---|
| `onboarding.test.ts` | 21 | Brain generation determinism, all eight profiles, module inference from free text, minor-account protections, config round-trip, version history |
| `discovery.test.ts` | 24 | Stable-id matching, idempotent re-ingest, renames, manual-project adoption, cross-connector linking, similarity never merging alone, rejection persistence, monorepo and fork relationships, merging, passports |
| `knowledge.test.ts` | 28 | Classification, Markdown and front-matter parsing, redaction before storage, duplicate detection, FTS search and reindexing, contradiction detection, conversation export parsing |
| `resources.test.ts` | 37 | Time and cost reporting with no-data states, anomaly baselines, tool inventory, allocation verdicts, Four Cs, reviews, dashboard empty-state contract, assistant answers and citations |
| `integration.test.ts` | 46 | GitHub verify/fetch/allowlist/cursor/budget, HTTP retry and rate limiting, sync idempotency, rename handling, failure and recovery, webhook signatures, agent events, portability round-trip |
| `privacy.test.ts` | 49 | Workspace isolation across every repository, password and credential crypto, token scoping and revocation, secret redaction, path denylist, prompt-injection detection, provider budget gates, deletion and retention, audit log |
| `e2e-tools.test.ts` | 33 | The MCP server and CLI as **real spawned processes** against a real database file |
| `perf.test.ts` | 13 | Measured performance at realistic scale |

### Static checks

```
$ pnpm lint
lint: 93 file(s) checked, no problems.

$ pnpm typecheck      # core, CLI, MCP server — clean
$ cd apps/web && npx tsc --noEmit   # web app — clean
```

### Production build

```
$ pnpm build
✓ Generating static pages (25/25)
```

25 routes compile. First Load JS is 102 kB shared; the heaviest page is the
universe at 110 kB, with three.js loaded dynamically so other pages do not pay
for it.

### The MCP server, as a real process

`e2e-tools.test.ts` spawns `tools/mcp-server/src/index.ts` and speaks JSON-RPC
over stdio. Verified: the `initialize` handshake and its instructions, scope-
filtered `tools/list` (a read-only token does not advertise `propose_update`),
refusal to start with an invalid token, every read tool returning real data,
`propose_update` recording an unverified proposal without changing anything,
clean protocol errors for unknown tools and methods, and survival of malformed
input.

### The CLI, as a real process

Same file. Verified: `help`, `status` (human and `--json`), `project add` and
`project list`, `search` with provenance, `ask` including the out-of-scope
refusal, `connectors`, `review` writing a stored report, `resources`,
`token new` (and that the raw token is nowhere in the database), `export`,
`config export`, idempotent `migrate`, and a useful error for an unknown command.

### The browser, by hand

Run against `pnpm dev` with a real database:

- First-run setup → account created → redirected to onboarding
- Empty dashboard: **every** widget showed a reason and an action, no zeros
- Seeded a realistic workspace, then confirmed the dashboard showed real
  priorities, activity, CI health, a pending discovery marked uncertain, and
  rule-based recommendations including the idle-spend case
- Project Passport with per-section provenance and correct empty sections
- 3D universe rendering with no console errors; switching to the List view;
  the unconfirmed project marked in both
- Assistant answering "Where can I reduce costs?" — found the note-taking tool
  overlap and the unconfirmed subscriptions, with citations and caveats, with
  **no AI provider configured**
- Issued an access token through the UI; shown once, listed with scopes
- Mobile viewport (375×812) and the light theme
- Final clean-tab sweep across all pages: **zero console errors**

### Measured performance

300 projects, 3,000 knowledge records, 6,500 activity events, 400 tasks, 120
resources in one workspace:

| Operation | Measured |
|---|---|
| Seed the whole dataset | 306 ms |
| Full-text search | 2.7 ms |
| Multi-term search | 3.7 ms |
| Filtered search | 1.2 ms |
| List 300 projects | 3.1 ms |
| Dashboard (10 widgets) | 188 ms |
| Allocation across 300 projects | 133 ms |
| Project passport | 60 ms |
| Weekly review | 209 ms |
| Assistant answer | 24 ms |
| Discovery against 300 existing projects | 9.0 ms |
| Context package (154 KB) | 963 ms |
| Recent activity from 6,500 events | 0.3 ms |

Reproduce with `pnpm test:perf`.

### Bugs this process caught

Worth recording, because they are the argument for the verification steps that
found them:

| Found by | Bug |
|---|---|
| First test run | A placeholder `sourceId` from a connector violated a foreign key. Discovery now normalises it once, so no caller can create a dangling reference. |
| Discovery test | The deduplication pre-filter only matched exact normalised names, which made the name-similarity rule unreachable — a renamed project would have silently become a duplicate. |
| Discovery test | `ingest` returned a stale project object, so a caller never saw the parent link that `linkRelations` had just written. |
| Knowledge test | `subjectOf` stripped polarity word by word, so "no longer" left "longer" behind and contradiction detection could never match. |
| Assistant test | Three documented questions did not match their own intents (plural forms). A test now asserts every advertised question resolves to a real intent. |
| Redaction test | The GitHub token pattern required 36+ characters and the Google key pattern an exact length, so near-miss keys passed through unredacted. |
| Browser check | The root `.env` never reached Next, whose cwd is `apps/web` — the documented setup silently ran with no `APP_SECRET`. |
| Browser check | A Server Component passed a render function to a Client Component, producing a 500 on the settings page. |
| CI, clean-install job | `brain connectors` required an account to print the connector registry, so someone evaluating the project could not see what the integrations do until after signing up. |
| CI, clean-install job | `brain connectors \| head -5` crashed with an unhandled EPIPE. A command that had done its job looked like it had crashed. |

## Not executed

### Docker

**The machine this was built on has no Docker installed.** `Dockerfile` and
`docker-compose.yml` are written against the documented behaviour of each tool
and reviewed, but `docker compose up --build` has not been run. Both files say so
at the top.

The non-Docker path — `pnpm install && pnpm setup && pnpm dev` — was verified end
to end and is what the README leads with.

### PostgreSQL

Not implemented, so not tested. SQLite is the only backend. See
[`roadmap.md`](roadmap.md).

### A real GitHub account

Every GitHub test runs against a scripted mock of the HTTP layer, covering the
repository list, commits, workflow runs, pagination, 401, 403 with rate-limit
headers, 429, 500 and network failure. The request shapes match the documented
API, but **no request was ever made to github.com** during development, and no
real token was used.

The consequence: a mistake in an endpoint path or a response field name would not
have been caught. The retry, rate-limit, allowlist, cursor and deduplication
logic *is* exercised, because that is where the real complexity is.

### Paid AI providers

No call was made to any paid API, by policy. The Anthropic and OpenAI-compatible
adapters are tested through an injected `fetch`, covering the budget gate, the
pre-request refusal, provider failure falling back to the grounded answer, and
the system prompt's contents. Ollama is tested the same way.

The default — `AI_PROVIDER=none` — is the configuration every other test runs
under, and a test asserts that no provider is contacted by default.

### Cross-platform

Developed and verified on macOS with Node 24. CI runs the suite on Linux with
Node 22 and 24. Windows is untested; it should work through WSL, and plain
Windows is unverified.

### Accessibility

Keyboard navigation, focus rings, ARIA labelling, `prefers-reduced-motion`,
reduced-motion fallbacks for the 3D scene, and a complete 2D alternative were all
built and manually exercised. **No screen-reader testing was done**, and no
automated accessibility audit was run. Treat the accessibility claims as
"designed for, not certified".

### Load and concurrency

The performance numbers above are single-process, single-user measurements. No
concurrent-writer, long-running or memory-leak testing was done. SQLite's
single-writer constraint has not been stress tested, because the target is one
person per installation.
