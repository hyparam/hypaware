# LLP 0476: Live-service settlement for an Ollama verification check

**Type:** design
**Status:** Draft
**Systems:** Cache, Query, Gateway, Daemon, Plugins
**Author:** HypForge designer
**Date:** 2026-10-08
**Related:** LLP 0473, LLP 0474, LLP 0475, LLP 0321, LLP 0322, LLP 0105, LLP 0038
**Extends:** LLP 0474 (#diagnostics: existing-service full flush and migration-disabled verification reader), LLP 0475 (#t4: sequencing and proof)
**Change-set:** ollama-everyday-collection, existing T4
**Source-check:** source-check-T4-reduced-scope.json, 2026-10-08T02:09:57.765908Z; unchanged HYP-71 scope/Ready/current Phil, same correction child

@ref LLP 0473#requirements: keep the normal installed first persisted check and honest failure outcome
@ref LLP 0474#diagnostics: success still requires fresh correlated query-visible request and completed response

## Gap and reduced decision {#decision}

At product base `250a91262046c2d1a3d13ee0cddc91debf637530`, new low-volume
capture remains in spool until normal settlement. Query refresh never does not
settle it, and discovery/settlement precedes signal linkage. A deadline must not
kill a worker performing auto/always mutation. The current T4 reader uses
createKernelRuntime without bootKernel or plugin activation; its concrete write
hazard is resolveLayeredConfigForDaemon requesting grep migration.

Phil's actual-stop clarification (native inbound2dcea7f8153f8eebd783,
U090FKDAP8W/1791424687.532229) allows recording to stop when HypAware stops.
Owner T4-REDUCED-SCOPE-DISPOSITION.md and steward
T4-STOP-INTENT-REASSESSMENT.md choose the smaller existing-service path. This
revises the unaccepted Draft at `9aef6ea64ffffffa845dd1773cb80c9c95b01a31`.
The partial-spool frontier, fixed mutation-input ceilings, alternate reader
framework and mandatory drain across actual stop are withdrawn. Prior readbacks
remain historical evidence, not review of these revised bytes.

Request ordinary full flush from the current live service and confirm through
the existing query reader with migration disabled. Keep actual stop/orphan policy,
storage semantics and fresh visible committed-pair success. This extends original
T4 only, with no new request, plan, graph, listener or repair framework.

## Existing full flush and its cost {#cohort}

The service fixes dataset ai_gateway_messages and derives current aiGatewayTablePath
(proxy_messages_v5) internally from the actual storage instance. Invoke its existing
flushTable(tablePath, { force: true }); never flushAll, flushDataset, accept caller
table paths/SQL or create a second storage process. It does not settle legacy v4.
The current table contains earlier and other-client rows: shared full refresh,
not time-scoped or Ollama-only mutation.

Reuse ordinary flush locks, hooks, sequence allocation, purge/partition checks,
commit-before-progress checkpoints and full success/failure stamps without changes.
A full success may clear the ordinary failure stamp and advance full-flush freshness.
Keep the existing finite one-pass drain and possible second active rotation/drain
after recovery from a standing failure. No partial-success stamp is added.

Work is proportional to current-v5 backlog and can invoke enrichers and fallback/
history dedupe. Finite passes do not imply fixed work, duration or RSS. The withdrawn
16 MiB/eight-file/8192-row/64-entry frontier is not a requirement or admission claim;
pendingInfo is not synchronized admission. Query time predicates bound targeted
confirmation reads, not shared storage writes. Explain that explicit verification
can settle earlier/other-client pending rows through ordinary refresh, and configured
sinks may export the disclosed fixed check.

This is user-invoked, with no background sweep or status-triggered work. Measure
representative small and backlogged tables, including hooks, against direct ordinary
full flush at the same seam: rows/bytes/backlog, CPU, peak heap and latency, plus
added timers/listeners/control state. Return harmful added load before adding any
frontier or changing behavior. Performance remains a product requirement.

@ref LLP 0321#decision: use existing strict full forced-refresh semantics
@ref LLP 0322#coalesce-the-retry: retain ordinary second-active-cohort recovery and stamps

## Trusted control and service ownership {#control}

