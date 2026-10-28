# AI BRAIN

**An open-source, local-first personal intelligence operating system.**

AI BRAIN finds the projects you are really working on, keeps the context you have
already written down, and tells you where your time and money are going — from
evidence, not guesses. It runs on your machine, stores everything in one file you
own, and works with no API keys and no paid services.

```bash
git clone https://github.com/itsshreyasbhardwaj-design/ai-brain.git
cd ai-brain
pnpm install
pnpm setup      # writes .env with a generated APP_SECRET, creates the database
pnpm dev        # http://localhost:3000
```

That is the whole install. No database server, no Docker requirement, no account
anywhere, no API key.

---

## What it does

|                               |                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Finds your projects**       | Point it at GitHub or a folder of code and it works out what is a project, what is a rename of something you already have, and what it is not sure about. Ambiguous matches wait for you. |
| **Keeps your context**        | Import Markdown, text or an official ChatGPT/Claude export. Full-text search, five knowledge classes, duplicate and contradiction detection.                                              |
| **Tracks your resources**     | Recorded time and cost per project, plus a verdict on which projects are advancing and which are consuming money without moving.                                                          |
| **Reviews honestly**          | Daily to quarterly reviews over what actually happened, with the gaps in your own data stated plainly.                                                                                    |
| **Answers questions**         | A grounded assistant that cites a source for every claim and says when it does not know. No API key needed.                                                                               |
| **Serves other assistants**   | An authenticated MCP server so Claude Code and other MCP clients can read your brain — read-only unless you grant a write scope.                                                          |
| **Shows you the shape of it** | A 3D universe of your real projects and their real relationships, with a complete 2D equivalent.                                                                                          |

## The one rule

**Nothing claims to know what it has not observed.**

That sounds like a slogan, so here is what it actually means in the code:

- Every record carries an **origin** (`manual`, `connector`, `import`, `derived`,
  `generated`) and a **confidence**. The interface shows both, always.
- A panel with no data shows **why it is empty and what would fill it** — never a
  zero that looks like a measurement.
- Time spent with an app open is **never** counted as work. Only time you logged.
- A cost anomaly is not reported until there are **at least four** recurring costs
  to form a baseline; below that the report says so.
- A project is never merged into another on **name similarity alone**. That rule is
  capped below the merge threshold on purpose, and
  [a test enforces it](packages/core/test/discovery.test.ts).
- A model may only **rephrase** an answer the system already computed. It is never
  asked what is true, and its output is stored as `generated` if stored at all.

## Verified behaviour

These numbers come from `pnpm test` on the committed code, not from estimates:

```
tests 251  pass 251  fail 0
```

Measured on an Apple M-series laptop with 300 projects, 3,000 knowledge records
and 6,500 activity events in one workspace:

| Operation                               | Time   |
| --------------------------------------- | ------ |
| Full-text search                        | 2.7 ms |
| Multi-term search                       | 3.7 ms |
| List 300 projects                       | 3.1 ms |
| Dashboard render (10 widgets)           | 188 ms |
| Allocation across 300 projects          | 133 ms |
| Weekly review                           | 209 ms |
| Assistant answer                        | 24 ms  |
| Discovery against 300 existing projects | 9.0 ms |

Run them yourself with `pnpm test:perf`.

## Architecture

```
apps/web            Next.js 15 app: landing, onboarding, dashboard, 3D universe
packages/core       Domain model, storage, engines  ← zero runtime dependencies
tools/mcp-server    MCP server over stdio           ← zero dependencies
tools/cli           The `brain` command             ← zero dependencies
```

**`packages/core` has no runtime dependencies at all.** Storage is `node:sqlite`,
which ships inside Node; crypto is `node:crypto`. There is no ORM, no HTTP
framework and no validation library in the core, which is why the whole thing
installs in seconds and runs with nothing else set up.

Reading order, if you want to understand it:

1. [`packages/core/src/domain/types.ts`](packages/core/src/domain/types.ts) — the data model, and why provenance is a type and not a convention
2. [`packages/core/src/engines/discovery.ts`](packages/core/src/engines/discovery.ts) — how a project is identified, and why rule 4 can never decide alone
3. [`packages/core/src/engines/resources.ts`](packages/core/src/engines/resources.ts) — what gets measured and what is refused
4. [`docs/architecture.md`](docs/architecture.md) — the whole picture

### Storage

SQLite via `node:sqlite`, with FTS5 for search and WAL for concurrency. One file,
`./data/brain.db`. Back it up by copying it.

PostgreSQL is **on the roadmap, not in this release**. The SQL is written in a
portable subset and the FTS5-specific parts are isolated in one migration with a
documented `tsvector` equivalent, but no Postgres adapter is shipped or tested,
so the README does not claim one. See [`docs/roadmap.md`](docs/roadmap.md).

## Integrations

Each connector states what it can and cannot do, and those statements are the
same strings the application renders.

