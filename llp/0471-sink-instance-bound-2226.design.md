# LLP 0471: Bound sink work by logical instance

**Type:** design
**Status:** Draft
**Systems:** Sinks, Daemon, Plugins
**Author:** HypForge steward
**Date:** 2026-10-07
**Related:** LLP 0014, LLP 0017, LLP 0040, LLP 0101, LLP 0349, LLP 0453
**Implementation-plan:** LLP 0472

@ref LLP 0014#forward-sink-backpressure [extends]: bound complete logical chunk work and scheduled instance concurrency
@ref LLP 0040#watermark-contract [constrained-by]: acknowledge the whole partition before advancing its watermark
@ref LLP 0349#not-settled [extends]: retain finite diagnostic history and ordinary-install failure visibility

## Intent

Implement the settled repair in [issue 2226](https://github.com/hyparam/hypaware/issues/2226)
and [Phil's decision](https://github.com/hyparam/hypaware/issues/2226#issuecomment-6006974495).
The admitted outcome is one active operation plus one coalesced rerun per logical
sink instance, independent local exports and daemon health work, actual bounded
central cancellation, and finite failure history. A global `runTick` guard would
retain the blocked destination's control over unrelated work and is rejected.
This design extends the clauses identified below without rewriting their history.
It is Draft pending the orchestration actionability checkpoint before repair.

## Evidence and boundary {#boundary}

At base `e6784482e04ce77eb2e15ed11a29f29d638f8903`, accelerated disposable daemon
probes reproduce ten concurrent exports for one slow destination. A second probe
reproduces seven slow exports while the following fast destination, sweeps and
source-status refresh do no work. The current central request lacks a fetch
signal; close does not settle it. A WeakRef probe retains the original failed
partition's Error through the next partition await, then releases it after export
settles. These are synthetic reproductions, not measurements of a production outage
or proof of the entire chunk retainer graph. Ninety existing targeted tests pass.

The native parent is `nn-maint-sink-tick-overlap-20261007`. Its investigation,
UX consultation and cancellation feasibility evidence live in the HypForge task
record, outside this product repository. Admission 2127 and checkpoint disposition
2150 reserve this outcome's single maintenance slot. PR #1034 remains deferred;
OTLP decoded bodies and plugin-install diagnostics remain separate unreserved work.

Affected seams are the driver, sink registry metadata/close lifecycle, daemon host
and status, and central's chunk transport, shared lazy identity and wrapper close.
The plugin `Sink`/`exportBatch` contract, configured schedule and sink identity,
wire ids, watermark schema, first-sync privacy policy and source/sweep policy stay
as shipped. No runtime dependency, configuration key, persisted field, global
scheduler, cross-process lock, compression or enrollment replay is introduced.

## Instance ownership {#instance-ownership}

The validated registry handle is the logical execution identity. Store private
execution state by that handle, using the registry's existing metadata ownership
pattern or a private WeakMap reached by every driver using that registry handle.
Two drivers sharing the handle must share its gate. Neither mutable plugin fields
nor a new process-wide indexed ledger define identity. Replaced handles have new
lifetimes; close prevents old work and pending receipts from reaching replacements.

Each handle retains only:

- one active operation, acquired before asynchronous hold checks or discovery;
- one pending rerun bit;
- optionally one explicit manual receipt and its progress callback, occupying
  that same pending opportunity;
- one stopped flag and bounded completion/diagnostic scalars needed by the host.

The existing awaited `tick` remains the manual API. Add an internal synchronous
scheduled dispatch seam: it iterates selected handles, checks due cron, and either
starts owned work or sets the pending bit. A busy timer fire creates no Promise,
report, partition array, timestamp closure or progress callback. A missed/not-due
fire creates no backlog. Completion consumes the pending bit once and obtains a
fresh time, current handle policy, hold, cron and cache discovery. Timer repetition
while that run is active can set the same bit again; retained state never grows
with fire count. An immediately failed operation may rerun once if requested;
completion alone cannot spin another run without a new request.

@ref LLP 0101#hold [constrained-by]: every actual export remains behind the absolute first-sync deadline

Move the hold check into actual admitted work, before discovery/export, so timer
contention does not allocate an async hold lookup per fire. Every new actual run
checks the driver-wide hold using fresh time. `force` does not release it. A held
or no-longer-due rerun settles without a fabricated export success or failure.
Keep the existing hold reason and CLI consent/release behavior. Registry handle
enumeration remains proportional to configured destinations, not queued fires.

## Awaited manual work {#manual-work}

Manual `tick({force, sinkInstance, onProgress})` processes its selected destinations
sequentially and awaits each admitted run through durable completion. `hyp sync`
has one spinner's destination counters, row rate and ETA; scheduled independence
does not change that presentation contract. Ordinary CLI sync uses its own process
and registry. This gate provides same-process coordination only.

If a selected handle is already active, admit at most one manual request into the
existing pending opportunity. A pending scheduled bit is upgraded to this receipt,
not retained as an additional queue entry. Timer fires continue to set the same
bit. The admitted caller owns its force/filter intent and starts fresh progress
only when its own rerun actually starts. It awaits that run's result, never the
active daemon export's receipt. Recheck the hold, discover fresh work and preserve
the shipped partial result/exit-code and replay semantics.

A further manual caller returns promptly with the existing failed result shape
and a bounded actionable busy reason. For example: "A sync for this destination
is active and a follow-up is pending; retry after it finishes." Refusal is not an
export attempt: do not create an outbox batch, increment export-failure counters,
or emit failure/recovery transitions. Other selected destinations still receive
ordinary results. Keep admission outcomes separate internally from export outcomes
so the daemon cannot stamp either a refusal or a queued run as success. No new
public sink status vocabulary is needed.

Stop disables acquisition and reruns first, settles the pending manual receipt as
unsuccessful, and releases its callback without starting it. Completion releases
each receipt once on success, partial failure, held work, cancellation or refusal.
The same-parent guardian consultation approves these bounds, not implementation.

## Independent daemon work {#daemon-work}

The existing interval dispatches due sink work and separately requests the existing
sweep/status/bookkeeping path. It does not await central before reaching that path.
Sink completion updates an existing per-instance snapshot directly through an
internal callback with bounded scalar data; do not enqueue completed reports or
retain partition inventories until the next timer. Only real admitted exports
produce export transitions. The callback carries actual completion time.

Bookkeeping has its own one-active/one-bit gate, acquired synchronously. Timer
fires and completion-triggered persistence coalesce there. Keep the existing
provider sweep single-flight/bounded handoff and source-probe limits; do not replace
the sink queue with a sweep or status queue. Refresh source status and persist
the heartbeat even while a destination is blocked. Existing local persistence,
probe deadlines and self-update guards must be examined at integration: move no
unbounded network await into the heartbeat-critical chain. Config reconciliation
retains its own ownership rather than awaiting an export to perform every pass.

@ref LLP 0017#the-primary-daemon [extends]: sink completion no longer gates independent daemon health work

For the same configured destination, `lastTickAt` describes the actual attempted
run and `lastSuccessAt` is captured after a fully exported result and durable
watermark completion. A queued, refused, held, cancelled or partial run does not
advance success. Another destination's completion cannot clear this one's warning.
Clock comparisons remain conservative: success must be strictly after the failure
record; equal, invalid and future records retain existing treatment. Preserve
recovered success stamps across daemon restart.

For new failure records, compare against the existing JSON `recordedAt`, which
is captured when failure is persisted, rather than the batch filename's dispatch
time. Read only a bounded metadata prefix, before the potentially large partition
array; the current writer already places `recordedAt` before error/partitions.
Retain the legacy filename timestamp fallback for absent/unreadable metadata and
test its conservative behavior. This uses an existing field and preserves wire
batch ids, record shape and filenames. No new timestamp column is needed.

Use the existing daemon file logger/status diagnostics for one transition into
failure and one recovery after a later success, identified by validated destination
and bounded secret-safe reason. Repeated failure may update the current reason
without emitting one growing log per busy fire. No new stalled threshold or
status schema is introduced. Callback/persistence failures are separately visible
and cannot turn a failed export into a success.

## Chunk lifetime and actual cancellation {#chunk-lifetime}

@ref LLP 0014#forward-sink-backpressure [extends]: the elapsed budget covers transport and retries, not only requested sleep

One logical central chunk POST gets a 330-second elapsed ceiling, including lazy
authentication, fetch/upload, response consumption and every 429/503 retry wait.
Its controller owns the current request/body/wait and a single deadline timer.
Every retry keeps the same chunk id and content and consumes the remaining budget;
it never resets the clock. A healthy multi-chunk export gets a fresh budget for
each new logical chunk and may run longer than 330 seconds overall.

Pass the controller signal into actual fetch and abortable waits. Cancel/consume
each response before retrying; cap error-body reading before decoding/JSON parsing.
Do not retain an unbounded `response.text()` result, even if its displayed message
is later truncated. Reuse central's existing capped response-reader and cancellation
patterns from config polling in a narrowly shared home where needed. Success bodies
also finish consumption or cancellation. Clear timer and signal listeners on
success, failure and close. A timeout race that returns while its losing fetch
continues is not cancellation.

Dataset-registration requests preceding a chunk need the same actual cancellation
and elapsed transport ceiling, without constructing/retaining a chunk while an
unbounded handshake waits. Keep successful registration deduplication and discard
failed locks after owned resource settlement. Separate registration and each chunk
have their own bounded logical operations; there is no whole-export timer.

Flush owns the current lines, body string and encoded upload bytes. Keep retry
bytes only during that chunk's live retry loop. On success or failure, settle
request/body cancellation first, then clear every chunk reference in a `finally`
boundary before returning to partition traversal. Extract bounded diagnostic
scalars inside a per-partition helper and return an outcome value. No original
Error, stack, cause or annotated chunk buffer crosses into the next partition's
await. Preserve acknowledged chunk/byte progress in scalars and count only actual
acknowledgements in the manual display. Progress does not imply a watermark commit.

Diagnostics carry safe categories/status/error codes and short bounded text
(at most the existing 200-character displayed error-detail limit), never payload,
authorization, JWT or unfiltered server/private body. Unknown transport reasons
use a useful generic failure category. Body-reader byte caps must be tested against
actual central response fixtures; this is not the OTLP accepted-body cap decision.
Reuse an established compatible cap rather than introduce user-facing policy.

## Shared authentication ownership {#shared-auth}

Central's config pull and sink share one `IdentityClient`. Preserve one refresh
transport and cached identity, while making refresh callers cancellable. Cached
JWT reads do not allocate a refresh resource. Both `getCurrentJwt` and forced
`refresh` accept an internal optional caller signal; thread the chunk signal and
existing config poll signal through their call sites. Initial acquire/persistence
policy is otherwise unchanged.

The IdentityClient owns one refresh controller, one elapsed resource deadline
(bounded by the same 330-second central ceiling), and a set of live caller leases.
Each actual sink chunk/poll can own at most one lease. A lease owns only its receipt
and cancellation listener, with no retained partition/body. Use one settlement
handler for the shared transport and removable subscribers; cancelled callers must
not remain in per-caller `.then` reactions on the shared refresh until it finishes.

Cancelling one lease detaches it and settles that caller. Other live consumers
can continue the refresh under its existing deadline. Cancelling the last live
lease aborts actual fetch and body consumption and settles that caller after
resource cleanup. Keep the refresh registered until its actual settlement; a new
caller encountering an aborting refresh fails with a bounded retryable reason
rather than starting a competing request or joining an unbounded wait queue.
Deadline expiry settles all remaining leases and clears the resource. An already
aborted caller starts nothing. A new call after settlement can refresh normally.

Check cancellation before publishing a fetched identity/starting its existing
atomic persistence. Do not report cancelled work as a refreshed credential or
retain an uncancelled Promise.race loser. The optional signal changes this bundled
internal client only, not a public plugin interface. Config poll retains its own
30-second timeout and existing stop grace; cancelling its lease cannot abort a
still-owned export refresh, and vice versa.

A disposable Node 24.2.0 loopback prototype passed twice: one request serves two
leases; cancelling one leaves it active, cancelling the last closes both a header
stall and body stall; a resource deadline closes a request; later shared success
uses one fresh request. Peak active requests is one. This establishes feasibility,
not production code, bounded parsing, identity persistence or heap acceptance.

## Stop and close order {#close-order}

Daemon stop performs these operations in order:

1. Disable sink dispatch, bookkeeping requests and every rerun. Settle pending
   manual receipts and release callbacks without starting work.
2. Invoke cancellation on every owned sink instance before awaiting any sink,
   maintenance, config reconciliation or source shutdown. Initiating one close
   must not wait for a preceding sink's close before signalling later sinks.
3. The central wrapper initiates forward-sink abort immediately, stops new config
   polls and releases its poll lease using the existing stop path. Then await
   request/body/wait cleanup and the bounded poll stop; do not await polling before
   starting sink abort.
4. Await already-owned export completions and bounded bookkeeping, then finish
   existing source/registry cleanup and delete handle state. A late completion
   cannot start a rerun or update a replacement handle.

Reuse the existing public `close` hook and internal driver stop/drain seam. Registry
close must initiate all relevant closes before serial awaits, preserve owner scope,
observe all rejections and avoid double-closing resources. Runtime can initiate
the close promise early, then await it at the existing cleanup boundary. A generic
third-party plugin that ignores `close` cannot have its async work forcibly settled
by JavaScript; keep its retained work at one and report this existing contract
limitation. Strong bounded transport settlement is required for bundled central
and for cooperative daemon acceptance fixtures. No fake timeout success is allowed.

## Watermarks and retry truth {#watermarks}

@ref LLP 0040#watermark-contract [constrained-by]: only a fully acknowledged partition advances its cursor

Keep existing stable chunk ids, server deduplication, generation/front-prune logic
and per-partition serialization. A timed-out chunk retains retryable cache rows.
Do not advance a partition watermark past any unacknowledged chunk. Rows may have
unordered `_seq`, so the watermark remains an end-of-partition commit after all
required chunks acknowledge; no per-chunk shortcut is introduced. Other partitions
that succeeded may keep their truthful partial progress. Failure to write the
watermark is failure/partial truth, even when the transport acknowledged rows.

LLP 0040's historical risk 6 describes outbox replay. At this base, the active
driver writes diagnostic files and status reads their filenames; neither driver,
manual sync nor central consumes them as retry payload. Retry is fresh cache
discovery plus watermarks and server idempotency. This extension clarifies that
current behavior and permits diagnostic pruning without acknowledging data. It
does not change cache retention, spool envelopes or the deferred lost-write race.

## Finite diagnostic history {#diagnostic-history}

@ref LLP 0349#not-settled [extends]: retain at most 100 owned failure records per instance and report cleanup independently

Retain the newest 100 recognized driver-owned JSON failure records for each
validated instance in its existing outbox directory and format. Atomically commit
the new diagnostic first; a failed write never justifies pruning old evidence.
Protect that just-committed record during pruning. Rank other recognized records
by their existing `recordedAt` metadata, with legacy filename time fallback,
sequence and stable basename tie-break; handle clock ties conservatively. Preserve
unfamiliar names, symlinks and other instances.
Their presence is an explicit cleanup limitation, not permission to delete them.

For a large old directory, stream entries and retain only the top 100 names in
bounded memory, then stream a deletion pass with bounded batches/yields. Do this
initial reconciliation once per handle lifecycle. Prune after each actual failure
batch, not per exported row or partition. After cleanup succeeds, subsequent
work examines at most the bounded recognized history plus the new record. If
cleanup fails, record a short separate cleanup diagnostic, retain the new export
reason, and avoid rescanning all historical files on every subsequent failure:
retry cleanup only on the existing maintenance cadence. This uses existing cadence
and state, without another timer or service. Failure can temporarily leave more
than 100 records; do not claim the cap held through a filesystem failure.

The capped historical count is retained evidence/a floor, not every failed attempt
or a queue of unsent rows. Never touch cache files, watermarks, ingest ids, another
instance's records or product telemetry's separate outbox. Update affected count
wording through existing status output rather than invent a persisted cap flag.
The bounded metadata prefix also permits a bounded newest-record reason read if
needed by the existing diagnostic. Open only recognized ordinary files, never
follow preserved symlinks, and do not parse entire partition inventories for status.
Status may read at most the retained recognized records after successful cleanup;
stream directory entries to avoid unbounded listings while historical cleanup is
pending or unknown entries remain. Failed cleanup remains an explicit cost limit.

@ref LLP 0453#warning-rule [constrained-by]: pruning and age cannot clear a configured destination's unresolved failure

The newest unresolved failure must remain visible past 100 failures and the
24-hour historical-count window until a strictly later successful completion for
that same configured destination. Recovery can clear its warning while retained
history remains nonzero. Partial/queued work cannot clear it. Preserve configured
destination selection, equal/invalid/future stamp treatment and restart recovery.
Cleanup success itself is never export recovery.

## Alternatives, performance and proof {#proof}

A global gate, a Promise retained per fire, parallel manual display, a second manual
queue, timeout-only Promise.race, whole-export deadline and incremental unordered
watermark are rejected because they violate the settled behavior above. Removing
central's partition guard merely because daemon dispatch is bounded is also
unnecessary: direct API callers retain existing serialization unless tests and a
separate justified change establish otherwise.

CPU/memory target: O(configured instances) execution/host state, one current
discovery/export per handle, one current chunk/retry body per central operation,
one auth transport with live bounded consumers, and 100 recognized diagnostics per
instance after successful cleanup. Discovery still scales with current cache
partitions under its existing limits; this design removes multiplication by timer
fires, not all payload cost. Initial historical cleanup is O(old records) work
with bounded retained names, and subsequent cleanup is bounded. Error/body caps,
listener/timer cleanup and removable auth leases prevent hidden retained growth.

Acceptance requires before/after regressions, real disposable loopback transport
cancellation, direct retainer evidence or a repeated-failure small-heap plateau,
and a disposable running daemon proving independent export/sweeps/heartbeat, manual
progress, failure/recovery and shutdown. LLP 0472 makes these tasks and evidence
explicit. Independent exact-commit Astra CPU/memory and interaction review follows
implementation. No installed/enrolled daemon, real refusal or user recording is
required by these probes; fixtures alone cannot establish installed-service health.
