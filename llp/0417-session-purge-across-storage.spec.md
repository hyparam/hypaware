# LLP 0417: Purge a collected session across local and server storage

**Type:** Spec
**Status:** Draft
**Systems:** Privacy, CLI, Sources, Sinks, Cache, Identity
**Author:** Kenny
**Date:** 2026-09-18
**Related:** LLP 0104, LLP 0253, LLP 0403; server LLP 0003, 0005, 0053, 0140

## Request {#request}

A user must be able to purge a session that HypAware already collected,
whether it is waiting in a local spool or has reached the server. The user
confirmed that owners may purge their own sessions and organization admins
may purge sessions within their organization.

This request extends the local-only boundary of
[LLP 0104](./0104-hyp-purge.decision.md). Ignore remains a separate,
non-destructive operation. Existing directory and whole-cache purge targets
must not silently acquire remote deletion behavior.

The server implementation lives in the sibling `hypaware-server` repository.
Session purges include all configured remotes, signed-in built-in remotes,
and enrolled central servers by default, using human login credentials to
call `POST /v1/sessions/purge`. A shipped but unused built-in alone is not a
configured destination. `--remote NAME` narrows remote scope to one server;
`--local-only` explicitly opts out of remote purging. These flags are mutually
exclusive and only apply to session targets.

## Previous behavior and gaps {#baseline}

- `src/core/commands/purge.js` deletes matching committed cache rows and
  sweeps the entire Claude raw-body spool, including bodies unrelated to the
  selected session. It never calls the server.
- `src/core/cache/purge.js` scans committed Iceberg tables. It does not remove
  matching records in `_hypaware_spool` before a later flush commits them.
- `src/core/cache/iceberg/store.js` uses position deletes. These hide rows
  from compliant readers but retain content in underlying data files and
  older snapshots. A zero query count is not proof of physical erasure.
- The sink driver's retry outbox stores partition references, not a second
  row payload. A chunk already held by an exporter is a separate race.
- LLP 0403's persistent session exclusions stop participating capture and
  backfill paths. They do not themselves delete history or exported copies.
- Server ingest stores rows in a gateway/dataset NDJSON spool, moves them
  into the kernel cache, and exports closed days to an Iceberg archive on
  local disk or S3. The previous wire contract had no session purge route.
- Server session summaries, the session locator, graph projections, search
  indexes, and report artifacts can retain information after source rows
  disappear. Server LLP 0140 explicitly requires purging report transcript
  copies as well as the source dataset.

## Authorization {#authorization}

Remote authorization must use the authenticated person's current organization
and server-held identity bindings. A caller-supplied organization, owner,
email, or session ID is not proof of ownership.

For owner requests, derive ownership from server-stamped gateway attribution
and the gateway's verified `userKey` binding. Include the same person's
gateways across machines and identity refreshes. Bootstrap gateways without
a verified human binding require an organization admin. Shared or conflicting
ownership must not be resolved by accepting the first matching row.

Organization admins may purge within their current organization only. Check
the current role and session validity at the destructive boundary; a stale
access token retaining an old admin scope must not authorize deletion after
demotion or revocation. Read-only query tokens and ordinary upload gateway
credentials are not human purge credentials.

The same opaque session ID in another organization must remain untouched.
Unauthorized requests must not expose session content or a foreign owner's
identity. Repeated authorized requests remain safe after the source evidence
has been erased, using the durable operation's authorization record.

## Operation contract {#operation}

The command must name the exact session and disclose local and remote scope
before destructive confirmation. Reuse existing remote configuration and
human login credentials. Do not invent a second server URL or credential
setting. An offline client or an older server without the endpoint must not
report remote completion. Missing credentials also count as incomplete,
including an enrolled upload server without a matching human remote login.
Attempt every selected remote even if an earlier one fails, return nonzero
if any fails, and include a per-target result in JSON output. Remote calls
run sequentially to bound in-flight requests and memory.

Before deleting content, durably record the exclusion necessary to stop
capture, replay, and re-upload. Reuse the local exclusion mechanism where it
has the required semantics. A server exclusion must survive process restarts
and apply before acknowledging newly ingested matching content. Removing an
ordinary capture ignore must not silently cancel a pending purge.

Local and remote execution are independently retryable. A failure on one
side must preserve successful work on the other and report the incomplete
side explicitly. Remote acceptance is not completion. The receipt must
distinguish pending work, failed work, and verified completion for each
required storage tier, and remain inspectable after restart.

Coordinate with writers, spool rotation, buffered capture, in-flight exports,
archive commits, and derived-data rebuilds. A request arriving before the
purge fence but finishing afterward must not restore the session. An empty
cache alone must not bypass the spool or archive work.

## Storage coverage {#coverage}

The implemented scope covers these independently:

1. Local raw-body spool and normalized cache spool, including rotated files;
   committed cache rows and session-filtered search reads.
2. Server ingest spool and kernel cache spool; committed server cache rows.
3. Session-keyed canonical server archive tables, including sessions already
   evicted from cache and content split across receive days.
4. Session-keyed query/search reads and the session locator are excluded.
5. Session graph nodes and their incident edges are position-deleted and fenced.

Generated reports, copied report-agent tool results, File nodes and aggregate
records without complete session lineage remain outside this operation's
scope. The receipt discloses this limitation. Matching their outer
`session_id` cannot find source sessions copied into a tool result. Broader
derived-content erasure requires lineage work and is not claimed here.

