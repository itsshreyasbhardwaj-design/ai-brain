# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-28

First public release. Everything below was built and verified; see
`docs/verification.md` for what was executed and what was not.

### Added

**Core**
- Canonical data model with provenance (`origin`, `confidence`) on every record
- SQLite storage via `node:sqlite` with FTS5 search and WAL, zero dependencies
- Three forward-only migrations, applied automatically on open

**Personalization**
- Deterministic brain generator: the same answers always produce the same
  configuration, with no model call
- Eight operating profiles over one shared modular architecture
- Versioned `brain.config.json` export and import; editing writes a new version
  and keeps the old ones

**Project intelligence**
- Universal discovery engine with stable-identifier matching, alias tracking,
  rename handling, fork and monorepo relationships, and confidence scoring
- Review queue for anything ambiguous; name similarity alone can never merge
- Modular Project Passports with per-section provenance and completeness

**Knowledge**
- Markdown, text and official AI conversation export import
- Rule-based classification into five classes, duplicate detection by content
  hash, and contradiction detection on polarity reversal
- Full-text search with filters, snippets and graceful degradation

**Resources**
- Time, cost and tool intelligence from recorded figures only
- Project allocation verdicts with the rules that produced them
- Overcommitment warnings, cost anomalies with a stated baseline rule, and
  overlap detection offered as a question

**Reviews and assistant**
- Four Cs assessment (Context, Connections, Capabilities, Cadence)
- Daily to quarterly reviews over verified records
- Grounded assistant answering 11 documented questions with citations and an
  explicit certainty label, with no AI provider required

**Connectors**
- GitHub: allowlisted polling with incremental cursors, rate-limit handling,
  retry with backoff, and signed webhooks
- Local directory: bounded scanning with a secret denylist and monorepo detection
- Claude Code and Codex: authenticated event receivers with snippets you install
- Markdown and conversation import

**Interfaces**
- Next.js 15 web app with the Obsidian Intelligence design system, light and dark
  themes, keyboard navigation and a command palette
- 3D intelligence universe on three.js with a complete 2D equivalent
- MCP server with 16 scoped tools over stdio, zero dependencies
- `brain` CLI covering setup, sync, review, search, export and tokens

**Security and privacy**
- scrypt passwords, AES-256-GCM credential encryption, hashed access tokens
- Local secret redaction before storage, prompt-injection detection and fencing
- Workspace isolation enforced in the repository layer
- Full export, selective source deletion, workspace and account deletion
- AI spend ledger with a budget checked before each request

### Known limitations
- PostgreSQL is not implemented; SQLite is the only tested backend
- The Docker path is written but was not executed during development
- Scheduled reviews are manual; no scheduler is shipped
- Semantic search, the module marketplace and community templates are roadmap
