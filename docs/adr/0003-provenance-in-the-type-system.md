# 0003 — Provenance is a type, not a convention

**Status:** Accepted · **Date:** 2026-10-28

## Context

The product's central claim is that it never presents something it has not
observed. That is easy to state and easy to erode: one engine returns a
plausible-looking number without a source, one widget renders a zero instead of
an empty state, and within a few releases the product is guessing again.

Conventions do not survive contact with a growing codebase. Types do.

## Decision

Every record carries two fields, in the database and in TypeScript:

```ts
export type Origin = 'manual' | 'connector' | 'import' | 'derived' | 'generated';
export type Confidence = 'observed' | 'high' | 'medium' | 'low' | 'unverified';
```

Dashboard widgets return either rows or an explicit empty state:

```ts
empty?: { reason: string; action: string; href?: string };
```

Passport sections carry `lastVerifiedAt: Iso | null`, where `null` means nothing
has ever populated that section.

## Consequences

**What this buys**

- A new engine cannot forget to say where its output came from; the type will not
  compile without it.
- The interface can render provenance mechanically, so there is no way to show a
  number without showing how it is known.
- `'generated'` is visibly distinct from `'observed'` at every layer, which is
  what keeps model output from quietly becoming fact.
- The contract is testable, and it is tested: the dashboard test walks every
  widget on a fresh workspace and asserts that each empty one carries a reason
  and an action.

**What it costs**

- Two extra columns on most tables, and two extra fields to pass in every
  constructor.
- Some verbosity at call sites.
- Occasional genuine difficulty deciding between `'derived'` and `'generated'`.
  The rule used throughout: if a fixed rule produced it, `'derived'`; if a model
  produced it, `'generated'`.

## Rejected alternatives

**A linter rule or a code review checklist.** Both fail in the same way — the
moment someone is in a hurry, there is nothing structural stopping them.

**Nullable values to mean "unknown".** `null` conflates "not measured", "measured
as nothing" and "not applicable". The empty state needs a reason and an action to
be useful, and a null cannot carry either.
