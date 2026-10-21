# LLP 0553: NanoClaw native transcript capture

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Sources, Backfill, Privacy, Config
**Author:** Phil / Codex
**Date:** 2026-10-21
**Related:** LLP 0035, LLP 0120, LLP 0140, LLP 0306, LLP 0359, LLP 0403

## Capture {#capture}

Implement the requested NanoClaw integration as an explicitly configured,
bundled adapter. `config.root` names one absolute local installation root.
There is no guessed default root, home-directory search, inference proxy,
credential access, NanoClaw settings edit or additional runtime dependency.
The adapter registers the existing conversation storage contracts and uses
the existing Claude native parser and projector. It owns no dataset.

The first supported layout is NanoClaw v2 with a local SQLite group catalog
and Claude provider transcripts. Upstream inspected at
`nanocoai/nanoclaw@a62a8d2f53caf7afc77af5adb07dd8c0112cb434`:
`src/provider-contracts/claude.ts`, `src/provider-contracts/realize.ts`,
`src/db/agent-groups.ts`, and
`container/agent-runner/src/providers/claude-history.ts`.
Provider overlays, remote stores and older layouts are outside this contract.

Read `data/v2.db` read-only, taking only agent group id and folder. Discover
native files under `data/v2-sessions/<group>/.claude-shared/projects` including
subagent files and `.jsonl.rotated-<timestamp>` archives. Do not read the
lossy Markdown conversation archives, mailboxes, settings or credentials.

Native Claude session and message IDs remain authoritative, including across
rotation. `client_name` and `conversation_source` are `nanoclaw`; the existing
attributes object records the NanoClaw agent group ID. Do not guess a historical
NanoClaw mailbox session from its current continuation. Preserve native tool
links and the rule that only one block per API response carries usage.
Assign message positions and previous-message links before window filtering.
Do not fabricate repository identity from container paths.

## Usage carrier {#usage-carrier}

@ref LLP 0035#one-carrier [extends]: this native-only append lane uses the
first persisted block of each API response as its stable usage carrier. The
shared Claude projector retains its last-block default for every other caller.
There is no NanoClaw proxy lane whose carrier must match this adapter.

Actual CLI 2.1.296 streaming tests show assistant records persisted after the
API message delta, with finalized stop_reason and response usage repeated on
every block. A scan can fall between persisted blocks; the first block's
identity and finalized usage remain stable when later blocks appear. Moving
the carrier to the last observed block would double count under append-only
deduplication. Finalized records therefore need no later turn marker. Real
subagents never write cost-state, and crashes after response persistence can
leave the same tail in main transcripts. Both are captured and fingerprinted.

Legacy assistant records without a finalized stop_reason still wait for a
later response/user record or cost-state marker before projection. Its
cumulative usage is never imported. Incomplete JSON lines remain deferred.
Tokens and content never persisted by the upstream cannot be reconstructed.

## Privacy {#privacy}

Catalog ownership maps every transcript to its host `groups/<folder>` workspace.
That path becomes row `cwd`, so existing ignore/local-only/export rules apply
to the real workspace. An unreadable catalog or unknown shape is a visible
failure, never an empty import or a guessed workspace. Refuse symlinked or
escaping catalog, workspace and transcript paths. Read no transcripts from
the user's ordinary Claude or Desktop roots.

Refresh persistent session exclusions before each run. Check workspace ignore
policy before reading, session exclusions before projecting, and the policy
again before and after asynchronous materialization. Dropped sessions never
advance a recovery fingerprint, so explicit unignore can recover them.
Detach and `backfill.on_join=false` retain their existing kernel semantics.
`local-only` is enforced by the shared export path using the host workspace.

## Bounds {#bounds}

Discovery admits at most 1,024 groups and 10,000 directory entries, at four
directory levels under each projects root. Reject a catalog over 64 MiB,
transcripts over 16 MiB, lines over 4 MiB, and files over 20,000 lines or
20,000 chat content blocks. The block limit bounds cache-row expansion even
when a single native record holds a large content array.
Read one bounded file snapshot at a time and process records in native order.
An unfinished final line is not consumed and never advances the fingerprint.
Each scheduled run reserves at most 64 MiB of transcript reads. A deferred sweep resumes
at the deferred file, avoiding starvation. Unchanged scheduled files cost
discovery and stat calls but no body reads or projection. Fingerprints are
process-local, pruned against bounded discovery and advance only after a
complete successful write, never on dry run. Manual import ignores them and
finishes the bounded discovered file list, retaining the per-file limits and
cancellation checks. A total byte cap on an explicit import would repeatedly
return the same prefix: the next CLI process has no recovery cursor.

