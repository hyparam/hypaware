# LLP 0476: Bounded settlement for an Ollama verification check

**Type:** design
**Status:** Draft
**Systems:** Cache, Query, Gateway, Daemon, Plugins
**Author:** HypForge designer
**Date:** 2026-10-08
**Related:** LLP 0473, LLP 0474, LLP 0475, LLP 0321, LLP 0322, LLP 0105, LLP 0038
**Extends:** LLP 0474 (#diagnostics: storage-owned finite settlement and non-mutating query context), LLP 0475 (#t4: sequencing and proof)
**Change-set:** ollama-everyday-collection, existing T4
**Source-check:** source-check-T4-extension.json, 2026-10-08T01:05:49.804Z, unchanged HYP-71 revision/readiness/Phil owner

@ref LLP 0473#requirements: keep the normal installed first persisted check and honest failure outcome
@ref LLP 0474#diagnostics: success still requires fresh correlated query-visible request and completed response

## Gap and decision {#decision}

At `250a91262046c2d1a3d13ee0cddc91debf637530`, query discovery and spool
settlement precede signal linkage. Killing a writing worker can interrupt mutation
lock publication or a commit before its spool checkpoint. Refresh never is read
only at the query freshness step and misses new durable spool rows. Ordinary
boot also migrates config/opt-outs and activates plugins with writable paths.

Forced gateway flush has one snapshot/drain, plus at most a second active
rotation/drain under failure coalescing. It is not an infinite tail loop, but its
shared current/legacy backlog and second-cohort growth have no fixed work cap.
Read scope.from/to and pendingInfo preflight cannot establish a synchronized
mutation frontier. Gateway settlement can invoke enrichers and fallback dedupe
whose history reads are outside a spool-byte cap.

Add a private bounded cohort operation on the existing processor-owned storage
service, separate from strict full flush. Confirm using a genuinely non-mutating
context over existing dataset/query/visibility machinery. This is a technical
extension of the same feature, not another change set, request, task graph,
listener, cache crash repair or general query/force-flush policy change.

## Cohort admission and storage {#cohort}

The server fixes dataset ai_gateway_messages and derives its current
aiGatewayTablePath (v5). It never takes a table path, SQL or dataset from a caller,
and does not settle legacy v4 or call flushAll. The shared v5 cohort may include
earlier rows from other clients; it is not a date-scoped or Ollama-only mutation.
Normal committed history remains intact. State that scope accurately.

Use the SAME storage/spool instance and per-table flush/write ownership as
ordinary append, size-threshold flush and sinks. Add a private admission that
refuses contention rather than adding another flush promise to the mutex queue.
Hold synchronization while freezing and validating the prospective cohort, then
rotate active once using the existing durable format. Admit no second active
rotation and no newly arrived file. Later appends stay outside the owned frontier.
Detect a changed identity/size or foreign writer and refuse, not silently expand.
Pin each admitted file identity and byte extent; read only that extent, preserving
any post-frontier suffix with its existing progress. The bounded operation does
not unlink source files: retain completed prefix checkpoints for ordinary full
flush cleanup, avoiding a stat/unlink race against a foreign append. File/entry
caps include retained completed files; excessive residue gives actionable refusal,
not a new cleanup sweep or indefinite rotation. Do not claim a new cross-process
spool-writer protocol or support concurrent foreign force writers.

Initial fixed ceilings: 16 MiB encoded cohort, eight recognized spool files,
8192 total rows, existing bounded batch readers with at most one decoded batch
retained. Enumerate the fixed spool directory incrementally with a finite entry
budget of 64 directory entries and 16 MiB per line; fail on excess/unknown
ownership or planted paths instead of allocating
a whole inventory. Bound each input line before JSON parsing. Validate file and
row limits under ownership, not a preceding pendingInfo read. Implementation
must record representative size/CPU/heap and may tighten these ceilings without
excluding the fixed tiny check; increasing them requires design readback.

Preflight every admitted row before cache commits. Reuse the gateway's existing
settlement-selection logic: refuse a cohort needing fallback-history dedupe or a
registered enricher's external/history work. Native null-cwd Ollama rows with no
enricher remain admissible. Pin settlement-hook/enricher registration generation
at preflight and revalidate eligibility before admitting each checkpoint unit;
reload/reconciliation invalidates it and returns partial/unconfirmed rather than
allowing new unbounded hook work. Do not skip enrichment, alter rows, invent cwd, drop
other clients or disable privacy filtering to make the check pass. Existing
purge/withhold and partition validation still apply at the storage write boundary.
Normal tiny native checks beside retained committed history and eligible concurrent
other-client traffic MUST pass; an implementation that always refuses is invalid.

The unit is one streamFlushFile yielded batch, followed by the existing
storage appendChunk across its destination groups, then writeProgress(resumeOffset).
Use at most 256 rows/1 MiB per yielded batch; one indivisible encoded row may use
the 16 MiB line cap and cannot be interrupted mid-commit. Reuse stable ingest
sequence allocation and existing append/partition guards. A stop request prevents starting another unit; a unit
already admitted finishes commit AND progress publication before releasing its
ownership. Unfinished durable data stays for normal recovery/flush. Budget or
semantic refusal before mutation leaves rows/checkpoints/stamps unchanged. Partial
cohort completion never claims full refresh. A cohort success does not clear the
ordinary full-flush failure stamp or advance lastFlushAt to hide excluded work;
write failures retain the existing bounded failure evidence. Ordinary auto/always,
coalesced retry and sink force semantics remain unchanged.

@ref LLP 0321#decision: a bounded verification operation cannot weaken strict forced refresh
@ref LLP 0322#coalesce-the-retry: ordinary force still drains its second active cohort after successful recovery

## Control, ownership and lifecycle {#lifecycle}

Advertise one fixed reserved local control route on the current live gateway;
bridge to its currently owned processor IPC. In-process mode invokes the same
storage operation directly. Validate fresh PID/run/source identity, operation ID,
loopback peer, direct origin-form, Host and absence of browser Origin. Refuse
absolute-form/tunnel access, redirects, remote peers and unknown request keys.
Cap body at 256 bytes and response at 1 KiB; allow only bounded check correlation/time
metadata. No credential, SQL/path/config authority or conversation payload in
the receipt. A receipt proves scoped settlement only and is never proxied/captured.

One requested settlement globally per owning processor/storage service, no pending
rerun queue or permanent token ledger. Caller timeout/disconnect cancels its sole
bounded waiter, NOT mutation ownership. Keep the writer slot until actual safe
settlement, returning busy to later callers. Lost/replaced-child receipts cannot
release that slot or satisfy another operation. Failure paths clear caller timers,
listeners and bounded IPC state; continuing work retains only its finite cohort.

Refuse new admission when recording is off, source policy is unreadable, processor
is stale/unavailable or shutdown began. Never attach, restart, change policy or
rotate a capture generation. Already owned pre-detach spool may become queryable
as history; it cannot resurrect suppressed captures. Off/run/generation changes
before final confirmation suppress command success and any current-health claim.
Recording barriers drain capture append ownership, not a full historical flush.

Shutdown stops settlement admission and disconnects caller receipts immediately.
Preserve driver.stop and sink abort/close initiation BEFORE awaiting this work.
The storage-owned stop flag cancels directory/preflight read streams before any
commit and prevents iterator.next from beginning another batch. After appendChunk
starts, join that batch AND writeProgress in the private owner.close promise;
caller cancellation cannot abort either. Source.stop joins this promise after
stopping admission; processor handle.stop joins source stop. Receiver.close alone
does not join storage. Gateway forwarding, heartbeat and unrelated sink admission
never await verification settlement on their hot paths.

**Unresolved lifecycle decision:** processor.js exits immediately on IPC
disconnect, so the join chain above is bypassed. gateway.js stop/replacement kills
its processor after 4000 ms. A finite input cohort cannot guarantee stalled storage
commit plus checkpoint completes in 4000 ms. Keeping both ordinary policies unchanged
therefore cannot establish safe supported disconnect/stop for an active mutation.
The concrete choice is an operation-aware disconnect/drain transition and explicit
graceful-versus-forced result inside the existing four-second ceiling, or a different
persistence path. The transition makes the join reachable; it cannot guarantee
safe drain when the forced deadline expires during stalled I/O. Its effect on
the existing no-orphan and stop guarantees needs
owner/steward disposition; it is not settled by this Draft. No timeout change,
lock recovery, orphan writer, crash replay repair or product implementation is
authorized here. External kill remains a limitation, never proof of ordinary
drain safety. Until this decision and its executable proof are resolved, the
settlement seam is not actionable for activation.

@ref LLP 0038#lifecycle-and-operator-behavior: preserve split ownership and the existing final stop ceiling
@ref LLP 0474#recording: off/generation control remains independent of settling previously captured history

## Non-mutating read context and result {#confirmation}

Use the existing createQueryRegistry, aiGatewayDatasetRegistration(undefined),
createQueryStorageService read methods and executeQuerySql with refresh never.
Construct a single-purpose context instead of invoking bootKernel, plugin
activation, createPluginPaths or source/sink starts in the killable worker.
Read manifests/catalog and layered configuration using existing validation/merge
helpers with migration disabled; verify the configured owning dataset/plugin is
enabled and compatible. Resolve the same actual HYP_HOME/config/callerCwd and
ordinary visibility policy, no includeLocalOnly override or raw cache shortcut.
Refuse unknown/unreadable state rather than guessing a default install or policy.

Keep the ordinary shared query wrapper and dataset discovery/source creation,
including purge visibility. A read-only storage facade refuses every mutator
and exposes only required methods. Constructors, imports, metadata reads and
cleanup must be demonstrated non-mutating; refresh never alone is insufficient.
No arbitrary installed plugin entrypoint runs. This changes only the verification
worker construction, not ordinary boot/migrations/query behavior. Parent owns
worker termination/reaping on every path, returning bounded metadata only.

Keep the separately bounded 30-second inference phase and disclosed fixed prompt.
One monotonic 30-second persistence budget includes all control, boot/discovery,
at most six sequential query reads and bounded retry waits. Use both scope.from/to
and SQL time predicates, including midnight; cap result rows/bytes and worker
heap work. HTTP can finish before append: allow at most six sequential cohort
admission attempts, only after the preceding owner actually settled, sharing
that total budget. Busy consumes no repeated polling loop; bounded waits or an
actionable non-success are required. Never repeat inference or reset a deadline.

Only the fresh check's policy-visible committed request/completed assistant pair,
shared request_id/token/provider/model/order, satisfies verification. Old, hidden,
poisoned, load-only, append-count or receipt evidence cannot pass. Disconnection,
off/stale state or elapsed deadline suppress late success. Budget/enrichment
refusal preserves all rows and says confirmation unconfirmed with recovery via
the ordinary explicit cache/query-refresh path; never silently invoke full force.
Timeout says inference completed, storage confirmation unconfirmed and collector
may finish, not canceled/lost/stopped. Status creates no worker/query/settlement.

@ref LLP 0105#unknown: worker construction retains the normal caller visibility boundary

## Existing T4 sequencing, proof and effort {#delivery}

This extension attaches only to LLP 0475 T4; no independent plan or integration
branch. Original T4 author retains its verify/status/matcher/query-worker edits.
Owner reviews the exact committed Draft and its unresolved lifecycle/effort
disposition. Only after acceptance and fresh source-stage confirmation does the
owner assign implementation seats and exact bases. Preserve current T4 dirty work;
no automatic author rebase. Owner chooses serial merge/cherry-pick or author-owned
rebase after an explicit custody readback. Coordinate storage/runtime paths with
steward; do not redirect or edit the active T4 checkout.

Required homes/interfaces: private bounded spool/storage admission and types in
src/core/cache/{spool,storage,types}; reusable settlement-eligibility predicate in
gateway dataset; gateway source control/process_transport and processor/source
close ownership; existing Ollama verify/query worker and its pure read context.
No broad sql.js signal redesign or ordinary boot mutation option is needed.
T4 owns its manifest/index/setup/verify command, status/types, telemetry vocabulary
and verify tests. Proposed seam ownership covers intrinsic read construction,
cache/storage/types, gateway dataset/control/transport and processor lifecycle
with new focused tests; it is not a second activated writer. The T4 worker consumes
the accepted pure-context API on the owner-selected integrated SHA. Receiver
publication hold remains unchanged; this doc alters no receiver/server contract.

Proof on actual storage/control/worker code: tiny fresh capture below threshold
beside retained history and concurrent eligible traffic; delayed append after
first settlement and deadline miss; old/hidden/poison rows; large current/legacy
backlog and directory/byte/row limits; growth between preflight and rotation;
coalesced failure/ordinary-force stamps; enrichment refusal retaining data;
timeout/disconnect and many retries with one writer, eventual retry; replaced IPC,
malformed body/peer/Host/Origin/proxy rejection; real worker kill during construction/
discovery with no filesystem mutations or leaked work; off/reattach generations;
normal shutdown/disconnect at preflight and admitted unit with immediate sink
close initiation. Forced exit limits are recorded, not counted as safe proof.
Traditional checks and running-app fixture proof precede T5 installed acceptance.

CPU/memory: finite directory/cohort expansion and one live writer/worker avoid
growth with caller count; no enricher/history scan hides behind byte limits.
Bounded preflight costs one extra read of at most the admitted cohort and can
briefly delay append under ownership; measure that effect. Chunk and metadata
buffers die at checkpoint/close. Fixed work does not promise fixed storage-IO
latency or a process RSS ceiling. Candidate lifecycle/resource evidence remains
owed, and general disk/lock/crash repair is outside scope.

Estimate: 8-14 additional implementation/test hours beyond original T4 command
work, plus review/fixes, with uncertainty in checkpoint close and pure-context
policy parity. Design authoring has a one-hour checkpoint, not an implementation
commitment. Owner/mayor disposes material delivery impact before committing that
work. Failure to implement these narrow contracts returns an evidenced limitation,
not a weakened verification success, changed full force or implicit repair scope.
