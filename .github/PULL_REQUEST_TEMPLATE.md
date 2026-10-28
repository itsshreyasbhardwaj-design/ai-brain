## What this changes

<!-- One or two sentences. -->

## Why

<!-- The problem, not the solution. -->

## What I verified by running

<!--
Be specific and honest. "I could not test the Docker path" is a good sentence.
Silence about what you did not check is not.
-->

- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] Checked it in a browser

## The one rule

This project does not display anything it has not observed.

- [ ] New values carry an `origin` and a `confidence`
- [ ] New empty states say **why** they are empty and **what** would fill them
- [ ] Nothing new renders a `0` that could be mistaken for a measurement
- [ ] Any new heuristic is surfaced with its reasoning, not as a conclusion
- [ ] If I could not verify a claim, it went on the roadmap rather than the README

## Tests

<!-- What you added, or why none was needed. -->