Recovery defaults to every five minutes and inherits the runner's retention
and provider window. Counts and error classes identify failed steps without
logging transcript content or paths. Source health reports partial/unavailable
capture. CPU is linear in discovered entries and changed source bytes; memory
is bounded by one file, its parsed/projected representations, and bounded
discovery/fingerprint maps. There is no per-token or inference-path work.

## Verification {#verification}

On 2026-10-21, the pinned upstream Claude provider ran unmodified in disposable
Docker containers with Claude Agent SDK 0.3.296 and Claude CLI 2.1.296. Only
temporary directories were mounted and external networking was disabled. A
loopback Anthropic-compatible model stub supplied deterministic responses;
the actual Claude CLI executed Read and Agent tools. The runs covered session
resume, NanoClaw's own rotation, a real subagent, delayed streaming boundaries,
and abrupt provider exit after response persistence. Observed native subagent
records are retained in the smoke fixture without private data or credentials.
Model authentication, real-provider billing, and gateway/channel delivery were
not exercised.

The initial resume/rotation run imported 15 unique parts across two sessions
and replay wrote zero rows. Follow-up tests captured between finalized blocks,
then restarted recovery and appended the rest. Five subagent parts and exact
22 input / 14 output token totals survived the restart without duplication;
the final subagent response needed no cost-state marker. These token values
come from the deterministic model stub, not a billing comparison.

NanoClaw's pinned host dependencies were installed in a temporary checkout.
Its real migration runner created data/v2.db, and its createAgentGroup API
populated the catalog used for installed-package testing. The packed HypAware
build imported 18 unique native parts across three sessions (including a
subagent), totaling 77 input / 49 output tokens. Restart and replay retained
exactly those parts. macOS used an actual, uniquely named launchd service.
Linux passed both a Node 24 container test using the repository's sandboxed
systemctl and an actual user-systemd service on hypebox (Node 24.19.0).
The real service tests exercised install, status, restart with a changed PID,
SQL over ai_gateway_messages/logs/traces, and uninstall. The test services,
containers, and temporary hypebox files were removed. Existing user services
and configuration were untouched. A complete authenticated NanoClaw host with
a gateway and messaging channel was not deployed.

Ten traditional adapter tests cover native identity, tools, usage, windows,
privacy, malformed input, snapshot mutation, rotation during a read, and
resource bounds. Five 13 MiB files force multiple scans; mixed-case paths
exposed a locale-sort/cursor-order mismatch, fixed by using the same lexical
order for both. Finalized subagents now fingerprint and skip unchanged reads.
Content-block admission is bounded before projection, closing the case where
one JSONL line could otherwise expand into hundreds of thousands of rows.
CPU and memory review found no remaining unbounded map, walk, body read, or
row expansion in the adapter. Legacy unfinished tails still retry, within the
same per-scan budget.

The NanoClaw hermetic smoke verifies actual scheduled capture, SQL, local-only
export withholding, ignore policy, incremental subagent capture across daemon
restart, and run-specific scan logs/spans. All 21 pre-existing release smokes,
typechecking, the declaration build, packaging, and LLP reference checks pass.
An unfiltered suite run reproduced the known local-only Hermes catch-up
failure and exposed a foreground-relaunch fixture race: its initial 404
scheduled a five-minute legacy backoff while the test waited only 45 seconds.
That fixture now deliberately exercises the early poll with a temporary 503
and Retry-After, leaving production polling unchanged. The relaunch tests pass.

The final full-suite run explicitly excluded only the user-confirmed local
Hermes test using --test-skip-pattern: 8,900 passed, zero failed, seven normal
skips (the excluded test is not counted by Node). Hermes code/tests remain
unchanged. The unfiltered suite is not represented as entirely green.
