# Architecture decision records

The decisions that would be expensive to reverse, and why they went the way they
did. Each one states what it costs, because a decision record that only lists
benefits is marketing.

| # | Decision | Status |
|---|---|---|
| [0001](0001-sqlite-over-postgres.md) | SQLite via `node:sqlite` rather than PostgreSQL | Accepted |
| [0002](0002-zero-dependency-core.md) | Zero runtime dependencies in the core | Accepted |
| [0003](0003-provenance-in-the-type-system.md) | Provenance is a type, not a convention | Accepted |
| [0004](0004-models-may-only-rephrase.md) | A model may only rephrase a computed answer | Accepted |