Shared files and derived records must preserve unrelated sessions. A broad
deletion of unrelated report artifacts or an organization's data requires
its own disclosed scope; it is not implicit in a session purge.

Native client transcripts are outside HypAware-managed storage. They may
remain, but the durable exclusion must prevent re-import. Independently
downloaded exports cannot be recalled. Disclose any unsupported configured
destination rather than treating it as purged.

## Erasure semantics {#erasure}

The user selected Iceberg position deletes on 2026-09-18. Completion means
logical removal from current table reads. Existing data files and historical
snapshots can retain bytes until later compaction and snapshot cleanup; those
maintenance operations run asynchronously after the command, as described below.

Pending spool rows must be dropped or drained through the deletion fence.
Retries and re-imports must not restore the session. Unrelated rows sharing a
file must remain visible. No secure erasure or backup deletion is promised.

## Verification {#verification}

Use synthetic session content and assert both absence of the target and
survival of another session sharing its files. Regression coverage includes
local active/rotated spool, restart/replay, projected reads and incremental
export, unreadable storage, local/remote partial failure, owner/admin access,
foreign orgs, duplicate IDs across orgs, revoked/demoted humans, gateway and
read-only denial, server spool/cache/archive-only history, search, and retry.

The server integration uses local-fs archives. S3 uses the same BlobStore
position-delete adapter but has not been exercised against a live bucket.
Physical removal, copied tool results, and unkeyed derivatives are excluded
from completion, as specified above.

Emit structured stage, status, count, and duration telemetry without session
content, credentials, or raw identifiers. Failed work must identify the
storage tier and remain retryable.

## CPU and memory constraints {#performance}

Scan projected columns one Parquet row group at a time and commit at most
5,000 delete positions per batch. Underlying whole-object BlobStore reads
and large row groups retain their existing memory costs. Do not load
a session's complete history, an organization's archive, or a spool backlog
into memory. Reuse partition metadata and session bounds to narrow scans,
but do not treat an incomplete index as proof that no content exists.

Keep exclusion checks cheap on ingest, bound concurrent purge workers and
retries, and avoid per-row filesystem lookups. Authorization scans, shared
file rewrites, derivative rebuilds, and snapshot cleanup are the main CPU,
memory, and I/O risks; an implementation review must evaluate each.

## Implementation status

Implemented in the client and sibling server. The command covers session-keyed recorded rows.
Existing generated reports and derivatives without complete session lineage
are outside that guarantee and must be disclosed; never delete unrelated
artifacts to conceal the provenance gap.

## Review follow-up {#review-follow-up}

Session purges position-delete matching rows in active and retired epochs
under the partition mutation lock. Session graph IDs are derived using the
existing graph convention. Their nodes and incident edges share the persistent
fence, including projected reads and incremental exports. Shared File nodes
are preserved; exclusive File-node discovery and report provenance remain
unimplemented and explicitly outside the completion guarantee.

JSON results distinguish logical containment from physical cleanup locally
and per remote. Local physical cleanup is `not_implemented`; absent physical
status on older servers is `unverified`. The CLI prints the physical limitation
even for local-only purges. Historical snapshots and original files still
require a separate, crash-safe reclamation implementation. The companion
server's compactor now understands position deletes, but that rewrite alone
is not physical erasure.


## Automatic cache reclamation {#cache-reclamation}

Session position deletes durably admit a per-partition cleanup journal before
the first delete commit. It names the current and older managed table/epoch
generations, with no session content. Admission failure prevents the delete
commit; partial purges keep admitted work for maintenance and retry. Server
receipts persist opaque job references at admission, including partial failures.

The ordinary hourly cache maintenance loop treats a marked live generation as
due even with one file, an unchanged compaction baseline, or a foreign sorted
replace. It uses the existing streaming generation writer, applying position
deletes and preserving every surviving row and ingest sequence. This path
does not deduplicate or re-settle rows, so it needs no table-sized identity set.
Writes use the partition mutation lock. Unique generation names allow retry
after a partial output; after a cursor swap, the old journal no longer forces
another rewrite of the new generation. Another purge marks the new generation.

The retired-generation sweep reclaims the named directories, including data,
all snapshots/metadata and sidecars. It preserves the existing cache reader
safety model: at least 24 hours after admission and retirement, rather than
archive-style active-reader leases. The shorter orphan grace never applies
to these targets. Long-lived external readers beyond the retention window
are not protected. Missing/corrupt cursors, invalid journals, unreadable
metadata, explicit branch/tag pins and statistics sidefiles block reclamation;
later maintenance retries. No fixed completion deadline is promised.

Status verifies each named generation is absent before reporting completion.
It certifies those cache generations, not all session copies. Historical-only
copies in partitions with no matching live rows in any managed generation,
unmanaged legacy tables, native transcripts and derived reports are outside
this scope. Pre-upgrade position deletes without cleanup journals are not
retroactively certified. Disabled maintenance postpones cleanup.

Cost is one streaming full-generation rewrite per affected partition; this is
more I/O than a subset merge but retires the entire snapshot history. Existing
batch, row-group and open partition-writer memory bounds apply. Journals cap
generation lists at 10000 and encoded size at 1 MiB. Ordinary maintenance
continues to use its tick budget and failure isolation.
