# LLP 0156: A collided LLP number is repaired by renumbering the later claimant

**Type:** decision
**Status:** Active
**Systems:** Docs, Process
**Author:** Phil / Claude
**Date:** 2026-07-30
**Related:** LLP 0001

> Parallel branches occasionally mint the same LLP number, and both land on
> master ([issue #463](https://github.com/hyparam/hypaware/issues/463) item 1
> found three such pairs: 0098, 0099, 0111). A bare `@ref LLP 0111#surface`
> is then formally ambiguous: neither a reader nor a checker can tell which
> document is meant. This decision settles how a collision is repaired.

## Decision {#renumber}

**Renumber the later claimant; a number has exactly one document.**

- The document that reached master first keeps the number. The later
  claimant moves to a fresh number above the highest number claimed
  anywhere, including branches without an open PR, so the repair cannot
  create the next collision.
- Every inbound reference to the moved document (code `@ref`s, doc links,
  `Related:`/`Extended-by:` headers) is swept to the new number in the same
  commit, disambiguated by anchor and context.
- The corpus invariant "no LLP number is claimed by two documents" is
  enforced by `test/core/llp-ref-hygiene.test.js`, unskipped by the commit
  that lands this decision.

Applied here: 0098-inactive-not-unknown-dispatch-miss became LLP 0153,
0099-dispatch-miss-repair-by-cause became LLP 0154, and 0111-report-cli
became LLP 0155 (their first-to-master twins scancolumn-where-pushdown,
codex-attach-auth-route, and hyp-policy-verb kept their numbers). The same
repair had precedent in PR #486, which renumbered a colliding 0142 to 0152.

## Rejected alternative

**Keep the collision and require a filename-qualified citation form** for
the affected documents. Cheaper at repair time (no reference sweep), but it
adds a permanent second citation form to the convention, makes the checker
and every reader carry the ambiguity forever, and the cost grows with each
new inbound reference. A one-time sweep is bounded; a citation-form fork is
not.

## Consequences

- Renumbering churns git history for the moved documents; `git log
  --follow` still tracks them across the rename.
- External corpora citing a HypAware LLP by number (for example the server
  repo's `HypAware LLP 0098`) must cite the surviving claimant. The sweep
  for this repair checked hypaware-server and found only references to the
  documents that kept their numbers.
