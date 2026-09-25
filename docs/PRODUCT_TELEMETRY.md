# Product telemetry

[Documentation](README.md)

Enrolling with HypAware Cloud (`hyp join`, or `hyp remote login` without
`--no-forward`) automatically enables collection for that organization once
gateway enrollment completes, including existing enrollments on the next CLI
invocation or daemon start after upgrading. Standalone installations
default to **off**, and a saved `off` or `local` preference always takes
precedence. This feature has no vendor endpoint, shared secret, or registration
request.

```
hyp telemetry status
hyp telemetry enable local
hyp telemetry preview
hyp telemetry enable organization
hyp telemetry off
```

`local` retains an allowlisted preview queue without network delivery and creates
one random installation identity. `organization` requires exactly one configured
central sink with an already enrolled gateway and an HTTPS URL. Both enabling operations create new consent generations
and remove earlier pending copies. `off` removes pending copies; it does not erase
records already accepted by the receiver. A failed `off` exits nonzero and, when
collection is still in force, says that product telemetry remains enabled.
Requests already accepted remotely cannot be recalled. A running daemon needs a
restart to begin collection after opt-in; it notices disable/enrollment changes
within 30 seconds. Every send checks the effective binding before POST. Status is
also discoverable from `hyp status`.

`preview` prints the exact serialized next queued batch, or `null` if none exists.
Status includes the effective destination, collection policy, queue bytes/batches,
oldest age, coalesced dropped-record lower bound and last delivery state/time.
URLs are shown locally to the operator and never included in exported resources.

## Data and coverage

Each outer invocation emits one completion with canonical command, invocation
kind, outcome, exit classification and whole invocation duration. Nested setup
commands emit at most 16 step/transition records. Help/version do not start the
storage kernel to queue their summary. Hard kills have no completion; they are
not successes. Custom commands become `other`, unmatched input becomes `unknown`.
Argument values, SQL, paths, credentials, prompts, responses, arbitrary resource
attributes and free-text errors are excluded by construction.

Resources carry the actual loaded package version, process role, ephemeral process
UUID, OS family, architecture, Node major and production/development/test marker.
A running old daemon and an updated CLI retain separate versions. Inventory is
emitted per CLI process and at daemon start/change/daily refresh; early help and
version inventory has no adapter observations. First-party adapter observations
come from configured plugins, not a scan of client settings or arbitrary names.

Daemons sample RSS, heap used and interval CPU cores every 30 seconds. Five-minute
summaries carry a coverage-weighted average, highest observed value, latest value,
sample count and coverage. Basic sampling does not enable detailed runtime
observations. CPU uses the monotonic elapsed interval; long stalls discard missing
windows. Client/server accept up to ten minutes of interval scheduling drift and
at most eleven basic samples, with coverage capped at 30 seconds per sample.

Capture/write/export counters use explicit interval deltas. Capture means rows
accepted by the intrinsic spool, including scheduled imports; write means rows
materialized by its flush path. Export bytes and coded failures come from existing
sink work. Pending-byte and age gauges cover at most 128 spool tables observed
by this process, not every historical cache table. They are snapshots (1 ms
coverage), and their oldest age starts at first local observation. Missing stages
remain absent, not zero. No cache traversal is added. First useful-result
milestones, complete setup funnels and adapter-specific capture failure coverage
are not yet instrumented.

## Delivery and durability

`<HYP_HOME>/hypaware/product-telemetry/queue-v1` has 160 exclusive slots of at
most 32 KiB each, including local binding metadata. Thus pending payload storage
is at most 5 MiB across concurrent CLI writers. This count cap can become full
before the byte cap. Full queues drop new copies and retain a coalesced lower-bound
loss marker, not an exact loss count. Seven-day expiry runs when a collector or
sender is active; an inactive installation cannot delete files on a timer.
The local append is best effort, not fsynced on the CLI exit path. A machine
power loss can lose a local completion. Corrupt partial slots are reclaimed after
a grace period. The receiver's successful acknowledgement has stronger durability.

A daemon tries one oldest batch per 30-second tick. Without a daemon, ordinary CLI
work can attempt a previous batch while the command runs. No detached sender is
spawned. Exit cancels delivery immediately and never waits for a product network
request. The last CLI completion may stay undelivered without another invocation.

A batch retains its UUID and exact UTF-8 body across retries. Its local copy is
bound to consent generation, destination, gateway and organization. Enrollment
changes invalidate old copies; successful receipt of a new destination cannot
acknowledge an old copy. Sender passes are serialized by a process-liveness lock,
non-overlapping, have a two-second deadline and a 4-KiB response limit, and follow
persistent jittered exponential backoff plus bounded Retry-After. A 401 triggers
one refresh through the existing gateway route, without writing an old identity
over a concurrent enrollment; the refreshed token is used only for that pass.
Continued authentication refusal pauses until the next bounded attempt.

The receiver must have product reporting enabled. GET `/v1/telemetry` uses the
gateway Bearer token and advertises `schema_versions:[1]`, `max_records:100`,
`max_batch_bytes:32768`, `max_queue_age_seconds:604800`, and
`dedup_seconds:691200`. POST to the same route
carries uncompressed `{schema_version:1,batch_id,resource,records}`. The exact
schemas and finite dimensions are in `src/core/product_telemetry/contract.js`.

Only `202 {status:202,duplicate:boolean}` acknowledges durable acceptance.
400/409/413/415/422 discard permanently rejected batches. 404 or incompatible
capabilities pause rather than falling back to the old diagnostics endpoint.
429/503 honor Retry-After. Durable acknowledgement does not claim immediate Iceberg materialization.
