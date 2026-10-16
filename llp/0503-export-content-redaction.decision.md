# LLP 0503: Redact content at the shared export seam

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, Cache, Config, Privacy
**Author:** Phil / Codex
**Date:** 2026-10-15
**Related:** LLP 0010, LLP 0031, LLP 0070, LLP 0305

## Export seam {#export-seam}

Apply built-in credential and sensitive-file masking to rows leaving
`storage.readRowsSince`, after the existing purge and withholding checks.
Both request forwarding and file/table exports use this read path. Local
capture, local queries and stored cache contents remain unchanged. Existing
exported data is not recalled or rewritten by a configuration change.

Redaction preserves top-level identities, routing/provenance columns, numeric
usage, row order and continuation tokens. Changed payloads are copied, never
written back. All other string values, including nested attributes and raw
frames, are scanned. JSON-encoded objects and arrays keep their representation
and are redacted structurally. Object keys and binary attachments are outside
the scanner. Metadata-only projections need no content read or worker.

Built-ins cover recognizable AI/GitHub/AWS/Slack credentials, bearer tokens,
credential-bearing database URLs, private keys, named credential fields and
plaintext credential assignments. This is a small maintained set, not a claim
to detect every secret format. A file tool targeting a known sensitive path
has its string payload masked, including raw duplicates. Each export scan
keeps at most 4096 call verdicts keyed by session and call ID, so split native
call/result rows can share a verdict. A named file-read result without an
established path is masked conservatively, including when the call predates
the current export watermark. Argument paths and structural IDs survive.
Template filenames such as `.env.example` do not trigger full-file masking.
Arbitrary shell commands reading files cannot be classified this way.

The reader forces gateway tool context into projected content scans and
projects it away after masking. A sink asking only for `content_text` must not
bypass file masking by omitting the arguments or tool identity.

## Config {#config}

Add top-level `redaction.custom_patterns`, an array of `{ pattern, flags? }`.
Patterns are JavaScript regex sources without slash delimiters. Matching is
always global; supported flags are `gimsu`. Replacement is the literal
`[REDACTED]`. At most 32 patterns of at most 2048 characters are accepted per
config layer. Invalid syntax, flags, shapes and unknown options are rejected
at config loading, without including regex source text in errors.

Central and local pattern arrays concatenate, in that order. Local additions
can strengthen centrally configured masking, but cannot remove central or
built-in rules. There is no disable switch. Restart the daemon after editing
configuration, as with other boot-resolved settings.

## Custom regex execution {#custom-regex}

Custom expressions run in a lazily created worker belonging to the export
iterator, with one row in flight, a one-second deadline per row, and a 64 MiB
old-generation heap limit. Built-ins enforce traversal and text budgets before
IPC: at most 100000 visited values, depth 64 and 16 MiB of UTF-16 string bytes
per row. Regexes compile once per worker. Default exports create no worker.
The worker is terminated when the iterator finishes, fails, or is closed early.

A timeout, worker failure or exceeded row budget fails the read. There is no
unredacted fallback or successful acknowledgement for the failing row. Normal
sink retries retain their existing watermark and receipt semantics. Custom
patterns add IPC and worker overhead; work and temporary memory are bounded
per row, not by the complete transcript or export backlog.
