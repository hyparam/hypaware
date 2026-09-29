# LLP 0452: Optional Byte Ranges for BlobStore Reads

**Type:** decision
**Status:** Accepted
**Systems:** Sinks, Query
**Author:** Phil / Codex
**Date:** 2026-09-29
**Related:** LLP 0014

## Why {#why}

Archive readers need random byte access to Parquet footers, indexes and
selected columns. Downloading the entire object before serving each reader
defeats that selection and retains large buffers during queries. Extend
the existing BlobStore read capability rather than adding a second storage
or credential path.

## Range contract {#range-contract}

`GetObjectInput.range` is an optional single HTTP byte range. It accepts
`bytes=start-end`, `bytes=start-`, and `bytes=-length`; the end is inclusive.
Omitting it preserves whole-object reads. Missing keys still return null.
Providers may ignore the option for backward compatibility, but must then
return the whole object without `contentRange`.

Providers honoring the range return `GetObjectResult.contentRange` as
`bytes start-end/total`, with `contentLength` describing the returned body,
not the complete object. Consumers verify those offsets and body length
before using the bytes. An unsatisfiable range is an error, including a
range over an empty object. Multi-range reads are outside this contract.

The S3 provider passes Range to GetObject and maps ContentRange back,
preserving the existing bucket, prefix and credentials. A store that
ignores Range answers 200 with the whole object and no ContentRange, and
that body is indistinguishable from a slice once it is handed on, so the
S3 provider rejects such a response instead of returning it as the
requested range. The local filesystem provider resolves the range against
the opened file's size and streams only those offsets from that held file
handle. It does not buffer the file.

This extends LLP 0014's BlobStore capability without changing archive
formats, configuration, indexes, writes, or the behavior of existing
whole-object callers. No runtime dependency or global cache is added.

## Checks {#checks}

Provider tests cover inclusive ends, suffixes, open ends, EOF clamping,
invalid ranges, empty and missing files, unlink-after-open behavior, S3
header mapping through a scoped key, and the rejection of an S3 response
that carries no ContentRange for a requested range. Server reader tests
verify byte counts, projection over real Parquet, legacy fallback and
invalid range responses.