| Connector                  | Status       | Mode               | What that means                                                                                                                                               |
| -------------------------- | ------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**                 | supported    | API poll + webhook | Reads only repositories you allowlist, with a read-scope token. Webhooks work but you configure them on the repository.                                       |
| **Local directory**        | supported    | filesystem         | Reads only directories you authorize. Never descends into `node_modules`, `.git`, `.ssh`, or files matching the secret denylist.                              |
| **Markdown / text import** | supported    | manual             | You upload the files. There is no live connection to a notes app.                                                                                             |
| **AI conversation import** | supported    | manual             | Works from the official ChatGPT or Claude data export. Neither product offers account-wide chat access to third-party apps, so this is an import, not a sync. |
| **Claude Code**            | experimental | receiver           | Receives events from a hook _you_ install in your own settings. AI BRAIN never writes to your config files.                                                   |
| **OpenAI Codex**           | experimental | receiver           | Receives events from a wrapper you run. There is no documented interface for reading Codex activity, so this cannot poll.                                     |

**Not in this release:** GitLab, Vercel, Supabase, Notion, Google Drive, Linear,
Jira. They are listed in the app and in [`docs/roadmap.md`](docs/roadmap.md) so you
know they are missing rather than broken. The adapter interface is documented in
[`docs/connectors.md`](docs/connectors.md) if you want to add one.

## AI providers

**The default is no provider.** A fresh installation makes zero network calls and
costs zero. Every feature works; explanations are rule-based.

If you want prose instead of structured output:

| Provider            | Cost | Notes                                               |
| ------------------- | ---- | --------------------------------------------------- |
| `none`              | free | The default.                                        |
| `ollama`            | free | A local model. No key, no network beyond localhost. |
| `anthropic`         | paid | Requires an explicit budget.                        |
| `openai-compatible` | paid | Any `/v1/chat/completions` endpoint.                |

Three guarantees, each with a test:

1. **An API key alone does not authorize spending.** `AI_MONTHLY_BUDGET_MINOR` must
   also be set to a non-zero value, or paid calls are refused.
2. **The budget is checked before the request, not after.** A call estimated to
   exceed the remaining budget never leaves the machine.
3. **A provider can only rephrase.** The system prompt says the computed answer is
   authoritative, untrusted material is fenced in `<untrusted-data>` blocks, and
   prompt-injection signals are detected and surfaced.

## Privacy and security

- **Workspace isolation** is enforced in the repository layer: there is no method
  that can return another workspace's rows, and the tests assert it.
- **Secrets are stripped before storage.** Imported text is scanned for API keys,
  tokens, private keys and connection strings, locally, before anything is written.
- **Connector credentials** are encrypted with AES-256-GCM. Revoking a connection
  destroys the credential.
- **Passwords** use scrypt from `node:crypto` — no native dependency.
- **Access tokens** are stored only as a SHA-256 hash and are scoped per capability.
- **Webhooks** verify HMAC-SHA256 signatures and fail closed with no secret set.
- **Prompt injection** is detected, fenced and reported rather than silently passed
  to a model.
- **No telemetry.** There is no analytics code in this repository.

Full detail in [`docs/privacy.md`](docs/privacy.md) and [`SECURITY.md`](SECURITY.md).

## Using it from Claude Code (or any MCP client)

Issue a scoped token in **Settings → Access tokens**, then:

```json
{
  "mcpServers": {
    "ai-brain": {
      "command": "node",
      "args": ["tools/mcp-server/src/index.ts"],
      "env": { "AI_BRAIN_DB": "./data/brain.db", "AI_BRAIN_TOKEN": "aib_…" }
    }
  }
}
```

Sixteen tools, each gated on a scope. The only write tool is `propose_update`,
which records a suggestion for you to accept — an assistant cannot change your
records. See [`docs/mcp.md`](docs/mcp.md).

## Command line

```bash
pnpm brain status                       # what your brain contains, and its gaps
pnpm brain connect github --token ghp_… --allow owner/repo
pnpm brain sync                         # discover projects
pnpm brain review-queue                 # what is waiting for you
pnpm brain ask "where can I reduce costs?"
pnpm brain export --out backup.json     # everything, no credentials
```

`pnpm brain help` lists the rest.

## Self-hosting

```bash
cp .env.example .env     # set APP_SECRET
docker compose up --build
```

**Verification note:** the Docker path is written against the documented API but
**has not been run on the machine this was built on**, which has no Docker
installed. The `pnpm install && pnpm dev` path, the production `pnpm build`, the
full test suite, the CLI and the MCP server were all executed and verified. See
[`docs/self-hosting.md`](docs/self-hosting.md) for what was and was not checked.

## Requirements

- **Node 22.6 or newer** (24+ recommended). `node:sqlite` and TypeScript type
  stripping both need a recent runtime.
- **pnpm 10 or newer.**
- Nothing else.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers the setup, the test commands, and the
one rule above — which is the thing most likely to come up in review.

Good first areas: a new connector (the interface is small and documented), a new
dashboard widget, or a Postgres adapter behind the existing `Db` interface.

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md). The short version: Postgres, more
connectors, scheduled reviews, semantic search via pgvector, and a reviewed module
marketplace. Nothing on that list is implied to exist today.

## License

[Apache-2.0](LICENSE).