Use one fixed reserved local gateway control route/current owned processor IPC,
or the same callback on actual in-process storage. Advertise through existing
source control/details, with no persisted config/schema or new listener.
Validate current PID/run/source, recording generation, operation ID, loopback
peer, direct origin-form, Host and absence of browser Origin. Refuse absolute-form,
tunnels, redirects, remote peers, stale/replaced identity and unknown keys. Cap
body at 256 bytes and receipt at 1 KiB, with bounded operation/check metadata only:
no credentials, SQL, paths or conversation content. Never proxy/capture the receipt.

Retain one requested-operation latch per ACTUAL storage/service process lifetime,
not per source/control-handler closure. Acquire before invoking existing flush,
including time queued under ordinary storage locking. Reload/reconciliation reuses
that latch; replacing a handler cannot discard mutation ownership. While pending,
return busy without another flush, queued rerun, growing promise/listener list or
token history. Other ordinary callers retain existing scheduling: this adds at most
one requested full-flush promise to it.

Caller timeout/disconnect removes the bounded waiter, not the service's flush
promise. Keep one operation record until that actual promise resolves/rejects or
the actual service exits. Late receipts cannot produce success. Guard release by
service/operation identity; stale/replaced-child or handler receipts cannot release
another operation. Clear caller timers/listeners/IPC waiter state on every path;
no accumulated completion subscribers.

Reject new admission when recording is off, policy unreadable, shutdown begun,
or processor/run/generation unavailable or stale. Never attach, restart, resume,
change policy or rotate capture generation. A live service finishing an owned
flush after detach can expose previously captured history; it does not resume
recording. Capture append barriers remain separate from historical full settlement.
Final success requires fresh run/recording/generation agreement and the committed pair.

## Caller deadline versus actual stop {#lifecycle}

A 30-second caller timeout must not terminate the live service mutating storage.
Only the genuinely read-only query child is disposable. Live service work can
finish after the caller receives unconfirmed; its latch survives source replacement.

Actual HypAware stop, processor loss or supervisor disconnect is different.
Preserve processor.js immediate exit on IPC disconnect, gateway.js 4000 ms
stop/replacement ceiling, current sink-close initiation/order and no-orphan policy.
The check can be interrupted and must report unconfirmed. Do not restart, retain
an orphan writer, wait beyond the deadline or promise admitted commit/checkpoint
drain across stop. No new stop/join policy is added.

Baseline ordinary storage has external-termination lock/checkpoint limits. Phil's
clarification does not authorize corruption or assert crash safety. Compare retained
spool/data/locks and restart behavior against baseline termination at the IDENTICAL
existing flush seam. Only a demonstrated added hazard creates repair scope; do not
require or silently implement general cache/lock/crash recovery. Forced exit or
unconfirmed cannot count as completed flush, verify or recording-barrier success.

@ref LLP 0038#lifecycle-and-operator-behavior: retain existing supervisor and ultimate stop behavior
@ref LLP 0474#recording: detach/off barriers and old-generation suppression remain settled

## Existing migration-disabled reader and confirmation {#confirmation}

Keep current createKernelRuntime({ cacheRoot }), gateway dataset registration and
executeQuerySql with refresh never, actual installed layered config/catalog,
callerCwd, local-only/session-purge visibility and result/heap caps. Storage is lazy;
ingest-sequence writes begin at next/reserveBlock, not construction. Do not replace
kernel/query architecture or activate plugins, sources, sinks, bootKernel or writable
plugin paths in the disposable worker.

Eliminate migrateGrep:true from verify's config reads. Reuse bundled/installed
catalog discovery and buildPluginCatalog with exported resolveLayeredConfigFromDisk
(default migrateGrep:false), or one compatible read-only option on the existing
catalog resolver preserving its ordinary daemon default. This is a helper option,
not persisted config. Keep validation and owning plugin/dataset selection.
Unreadable, invalid or unsupported actual config/policy returns unconfirmed, never
guessed defaults or a visibility bypass.

