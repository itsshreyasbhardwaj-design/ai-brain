# 0004 — A model may only rephrase a computed answer

**Status:** Accepted · **Date:** 2026-10-28

## Context

The brief asks for an AI assistant that answers questions about the user's data,
with source references and uncertainty labels, that works without any AI API key,
and that never confuses generated text with verified information.

The conventional approach — retrieval-augmented generation — does not satisfy
all four. RAG requires a model, so it cannot work without a key; and a model that
composes the answer can always compose a claim the records do not support,
however good the prompt is.

## Decision

The assistant retrieves and computes. An intent is matched from the question, the
relevant records are read, and the answer is assembled from them with a citation
per claim and an explicit certainty label.

A configured AI provider may only **rephrase** an answer the engine already
produced. It is never asked what is true.

## Consequences

**What this buys**

- The assistant works with no API key, no network and no cost. That is the
  default configuration, and it is what every test runs under.
- Every answer has citations, because they are built from the records that
  produced it rather than reconstructed afterwards.
- "I do not know" is a real answer the engine returns, not a behaviour hoped for
  from a prompt.
- A compromised or hallucinating provider cannot change what the answer says
  about the user's data — only how it reads.

**What it costs**

- The assistant answers the questions it has intents for. There are eleven, each
  documented and tested; anything else falls back to search over the knowledge
  base and says so.
- It cannot synthesise across records in a way nobody wrote a rule for.
- Adding a question means writing code, not writing a prompt.

**How the limit is kept honest**

`capabilities()` lists every question the assistant claims to answer, and a test
asserts that each one resolves to a real intent rather than falling through to
search. The list in the product and the list in the code cannot drift.

## Rejected alternatives

**RAG over embeddings.** Needs a model for the default path, which breaks the
no-key promise, and lets the model decide what the records mean.

**A model with tool access to the database.** More capable and much harder to
constrain. The failure mode — a confident wrong answer about the user's own
money — is exactly what this product exists to avoid.
