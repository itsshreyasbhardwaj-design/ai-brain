# Contributing to AI BRAIN

Thanks for looking. This file is short on purpose: the setup is genuinely two
commands, and there is only one rule that matters in review.

## Setup

```bash
pnpm install
pnpm setup      # writes .env with a generated APP_SECRET, creates the database
pnpm dev        # http://localhost:3000
```

Requires **Node 22.6+** (24 recommended) and **pnpm 10+**. Nothing else — no
database server, no Docker, no API key.

## The commands

```bash
pnpm test          # the whole suite (unit, integration, privacy, end-to-end)
pnpm test:perf     # performance tests, which print measured numbers
pnpm typecheck     # core, CLI and MCP server
pnpm lint          # project invariants: no committed secrets, no stray debugging
pnpm build         # production build of the web app
pnpm verify        # all of the above, in the order CI runs them
```

Tests run on Node's own test runner against TypeScript source directly — there is
no build step and no transpiler in the test path.

## The one rule

**Nothing may claim to know what it has not observed.**

Most review comments on this project come back to that. In practice:

- A value derived from records is `origin: 'derived'`. A value a model wrote is
  `origin: 'generated'` and is never treated as a fact.
- An empty result renders an empty state with a **reason** and an **action**, not
  a zero. `0` means "I measured zero"; it does not mean "I have no data".
- A heuristic that could be wrong is surfaced as a question, with its reasoning
  attached, not as a conclusion.
- If you cannot test a claim, put it on the roadmap instead of in the README.

If a change makes the product look more capable without being more capable, it
will be sent back, however good the code is.

## Where things live

```
packages/core/src/domain/      the data model
packages/core/src/db/          migrations, client, repositories
packages/core/src/engines/     discovery, knowledge, resources, review, assistant
packages/core/src/connectors/  adapters and the sync runner
packages/core/src/security/    passwords, encryption, redaction, prompt guard
packages/core/src/ai/          provider adapters, budget ledger, context packages
packages/core/test/            the suite
apps/web/src/app/              pages (Server Components by default)
apps/web/src/lib/actions.ts    every mutation in the app
tools/                         CLI and MCP server
```

`packages/core` **must stay at zero runtime dependencies.** That is what makes
the install trivial and the audit surface small. If you need a utility, write the
forty lines — there is already a validator and a glob matcher in there that exist
for exactly this reason.

## Good first contributions

**A new connector.** The interface is two methods, and `local-directory.ts` is a
complete worked example that does not need network access. See
[`docs/connectors.md`](docs/connectors.md).

**A new dashboard widget.** Add it to `WIDGET_CATALOG` in `engines/profiles.ts`
and give it a case in `engines/dashboard.ts`. The only requirement is that it has
a real empty state.

**A Postgres adapter.** The `Db` interface in `db/client.ts` is four methods. The
SQL is already a portable subset; the FTS5-specific parts are isolated in
migration 2 with a documented `tsvector` equivalent.

**An assistant intent.** Add it to `INTENTS` in `engines/assistant.ts`. A test
asserts that every question listed in `capabilities()` resolves to a real intent
rather than falling through to search, so add it to both.

## Pull requests

- One concern per PR.
- Add a test for behaviour you change. The suite is fast; there is no excuse.
- `pnpm verify` must pass.
- Say in the description what you verified by running, and what you did not.
  "I could not test the Docker path" is a perfectly good sentence and much better
  than silence.

## Commits

Plain imperative subject lines. No required prefix, no changelog ceremony —
`CHANGELOG.md` is updated at release time.

## Code of conduct

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) applies everywhere in this project.

## Security

Do not open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).
