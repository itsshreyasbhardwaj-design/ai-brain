# 0002 — Zero runtime dependencies in the core

**Status:** Accepted · **Date:** 2026-10-28

## Context

The brief suggested Zod for validation and a conventional backend stack. The
product is a personal data system: its users are trusting it with their
projects, notes, costs and credentials.

For that kind of software, the dependency tree *is* the audit surface. A reader
who wants to check that their notes are not leaving the machine has to be able to
read what touches them.

## Decision

`packages/core`, `tools/cli` and `tools/mcp-server` import nothing outside the
Node standard library. `apps/web` has the five dependencies a web app genuinely
needs (Next, React, React DOM, three.js, Tailwind).

## Consequences

**What this buys**

- The part that touches user records can be read end to end.
- `pnpm install` cannot break on a transitive package.
- The MCP server and CLI are single-file-ish tools that run anywhere Node runs.
- No supply-chain surface on the data path.

**What it costs**

Things had to be written that would otherwise be a dependency:

| Instead of | There is | Lines |
|---|---|---|
| Zod | `util/validate.ts` | ~130 |
| A glob library | `globMatch` in `security/redact.ts` | ~12 |
| An HTTP client with retry | `connectors/http.ts` | ~140 |
| bcrypt / argon2 | `security/password.ts` on scrypt | ~35 |
| An MCP SDK | JSON-RPC over stdio in the server | ~60 |

That is roughly 380 lines that now need maintaining. They are all narrow — the
validator supports exactly the shapes the API accepts and nothing more.

**Where the line is**

The web app is allowed dependencies, because writing a React renderer is not a
reasonable response to this principle. The boundary is the data path: anything
that reads or writes a user's records stays dependency-free.

## Rejected alternatives

**Zod everywhere.** It is a good library. But validation is where untrusted input
meets the system, and ninety lines that can be read in full is worth more here
than a general-purpose schema language.

**An MCP SDK.** The wire format is newline-delimited JSON-RPC 2.0. Implementing
it is a few dozen lines and removes a dependency from a tool people will run
against their own data.
