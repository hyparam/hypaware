# LLP 0038: Separate query/export daemon from gateway daemon

**Type:** Todo
**Status:** Draft
**Systems:** Daemon
**Author:** Phil / Claude
**Date:** 2026-06-25
**Related:** LLP 0054

> Captured todo — not yet fleshed out. Promote by retyping
> (`.todo.md` → `.rfc.md` / `.spec.md` / `.decision.md`) once it has enough
> detail to act on, then `/llp-grill` and `/llp-review`.

## Idea

Separate out query / export daemon from gateway daemon to prevent brownouts on OOM or other crashes.

## Why / trigger

TK — what makes this worth doing; the pain or problem it addresses.
Defense-in-depth sibling of [LLP 0054](./0054-bounded-query-execution.spec.md):
bounding caps the common case; isolation contains the query that escapes the
bound so it cannot brown out the gateway.

## Sketch

TK — rough shape of the approach. Fill in when picked up.

## Done when

TK — what "fleshed out / shipped" looks like.

## Open questions

TK
