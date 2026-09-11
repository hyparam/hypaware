# Cursor capture implementation evidence

Status: **Native recovery implemented; release acceptance still required.**
Date: 2026-09-10. Design: [LLP 0399](../llp/0399-cursor-native-session-recovery.decision.md).

Cursor's local saved sessions now supply user messages, assistant segments,
full tool results and tool outcomes. Native hooks trigger bounded recovery and
retain the extra `beforeReadFile` observations requested by the operator.
Scheduled/manual backfill uses the same identities, so missed hooks and daemon
downtime can be recovered without adding a second conversation copy.

## Source evidence

Inspected editor 3.19.19 and isolated CLI 2026.09.08-6caf4ff. The installed old
CLI 2025.10.28-0a91dc2 was not upgraded. Controlled calls and workspace probes
were authorized; sign-in used Cursor's supported login flow. No credentials
were extracted or staged, and the global HypAware installation is unchanged.

Detailed research, source links and reproducible probes:
[Cursor capture gaps](../research/2026-09-10-cursor-capture-gaps/REPORT.md).
Sanitized hook fixtures remain under `test/fixtures/cursor/`.

The hooks deliberately summarize tiny Read/Grep results, mislabel Glob as
Grep, omit intermediate assistant segments and dynamic tool discovery, and
can report successful-looking completions for rejected CLI Shell calls.
Cursor's JSONL transcript serializer can merge thinking into ordinary text
and omit stable identities, so the adapter does not read those transcripts.
The native SQLite graph preserves richer typed and model-context records.

The candidate JavaScript reader was run read-only against exactly three
previously authorized disposable sessions, with ordinary WAL-aware SQLite:

| Store | User turns | Assistant segments | Tools | Native errors |
| --- | ---: | ---: | ---: | ---: |
| Editor `a04677b4-01ac-478d-a4ef-37ab5ddd0d9a` | 5 | 8 | 12 | 0 |
| CLI `7909a4ec-49bf-48af-bf2e-8a38a369bd6b` | 1 | 2 | 1 | 0 |
| CLI `ec2e6c5a-9456-463f-b917-7fd3f2f3a416` | 1 | 3 | 5 | 3 |

The editor includes four Read, three Glob, one Grep, two Shell and two
GetDynamicTools calls. The last CLI session includes a missing-file Read and
two genuinely rejected Shell calls. File text and matching Grep lines are
recovered. These counts agree with the independent research probes.
The final assistant timestamp is absent in exited CLI sessions; the candidate
requires matching saved model-context text for those segments.

These read-only probes verify native decoding, not a globally installed live
handler or every interactive client lifecycle.

## Implemented and verified

- Endpoint-free activation, picker, native hook attach, idempotent reattach,
  foreign hook preservation, dry run and marker-owned disk detach.
- Read-only editor format 18 and CLI SQLite version 1, committed WAL visibility,
  content hashes, bounded wire traversal and omission of system/reasoning/key data.
- Native user/step/tool identity, repeated identical messages, correct Shell
  rejection, unknown future outcomes, archive overlap and incomplete checkpoints.
- Live recovery retries, restart dedupe, queue bounds, shutdown cancellation,
  session ignore and serialization with backfill.
- Scheduled unchanged-root skips; failed/dry runs do not advance fingerprints.
  Manual backfill bypasses fingerprints and uses the existing materializer.
- Extra file observations retain delivery identity and file-scope checks.
  Native Read results receive equivalent scope checks. Local-only rows remain
  queryable and are withheld through the actual export seam.
- Inherited Claude hooks skip Cursor before configuration loading, without
  injecting context or misattributing activity to Claude.

The `cursor_capture` smoke activates Cursor without the gateway, seeds both
native store formats with open WAL connections, sends hooks, queries 18 rows,
and repeats recovery through the registered backfill command without duplicates.
It checks receive, storage, recovery and privacy telemetry. Passing run:
`smoke-cursor_capture-2026-09-10T23-22-23-505Z-52999`.
Final verification: `npm test` passed 6,570 tests with three skips. Type
checking, the `cursor_capture` smoke, file hygiene and LLP reference checks
passed. Synthetic fixtures pin the researched schema; they do not replace
the real-client acceptance procedure.

## Fresh candidate CLI acceptance, September 10