Prove real imports, constructors, catalog/config resolution, dataset discovery and
cleanup non-mutating. Include legacy grep config that otherwise acquires a lock,
creates a backup and atomic-writes. Snapshot config/cache/spool/progress/allocator
and directories before/after, including a killed stalled reader. Refresh never alone
is insufficient. Parent owns kill/reap/cleanup on every child outcome; no writing
task may run there.

Keep separately bounded 30-second inference and disclosed fixed prompt. After it,
one monotonic 30-second persistence budget includes control, worker startup/config/
discovery, all waits, at most six sequential reads and six settlement attempts.
A later attempt requires the previous ACTUAL flush to settle under the SAME
deadline. No busy loop, inference retry, deadline reset or reader auto/always refresh.

HTTP completion can precede append: a first flush may finish before the fresh pair
reaches spool. Permit a later serialized flush/read within those budgets. Use both
scope.from/to and SQL time predicates across midnight, capped rows/bytes and existing
query heap limit. Only the fresh policy-visible committed request and completed new
assistant with shared request_id/token/provider/model/order passes, with a final
fresh live run/recording/generation check. Receipt, append count, HTTP, load-only
generate, old/hidden/poison rows or historical status cannot pass.

Timeout says confirmation unconfirmed and live collector work may finish; actual
stop says interrupted/unconfirmed. Distinguish completed inference from persistence.
Give explicit recovery without automatic restart, inference retry or further flush
after deadline. Off/stale/run replacement suppresses late success. Status creates
no query worker, query or settlement.

@ref LLP 0105#unknown: retain ordinary caller visibility and fail unreadable policy closed

## Existing T4 sequencing, proof and effort {#delivery}

This Draft attaches only to LLP 0475 T4. Original author retains dirty250a command/
setup/index/manifest, status/types, telemetry and verify/test edits. Designer changes
documents only. Exact committed owner actionability and fresh source-stage check
precede implementation; owner assigns precise custody/base and serial merge,
cherry-pick or author-owned rebase after readback. No automatic rebase, second writer,
independent plan/graph or implementation activation by this doc.

Reduced homes: gateway source/control and process_transport.js/type contract,
minimal processor callback wiring, existing Ollama verify.js/tests, and a narrow
existing config-resolution helper option only if needed. Latch follows actual
storage/service lifetime. Cache/spool/partition algorithm, gateway stop deadline
and daemon stop ordering need no redesign. Original change-set/task graph remains
authoritative; the existing observer only reads this extension as design.

Future proof: real split/in-process tiny fresh capture below threshold with no
helpful sink; retained history/concurrent traffic; delayed append positive/timeout;
old/hidden/poison/load-only pairs; caller timeout and repeated callers with one
actual flush/bounded waiter/eventual release; reload/replaced IPC; off/reattach/run
changes; control malformed/Host/Origin/peer/proxy/stale rejection; legacy-config
read/kill filesystem snapshots and visibility parity; actual stop/supervisor loss
unconfirmed/no restart/no orphan versus identical baseline; unchanged full-force/
coalescing/stamps/partition/sequence tests and backlog/hook CPU/heap measurement.
Existing committed-row tests are not fresh-spool proof.

T5 retains maintained README/CLIENTS/TROUBLESHOOTING incoming explanations and
normal installed CLI/SDK first persisted capture and reversible stop/resume journeys:
shared full-refresh cost, caller-timeout continuation versus actual stop, configured
sink export and honest support/privacy boundaries. Draft consultation establishes
no installed success or crash-safety claim.

CPU/memory pass: new state is one operation/one bounded waiter, fixed body/result,
finite attempts/reads, no accumulating listeners/reruns/busy loop. Existing full-flush
metadata/hook/backlog cost remains variable and needs comparison; request bounds do
not establish fixed mutation-work or RSS. Return harmful added load before inventing
a frontier/framework.

Estimate: 3-6 additional implementation/test hours beyond retained T4, plus independent
review/fixes, medium-low confidence. This replaces speculative 8-14-hour frontier/
lifecycle/framework expansion, not a deadline or implementation commitment.
After future owner activation, checkpoint within 90 minutes at real tiny control-
to-flush confirmation and non-mutating legacy-config reader proof. Return newly
demonstrated material scope/effort changes to owner/mayor before expanding.
Designer correction checkpoint is 45 minutes from actual reclaim.
