# LLP 0544: An unsatisfiable range has one error kind across providers

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, Query
**Author:** neutral
**Date:** 2026-10-18
**Extends:** LLP 0452 (#range-contract: the unsatisfiable-range error gains a
stable kind)
**Related:** issue #2307, LLP 0014

## Why {#why}

[LLP 0452#range-contract](./0452-blob-range-reads.decision.md#range-contract)
makes an unsatisfiable range an error but does not say how a caller recognises
it. The two providers disagreed: S3 classified a 416 as `s3_put_failed`, a
token that is wrong for a GET and shared with every other unrecognised failure,
and local-fs threw `code: 'InvalidRange'` with no `errorKind`. A ranged
reader that wants to fall back to a whole-object read had nothing portable to
branch on.

## Decision {#kind}

Every provider that honors ranges throws an unsatisfiable range, an empty
object included, with `errorKind: 'blob_range_unsatisfiable'`. It sits beside
the other `blob_*` kinds the BlobStore capability already uses
(`blob_precondition_failed`, and S3's `blob_range_invalid` and
`blob_range_not_honored`), and the kernel contract names it on
`GetObjectInput.range`.

- The S3 provider maps `InvalidRange` (by name or `Code`) and HTTP 416 to the
  kind in `classifyAwsError`.
- The local-fs provider adds the kind to the error it already throws and keeps
  `code: 'InvalidRange'` for callers that match on it.

The kind is the error path only. Nothing about which ranges are satisfiable,
or what a satisfied range returns, changes.

## Checks {#checks}

Each provider is driven with an unsatisfiable range, the S3 one through a fake
client that throws a 416, and both must surface `blob_range_unsatisfiable`.
`classifyAwsError` is tested on the name, the `Code` and a bare 416.
