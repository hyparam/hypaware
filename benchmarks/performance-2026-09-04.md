# Spool CPU and memory improvements, 2026-09-04

Implemented locally in HypAware and HypAware Server. No runtime dependencies,
wire fields, cache schemas, or persisted offset formats were changed. The server's
pre-existing diagnostics edits were preserved.

## Measurements

Synthetic data, Node v24.2.0 on macOS arm64. Each value is the median of three
fresh processes. Setup is excluded from elapsed time and CPU; peak RSS is the
whole process maximum, including setup. These measure the affected paths, not
whole-daemon savings or production throughput.

Baselines: HypAware `d42c7946`, HypAware Server `4e831c3`. Both were checked out
under `/tmp` and run with the same dependencies as their respective candidates.

| Scenario | CPU before / after | Peak RSS before / after | Result |
| --- | --- | --- | --- |
| Client flush, one 16 MiB envelope, 1,024 rows | 251.35 / 64.53 ms | 302.09 / 172.42 MiB | 74% less CPU, 43% less peak RSS |
| Client provisional read, same envelope | 217.43 / 33.98 ms | 290.12 / 132.41 MiB | 84% less CPU, 54% less peak RSS |
| Server read, 128.8 MiB backlog, 32,768 rows | 124.20 / 119.09 ms | 536.48 / 256.28 MiB | 52% less peak RSS, similar CPU |
| Server backpressure, 100 checks over 200 gateways | 1,175.67 / 569.50 ms | 58.77 / 58.88 MiB | 52% less CPU, similar peak RSS |

Run from the respective repository, one mode per fresh process:

```sh
node --expose-gc benchmarks/spool-performance.mjs flush
node --expose-gc benchmarks/spool-performance.mjs inspect
```

```sh
node --expose-gc benchmarks/spool-performance.mjs read
node --expose-gc benchmarks/spool-performance.mjs backpressure
```

Both benchmark scripts accept a second argument naming a baseline repository.
They verify row/admission counts and emit structured timing, CPU, RSS, fixture
size, and run identifiers. Server read reports its maximum returned batch size:
32,768 rows before, 2,036 after for this fixture.

## Changes and CPU/memory review

- Client `streaming-reader.js` and `spool.js`: share a chunk-fragment line reader.
  The old loops repeatedly flattened and searched an ever-growing envelope.
  Each input chunk is now searched once, and fragments are joined only when a
  complete line is available. The regression test measured 18.35 million
  characters searched for 1.05 million input characters before the fix.
- Server `ingest/spool.js` and `ingest/mover.js`: decode records from 64 KiB
  reads; return a batch at 10,000 rows or 8 MiB, completing the last record.
  Advance the durable offset after each successful cache flush. A failed later
  chunk leaves the already-committed prefix counted and the remaining suffix
  retryable. A pass stops after crossing its initial file-size snapshot, even
  if capture keeps appending during flushes.
- Server `ingest/backpressure.js`: calculate both pending-byte limits from one
  filesystem snapshot. The request still observes fresh disk state; no stale
  counter cache or invalidation machinery was introduced.

No new unbounded process cache or busy loop was introduced. Client line scanning
is linear in input size. Server read-ahead stays within 64 KiB beyond the consumed
batch, even for tiny rows. A large individual envelope/record still requires
memory proportional to that envelope/record. The backpressure gate still scans
the fleet once per request. Chunked mover commits can produce more small cache
files during a large backlog; the existing compaction path remains responsible
for combining those files. This is the cost of bounding per-flush memory.

## Validation

- New client scan-work regression failed before the fix and passes afterward.
  UTF-8 offsets, multiple envelopes, unterminated provisional tails, malformed
  input, row hashes, and resume behavior are covered by the focused tests.
- New server batch-bound and filesystem-scan regressions failed before their
  fixes and pass afterward. Tests also cover short filesystem reads, a record
  larger than the batch ceiling, tiny-row read-ahead, flush failure/retry,
  corruption, row order, and continued capture during a drain.
- Client focused streaming/cache tests pass, typecheck and declaration build
  pass, and `npm run smoke -- query_grep_roundtrip` passes.
- Client full suite: 6,060 passed, 3 skipped, 1 failed. The HTTP 421 test in
  `ai-gateway-absolute-form.test.js` fails identically on unchanged HEAD. The
  later final focused streaming run passes all 13 tests.
- Server full suite in a disposable validation copy using this client: 68 of
  71 suites pass. `grep-search.js` and `multitenancy.js` fail on existing text
  assertions and fail identically on unchanged HEAD. `preauth-abuse.js` repeats
  the failing grep suite and fails for that same reason.
- Final server HTTP smoke passes all 230 checks, including ingest, replay,
  backpressure, mover commit, and restart behavior.
- Server typecheck reports the same three existing errors in
  `plugins/github/src/dataset.js` on baseline and candidate, with no errors in
  the changed code or new tests.

The initial sandboxed suite attempts could not bind localhost. Integration
validation was rerun with localhost enabled. The shared server dependency link
was not repointed: its validation copy uses this worktree's client while the
original server checkout retains its existing installation.

## Open-PR overlap check

Checked all 15 open client PRs and all 10 open server PRs, including their changed
file lists. None touches the spool or backpressure files changed here.
[Client PR #1075](https://github.com/hyparam/hypaware/pull/1075) already covers
bounded query execution and streaming aggregates, so this work does not duplicate
that effort. The remaining open performance-related server work includes review
requirements (#417), login-flight bounds (#416), and test-runner timeouts (#339),
which address different paths.