A new live probe exposed a configuration incompatibility missed by the synthetic
smoke: CLI `HooksConfigLoader.parseJSONC` removes `//` comments before parsing
JSON, even inside strings. Generated `http://127.0.0.1:...` command arguments
therefore invalidated the complete hooks file. Both the ordinary and trusted
comparison runs delivered zero callbacks. A manually triggered recovery of the
first saved session succeeded, isolating the failure to hook configuration.

The generated command now passes `127.0.0.1:<port>`; the standalone sender
restores the HTTP scheme. A regression reproducing the inspected parser failed
before the fix and passes after it. The sender also retains its full-URL input
for existing callers. This is constant bounded work with no new CPU or memory
concern.

With corrected temporary project hooks, fresh CLI session
`791944d7-dfec-4390-80a2-399226b48227` delivered eight callbacks. The real candidate
listener and storage recovered one user message, all three assistant segments,
five tools, and one extra file observation: ten distinct stored parts. The
Read result contained the complete 32-byte fixture; Grep retained matching text,
Glob retained file names, and both rejected Shell attempts became error rows.
The native assistant/tool counts match the independent filtered CLI stream.

During execution, incomplete roots and pending tools produced bounded retries.
Recovery later added the final assistant segment and settled with no pending
work or last error. Replaying saved native records added zero rows, both before
and after restarting the candidate source. Data stayed in a disposable cache;
this was a temporary project-hook test, not a global installation or proof of
all editor/interactive behavior. Editor verification remains pending.

## Additional editor history recovery

At 23:25 UTC, the latest saved turn in the scoped disposable editor session
had checkpoint time 23:15:15 UTC. It contained thirteen tools: three Read,
two Grep, two Glob, two Shell, three GetDynamicTools and one CallDynamicTool,
plus three assistant segments. A manual local recovery trigger persisted the
whole six-turn session as 42 unique parts: six user messages, eleven assistant
segments and twenty-five tools. Replay wrote zero additional rows. The combined
editor/CLI test cache contained 52 unique parts and no duplicate identities.
Full native results were retained; unverified editor Shell/dynamic-call outcome
variants correctly remained unknown rather than being labeled successful.

The operator confirmed that the 23:15 UTC (4:15 p.m. local) turn was the
intended test batch. All thirteen tools and three assistant segments in that
batch were recovered. No new editor callback had reached the candidate
listener: this verifies saved-session recovery, while live editor delivery
still requires a fresh run after attachment. The temporary listener was stopped
and the disposable workspace hook file restored byte-for-byte afterward.

## Remaining limits

[Release acceptance](ACCEPTANCE.md#cursor_editor_cli_capture) still covers
installed handler behavior, editor/interactive/headless modes, interruption,
resume, regeneration, upstream format drift and sustained resource measurements.
Native storage is an internal version-specific interface, not a public API.
Unknown required formats and incomplete/oversized graphs fail with fixed safe
diagnostics. A session beyond discovery/graph bounds is not fully recoverable.

Assistant identity assumes a request's typed step ordinal remains stable.
Rewrites within the same request/ordinal are not a revision history. CLI saved
model-context corroboration is stronger than typed streaming text alone, but
all upstream finality behavior has not been established. No orphan blobs are
scanned. Deleted/pruned data, standalone shell turns, external user-text blobs,
complete subagent graphs, cloud agents, Tab and Cmd+K are outside coverage.

No normalized token usage is emitted. One observed stream reported input 17,601
and cache reads 18,304, so naive subtraction would be invalid. Hooks no longer
persist response rows or raw token frames. Provider is unknown; native editor
and CLI rows have their actual frontend, while extra file observations keep an
unknown frontend when hooks supply no discriminator.

Explicit session IDs are required for Cursor session ignore/status commands.
Multi-root hooks are refused because the row/export contract has one cwd.

## CPU and memory assessment

The implementation adds no runtime dependency. It bounds hook bodies (1 MiB),
HTTP admission (four requests), pending recovery (64 sessions), attempts (three),
and each native graph (4,096 blobs, 32 MiB total, 1 MiB per record). Discovery
limits and fixed diagnostics prevent unbounded catalog scans. Unchanged roots
skip graph decoding and storage dedupe. Metadata fingerprints retain at most
1,000 scheduled roots and 64 live roots. Writers and policy caches are bounded
or retired between passes; no conversation contents remain in adapter caches.

The CPU/memory pass found no unbounded new queue or lifetime content retention.
Synchronous bounded SQLite/parsing can pause the event loop for large graphs,
and shared dedupe still scans waiting data. Hook process overhead, large-session
latency and sustained heap use remain measurements for release acceptance.
