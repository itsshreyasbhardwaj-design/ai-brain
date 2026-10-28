# Examples

## Demo data

`seed-demo.mjs` fills a workspace with **clearly fictional** records so you can
see a populated interface without connecting anything.

```bash
node examples/seed-demo.mjs --db ./data/demo.db
AI_BRAIN_DB=./data/demo.db pnpm dev
```

Every record it creates is labelled `[demo]` in its tags, and the script refuses
to run against a database that already has records it did not create. It is for
looking at the product, not a fixture for tests — the test suite builds its own
data.

To remove it:

```bash
rm ./data/demo.db
```

## Markdown import

`notes/` holds three small Markdown files that exercise the import path: one
that classifies as a decision, one as a fact, one as an insight, and one
containing a credential-shaped string to demonstrate that redaction happens
before storage.

```bash
pnpm brain import examples/notes
```
