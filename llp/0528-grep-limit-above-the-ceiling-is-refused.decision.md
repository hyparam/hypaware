# LLP 0528: A grep `--limit` above the ceiling is refused, not clamped

**Type:** Decision
**Status:** Accepted
**Systems:** Query, CLI, MCP
**Author:** neutral
**Date:** 2026-10-17
**Extends:** LLP 0302 (#usage-exit), LLP 0353 (#default-resolution)
**Related:** LLP 0293 (#one-contract: exit 2 is the usage code), issue #972 (the codec enforces `maximum`), issue #2520

> [LLP 0302](./0302-grep-search-integration-divergences.decision.md) is
> Accepted and [LLP 0353](./0353-grep-search-injected-backend.design.md) is
> Active, so neither is edited. Both say a `limit` above the 1000-hit ceiling
> is clamped to it. This reverses that one rule and leaves the rest of both
> documents as they are.

## Context {#context}

LLP 0302 #usage-exit put `minimum: 1` in the grep `limit` schema and left the
ceiling out on purpose: above 1000 the operation clamped, on the grounds that
the help text promised a capped answer. LLP 0353 #default-resolution then
placed that clamp before the injected-backend seam, so both backends receive
the same limit.

In practice the clamp hid a substitution. `hyp query grep x --limit 5000`
answered as if 1000 had been asked for, with exit 0, so a caller could take a
1000-row answer as coverage up to 5000. The bundled query skills had to explain
the exception in all three copies. That is the same kind of silent replacement
0302 #usage-exit refuses for `--limit 0`, only at the other end of the range.

Two things have changed since 0302's reasoning. The verb codec has enforced
`maximum` since issue #972, so the schema can now state the ceiling and both
projections of it (the argv codec and `validateToolArguments` on MCP) refuse
above it before any search or remote request. And the server's own
`POST /v1/search` already refuses a limit above 1000 with `invalid_limit`, so
the client clamping where the server refuses made the two surfaces disagree.

## Decision {#refuse}

`limit` is `{ type: 'integer', minimum: 1, maximum: 1000 }`. A value above the
ceiling is a usage error: exit 2 on the CLI, the codec's
`expects an integer from 1 to 1000` message on both surfaces, and an invalid
arguments error over MCP. It is refused before the local search stack loads and
before `--remote` sends anything, because the codec runs ahead of both.

The operation also refuses above the ceiling with `VerbUsageError`, for a host
that calls `operation` directly and skips the codec. Nothing clamps on any
path, and a backend still never sees a limit above 1000, which is the result
bound 0353 relied on.

What stays:

- The default of 50 and the refusal of zero, negative and fractional values
  (0302 #usage-exit).
- `limitCeilingReached` is still computed by the verb before the seam, and at
  `--limit 1000` the truncation notice still names the ceiling instead of
  advising a larger `--limit` (0302's other point, which this does not reach).
- 0353's placement: argument rules run before the seam, so both backends
  receive an identical, already-validated `limit`. It is now a validated value
  rather than a clamped one.

## Consequences {#consequences}

A script that passed `--limit` above 1000 and relied on the clamp now exits 2
and must pass 1000 or less. The refusal names the range, so the fix is in the
message. `docs/MCP_REFERENCE.md` states the range, and the bundled query skills
say a larger value is refused instead of describing the clamp.
