# LLP 0249: Proxy mode by default and the attach migration, implementation plan

**Type:** plan
**Status:** Active
**Related:** LLP 0246, LLP 0242
**Generated-by:** neutral

> [LLP 0246](./0246-proxy-mode-default-attach.design.md) is the technical
> design closing LLP 0242. This plan's central finding, verified against the
> tree rather than assumed from the design's prose: the design is already
> realized on `master` by commit `04330abb` (#794), exactly as its section 0
> states. Every file, symbol, test, `@ref` annotation, and smoke edit the
> design names exists and the section 5 gate passes (32/32 across the five
> named test files on this branch). This plan therefore schedules no rebuild
> of working code. It schedules the two things a symbol-by-symbol conformance
> pass actually found outstanding: one missing test pin (the `--json` attach
> shape the design claims is proven but no test exercises) and the corpus
> cross-links binding the design of record to the docs it covers.

## What is already built on master (verified, not planned)

Each design section was checked against the tree at `04330abb`, which is an
ancestor of this integration branch. Nothing below is a task; it is the
record of why it is not one.

**Section 2, fresh installs (LLP 0243), fully built:**

- `hypaware-core/plugins-workspace/claude/hypaware.plugin.json` line 45
  declares `"gateway_proxy_mode": true` in the claude picker row's `compose`
  block. The codex manifest declares nothing, so a Codex-only install mints
  no CA, as designed.
- `composePickerConfig` in `src/core/cli/walkthrough.js` folds the flag
  (line 973) and writes `proxy_mode: true` onto the composed
  `@hypaware/ai-gateway` entry (line 1014), `@ref`'d to
  LLP 0243#composed-default. No `listen` is written.
- The `hyp init claude` literal preset
  (`hypaware-core/plugins-workspace/claude/src/index.js` line 413) writes
  the key literally, `@ref`'d to the same anchor.
- The carry-forward merge lets a prior gateway entry own the key entirely,
  including its absence (`walkthrough.js` line 1276, `@ref` LLP
  0243#user-key-wins), pinned by `test/core/compose-picker-config.test.js`
  lines 514 and 534.
- The finale waits on `waitForLocalCa` (imported from `src/core/tls/ca.js`,
  wait seam at `walkthrough.js` line 1537) before a proxy-mode attach,
  pinned by `test/core/walkthrough-finale-ca-wait.test.js`.

**Section 3, existing installs (LLP 0244), fully built:**

- `maybeOfferProxyModeMigration` (`src/core/commands/clients.js` line 821)
  runs before endpoint resolution (line 308), never throws into the attach
  (the caller downgrades to a warning), and gates exactly as designed:
  dry-run silent; `attach all`, `--json`, and non-TTY emit the one pointer
  line (line 886); a central-layer gateway reports fleet management instead
  of prompting; the offer is keyed on the config, not the CA.
- `enableGatewayProxyMode` (`src/core/config/gateway_proxy_enable.js`) sets
  the key on the existing local entry with the LLP 0031 guarded write,
  refuses `no_gateway` and `central_managed` (line 154), restarts, waits for
  bind and CA through injectable seams (`waitForCaFn` defaulting to
  `waitForLocalCa`, lines 80 and 251), and reports every step.
- `@ref` annotations to LLP 0243/0244 anchors are present in
  `walkthrough.js`, `clients.js`, `gateway_proxy_enable.js`, the claude
  preset, and the tests. All six anchors the design and code cite
  (`#composed-default`, `#user-key-wins`, `#attach-offers`,
  `#non-interactive`, `#central-managed`, `#enable-write`) resolve in
  LLP 0243/0244. LLP 0233 already carries its `Extended-by: LLP 0244`
  forward ref (landed in #794).

**Section 5, the gate, built and green on this branch:**

`test/core/init-proxy-mode-default.test.js`,
`test/core/attach-proxy-migration.test.js`,
`test/core/gateway-proxy-enable.test.js`,
`test/core/walkthrough-finale-ca-wait.test.js`, and
`test/core/walkthrough-attach-lane.test.js` all exist and pass (32/32 on
this branch). Both named smokes were updated by #794:
`walkthrough_picker_to_first_query.js` asserts `proxy_mode: true` in the
golden composed config, and `claude_attach_detach.js` asserts the non-TTY
pointer note is the attach's only stderr line.

### The consent and refusal pins, enumerated

The consented-migration path is the delicate part of this design, so this
plan records exactly which behaviours `test/core/attach-proxy-migration.test.js`
already pins, one test each:

1. Decline: the question is asked once, default no, nothing is written, the
   attach still lands, and the re-run pointer is printed.
2. Accept: `proxy_mode: true` lands in the local config; with no daemon
   service installed the output names the daemon start as the remaining step.
3. Idempotence: with the key already set, no question and no note.
4. A client whose picker row does not declare `compose.gateway_proxy_mode`
   is never asked.
5. Central-managed gateway: no question even on a TTY, the fleet-managed
   note instead, nothing written, even beside a local entry.
6. Non-TTY: no question, exactly the one pointer line, attach unchanged
   (also pinned from the enablement side in
   `test/core/attach-enablement-state.test.js` line 286 and end-to-end in
   the `claude_attach_detach` smoke).
7. `--dry-run`: no question, no note, no write.
8. `hyp attach all`: never asks mid-run, points at the interactive command.
9. A failed accepted migration warns and the attach still succeeds in
   base-URL mode.

**The one drift found:** design section 5 claims the tests prove the
"non-TTY, `--json` and `attach all` pointer lines", but no test anywhere
passes `json: true`. The code gates on `parsed.json` correctly
(`clients.js` line 886), and the test harness already plumbs an unused
`json` opt (`attach-proxy-migration.test.js` line 76), so only the pin is
missing: a `--json` run on a TTY is the one shape whose no-prompt guarantee
nothing enforces against regression. T1 closes this.

## What remains: the task rationale

- **T1** adds the missing `--json` pin. Small and mechanical because the
  harness support already exists; it matters because `--json` on a TTY is
  the only LLP 0244 #non-interactive shape a regression could silently
  re-prompt, and a prompt inside a `--json` run would both hang scripted
  callers and corrupt the JSON contract.
- **T2** lands the corpus cross-links: LLP 0242, 0243, and 0244 predate the
  design of record and none of their `Related:` lines names LLP 0246.
  Adding the forward link is a trivial editorial fix, which the repo's LLP
  conventions explicitly permit on Accepted docs. T2 also re-verifies the
  six anchors and runs `/ref-check` over the files this change set touches,
  so the corpus lands coherent.

The two tasks touch disjoint files (one test file; three llp docs) and run
fully in parallel.

Any further drift a task worker finds between LLP 0246's prose and the tree
must become a new issue LLP, not an edit: LLP 0246 is Active and settled,
and this plan's verification already establishes the tree matches it
everywhere checked.

## External blockers (not expressible as `deps`)

- **Merge order: `integration/proxy-mode-capture` must land first.** The
  design declares `Depends-on: proxy-mode-capture` and its section 0 cites
  LLP 0245, which exists only on that branch; `llp/0245-*.design.md` is
  absent from this branch. The *code* dependency is already satisfied
  (master carries the proxy-mode capture stack via #782 and #792), so
  neither task here is blocked; only the doc reference dangles until that
  branch merges. Merging this branch first would leave LLP 0246 citing a
  document the tree does not yet have.
- **Pre-existing unrelated failures.** The full `npm test` run on this
  branch shows a failing cluster confined to parquet/iceberg NULL semantics,
  pushdown conversion, and report rendering, none of it touched by this
  change set; #794's own commit message records the same cluster as
  pre-existing on a clean tree. Task workers should gate on the section 5
  test files plus the files they touch, not on that cluster turning green.

## Assumption stated for the record

This change set's design was written retrospectively against work that
merged to master as #794 before the design doc itself landed. This plan
takes the neutral pipeline's requirement (no plan means nothing can be
implemented) at face value and supplies the plan as the record binding the
change set together: verification of the as-built tree, plus the two
genuinely outstanding items as tasks. If a human would rather close the
change set with no tasks at all, T2 should still land somewhere; the
corpus cross-links otherwise never get written.

## Notes for implementers

- JavaScript, no semicolons; no em dashes anywhere, including in test names
  and llp doc edits.
- T1's new tests ride the existing harness in
  `test/core/attach-proxy-migration.test.js` (its `runAttach` opts already
  accept `json`); no new seams are needed. Everything runs with the
  `security` / `launchctl` seams refused or shimmed, per the LLP 0244
  consequence the existing tests in that file already honor.
- T2's edits are one line per doc on the `Related:` metadata line; do not
  touch any settled section body. Run `/ref-check llp/` (or the repo's
  ref-check skill against the touched files) before the PR.
- Neither task flips any LLP status. LLP 0242/0243/0244 stay Accepted,
  LLP 0246 stays Active.

## References

- [LLP 0246](./0246-proxy-mode-default-attach.design.md): the design this
  plan schedules, section by section
- [LLP 0242](./0242-fresh-installs-attach-base-url.issue.md): the request;
  [LLP 0243](./0243-picker-composes-proxy-mode.decision.md) and
  [LLP 0244](./0244-attach-migrates-to-proxy-mode.decision.md): its
  resolution decisions, both fully realized by `04330abb` (#794)
- LLP 0245 (`integration/proxy-mode-capture`): the predecessor design;
  see External blockers for the merge-order constraint
- `llp/0173-openclaw-two-lane-capture.plan.md`: format precedent for the
  task-graph and complexity-rating structure

## Tasks

- id: T1  branch: task/proxy-mode-default-attach/T1  deps: []  complexity: 2  -- test/core/attach-proxy-migration.test.js: add the missing LLP 0244 #non-interactive pin for the `--json` attach shape. Using the file's existing harness (its opts already plumb `json`, line 76, currently unused), add a test running `hyp attach --client claude --json` on a TTY against a proxy-capable descriptor and a key-less local gateway config, asserting: no prompt is issued (the askYesNo seam is never reached), stderr carries exactly the one pointer line `note: this install attaches claude by base URL; run 'hyp attach claude' in an interactive terminal to switch it to proxy mode`, no config write occurs (`proxy_mode` stays absent from the file on disk), and stdout remains the attach's valid JSON payload with nothing interleaved. Add a companion case proving `--json` combined with non-TTY still emits the pointer exactly once, not twice. Annotate with `// @ref LLP 0244#non-interactive [tests]: --json never prompts even on a TTY and emits exactly the pointer`. Gate: this file plus test/core/attach-enablement-state.test.js pass. No production code change is expected; if the assertion fails against `src/core/commands/clients.js` line 886's `parsed.json` gate, that is a bug to report, not a test to soften.
- id: T2  branch: task/proxy-mode-default-attach/T2  deps: []  complexity: 1  -- Corpus cross-links for the design of record: append `LLP 0246` to the `Related:` metadata line of llp/0242-fresh-installs-attach-base-url.issue.md, llp/0243-picker-composes-proxy-mode.decision.md, and llp/0244-attach-migrates-to-proxy-mode.decision.md (trivial editorial forward-refs, permitted on Accepted docs; touch only the metadata line, never a settled section body). Re-verify that the six anchors LLP 0246 and the code cite resolve: #composed-default and #user-key-wins in 0243, #attach-offers, #enable-write, #central-managed, and #non-interactive in 0244. Run the repo's ref-check skill over llp/ and the files carrying `@ref LLP 0243` / `@ref LLP 0244` annotations (src/core/cli/walkthrough.js, src/core/commands/clients.js, src/core/config/gateway_proxy_enable.js, hypaware-core/plugins-workspace/claude/src/index.js, the test files) and confirm zero broken references. Gate: ref-check clean; no test changes.
