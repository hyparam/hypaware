# LLP 0356: Attributing an embedded CLI's exchange to the client that launched it

**Type:** RFC
**Status:** Draft
**Systems:** Sources, Sinks, Usage-Policy, Cache
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-02
**Related:** LLP 0188 (#opt-out, #enforcement-scope: the promise this class of
row escapes), LLP 0346 (#entrypoint-refinement, #local-agent-residual: the
seam-side half that shipped and the residual it recorded), LLP 0133
(#attribution: the decision that live Desktop rows carry `client_name:
"claude"`), LLP 0140 (#container-root-owns, #manifest-declares-ownership,
#fail-open-on-unknown), LLP 0192 (#fail-closed, #deferred: the sibling
deferral this one is repeatedly pointed at), LLP 0115
(#desktop-rows-are-distinguishable); hyparam/hypaware#1168,
hyparam/hypaware#1172, PR #1169

> `hyp privacy client claude-desktop local-only` prints "future
> claude-desktop rows stay on this machine" and, on the Desktop build users
> are running, still ships every live Desktop conversation to the org server.
> PR #1169 (LLP 0346) closed the structural half of this: the export seam now
> reads a row's `entrypoint` as an ownership claim. It could not close the
> data half, because the shipping build tags its transcripts with a value no
> manifest claims, and LLP 0346 #local-agent-residual says so in as many
> words: "on that build a `claude-desktop`-only opt-out still ships the live
> rows ... only the capture-side attribution fix LLP 0192 defers retires it."
>
> Three documents now point at a capture-side decision that does not exist
> (LLP 0346 #local-agent-residual and #consequences, LLP 0192 #deferred, and
> the scope note on issue #1168). This document is the request for it. It
> states what has to be settled, carries the reproduction, and puts the
> options up with their costs. It decides nothing, and it reopens nothing
> that LLP 0133, LLP 0140, or LLP 0346 settled.

## Context {#context}

Claude Desktop, when attached, does not call the gateway itself. It boots a
separate `Claude-3p` identity and runs each conversation's **embedded Claude
CLI** in a per-session sandbox home, so the traffic arrives with the CLI's
`claude-cli/<version>` User-Agent (LLP 0133 #attribution). Two consequences
follow, and both are already decided:

- `claudeClientName` stamps `claude-desktop` only off a `Claude-Desktop/`
  User-Agent (LLP 0115 #desktop-rows-are-distinguishable). That branch never
  fires for an attached Desktop, so the live row lands
  `client_name: "claude"`. LLP 0133 #attribution states this as the design:
  "Query Desktop activity by entrypoint; the UA-stamping projector branch is
  dead code for this route."
- The row's `entrypoint` is copied off the matched transcript line
  (`assignTranscriptIdentity`). On app 1.13576.0 / embedded CLI 2.1.177 that
  value is `local-agent`, and it drifted to `local-agent-v2` within a week.
  Desktop's manifest deliberately claims neither: a container session belongs
  to its root, not its tag (LLP 0140 #container-root-owns).

The per-client sync opt-out is keyed on picker source ids and enforced at the
export seam against `client_name` (LLP 0188 #opt-out) and, since PR #1169,
also against `entrypoint` through the manifest-declared ownership map
(LLP 0346 #entrypoint-refinement). An attached-Desktop live row on the
shipping build matches neither axis.

## Reproduced evidence {#evidence}

### The seam, against the real bundled catalog {#evidence-seam}

`createSourceWithholdResolver` built from `discoverBundledPlugins()` at
`01a6c661`, with `claude-desktop` the only opted-out source, asked for each
row shape an attached or un-attached Desktop actually produces:

```
entrypoint owners: cli -> claude, sdk-cli -> claude,
                   claude-desktop -> claude-desktop, claude-desktop-3p -> claude-desktop

SHIPS     client_name="claude"          entrypoint="local-agent"        attached Desktop, build 1.13576.0
SHIPS     client_name="claude"          entrypoint="local-agent-v2"     attached Desktop, drifted tag
WITHHELD  client_name="claude"          entrypoint="claude-desktop-3p"  attached Desktop, LLP 0133 first live test
WITHHELD  client_name="claude"          entrypoint="claude-desktop"     un-attached Desktop, shared tree
SHIPS     client_name="claude"          entrypoint="cli"                Claude Code (correct)
WITHHELD  client_name="claude-desktop"  entrypoint=null                 backfilled Desktop / Desktop UA
```

The two rows that ship are the only two shapes the current attached-Desktop
build produces live. The opt-out is written, reported, and unenforceable.

### The two routes disagree about the same session {#evidence-disagreement}

This is the part neither LLP 0346 nor LLP 0192 records, and it is the
strongest argument that something here is a defect rather than a taste
question. One 3p container session, captured twice:

- **Backfill** classifies it by the root it was found under, so it is
  imported as `client_name: "claude-desktop"` (`classifyContainerSession`,
  `DESKTOP_3P_CONTAINER_OWNER`, LLP 0140 #container-root-owns). Pinned by
  `test/plugins/claude-desktop-3p-transcripts.test.js`, "backfill imports a
  3p sandbox session and attributes it to the configured owner".
- **Live capture** of the same session's exchanges stamps
  `client_name: "claude"` (`claudeClientName`, LLP 0133 #attribution).

So the machine already holds one rule for container ownership and applies it
on one route only. Whether that asymmetry is intended is the first question
below.

### The information the seam does not have {#evidence-information}

`local-agent` cannot be told from a future unclaimed Claude Code entrypoint
by anything on the row. It is a **CLI mode**, not a client: the same embedded
CLI in the same mode launched by something other than Desktop would tag its
transcript identically. The fact that separates them is *where the transcript
was found*, and that fact exists only at capture: `loadTranscript` reaches
the 3p roots on a shared-tree miss (`desktop3pDirsCache`,
`readSessionFromDirs`) and, on the hook-written branch, holds the
`transcript_path` outright. It returns `TranscriptEntry[]` and drops the
provenance. Threading it out is small. Deciding what to do with it is not.

## The questions to settle {#questions}

1. **Does container ownership apply to the live route?** LLP 0140
   #container-root-owns rules that a session inside another client's private
   container belongs to that container's client whatever its tag says. It was
   written for backfill admission. Either it is a general rule about what a
   session *is*, in which case the live route is out of compliance, or it is
   an admission rule about reading foreign directories, in which case the live
   route is correct and the opt-out needs a different answer.

2. **What does `client_name` name?** Today it is not one thing: the process
   that made the HTTP call (the live route's answer, per LLP 0133
   #attribution), or the client whose session it is (the backfill route's
   answer, per LLP 0140). LLP 0188 keyed a privacy promise on it and LLP 0190's
   sync menu shows it to users as a client checkbox, both of which read it as
   the second. Any option below is a choice between those two readings.

3. **What happens to rows already recorded?** LLP 0192 #deferred names this
   and does not answer it: "Already-recorded rows keep their null/`'claude'`
   labels; the decision must take a migration stance (relabel, or accept the
   residual for pre-fix data)." The same stance is needed here, and it is
   sharper, because these rows are already on the org's server: a relabel
   changes local grouping but recalls nothing (LLP 0188 #no-retroactive-ship).

4. **What breaks downstream, and is that a cost or the point?** LLP 0133
   #attribution told readers to query Desktop by entrypoint. Moving these rows
   to `client_name: "claude-desktop"` moves them in queries, usage reports,
   the context graph, `hyp status` capture health, and settlement enrichers.
   Some of those become more correct and some become discontinuous mid-series.

## Options {#options}

### A. Attribute at capture, by the transcript's container root {#option-a}

When the transcript that gave a live exchange its identity was found under a
Desktop 3p container root, stamp `client_name: "claude-desktop"`, exactly as
backfill already does for the same session. Reuses
`DESKTOP_3P_CONTAINER_OWNER`; adds no column, key, or manifest field.

- Fixes the reported defect at the source: the row then matches the opt-out
  on the existing `client_name` axis, and LLP 0346's entrypoint refinement
  becomes belt-and-braces rather than the only line of defence.
- Ends the two-route disagreement in #evidence-disagreement, which also
  removes a settlement hazard: today a session's live and backfilled rows
  carry different `client_name` values.
- Survives the tag drift that defeated every value-based approach, because it
  keys on the container path, which drifted too but is already tracked in one
  place (`claudeDesktop3pSessionRoots`).
- **Cost:** it reverses what LLP 0133 #attribution states, so it needs that
  document's forward-ref and a decision LLP of its own. It answers question 3
  with a migration stance. It moves rows in every consumer named in question
  4. It also leaves a hole where the live route matched no transcript at all
  (the finalize race): those rows have no provenance to key on and keep
  shipping, which is the same residual LLP 0346 #consequences already records
  for a Desktop row with no `entrypoint`.

### B. Claim the container values in Desktop's manifest {#option-b}

Add `local-agent` (and each observed drift value) to
`contributes.client.transcript_entrypoints` on `@hypaware/claude-desktop`.
One-line manifest edit; the seam then withholds through the machinery PR
#1169 already shipped.

- **Cost, and it is concrete rather than aesthetic:** `transcript_entrypoints`
  is not a withholding list, it is the backfill admission map. Claiming the
  value makes `classifyTranscriptEntrypoint` attribute *any* session tagged
  `local-agent` in the **shared** `~/.claude/projects` tree to
  `claude-desktop`, and gate it out entirely when Desktop is not configured
  (LLP 0140 #gate-before-projection). That silently drops history a user opted
  into. LLP 0346 rejected this for the same reason and added a pin against it
  (`test/core/backfill-entrypoint-owner.test.js`), and the value has already
  drifted once, so the list is a per-release chase. Splitting the two uses
  apart means a second declaration, which LLP 0346 also rejected: "a third key
  space would be a third thing to keep in agreement with the other two."

### C. Fail closed at the seam on an unclaimed entrypoint {#option-c}

Mirror LLP 0192 #fail-closed one axis over: when a row's `client_name` is in
the entrypoint-declaring namespace (`{claude, claude-desktop}`) and its
`entrypoint` is present but claimed by nobody, withhold it if any client in
that namespace is opted out. No manifest edit, no capture change; `local-agent`
and every future drift are covered at once.

- **Cost:** it cannot discriminate, by #evidence-information. Under a
  `claude-desktop`-only opt-out, the first Claude Code release that ships a
  new entrypoint value silently stops syncing every Claude Code row, and
  withholding is drop-but-advance, so that data is never exported. The trigger
  is upstream and invisible to the user. It also contradicts the pin LLP 0346
  placed deliberately ("fails if the seam starts withholding an unclaimed or
  absent `entrypoint`"). Confining it to *present* values keeps the no-
  `entrypoint` fallback rows syncing, which narrows the blast radius but does
  not remove it.

### D. Stop printing the guarantee {#option-d}

Leave enforcement alone and change what `hyp privacy client <x> local-only`
promises (`src/core/commands/policy.js`), so the CLI does not assert something
the seam cannot keep.

- **Cost:** a warning specific enough to be useful has to name which clients
  alias, and nothing the CLI can reach declares that. `DESKTOP_3P_CONTAINER_OWNER`
  is a plugin internal, and a new declaration is the third key space LLP 0346
  rejected. A generic softening ("rows attributed to X") weakens the message
  for the clients where the promise is true and tells the Desktop user
  nothing. Worth considering only as a rider on A or C, or as the fallback if
  this document's answer is "accept".

### E. Accept and document {#option-e}

Record the residual as permanent, and say in the docs that an attached
Desktop's live conversations cannot be kept local-only.

- **Cost:** LLP 0188 #opt-out is a privacy promise, and this leaves a shipped
  command that reports success and does nothing. Only defensible if the
  answer to question 1 is that container ownership genuinely does not apply
  live, and then #option-d becomes mandatory rather than optional.

## What this document does not decide {#not-decided}

- Nothing here changes what LLP 0346 shipped. The entrypoint refinement is
  correct for every value a manifest claims and stays whichever option wins.
- Nothing here reopens LLP 0140 #fail-open-on-unknown. Backfill admission and
  export withholding fail in opposite directions on purpose, and #option-b is
  rejected precisely because it would couple them.
- The sibling deferral in LLP 0192 #deferred (labelling raw traffic by its
  gateway upstream) is a different question with a different arming set. It
  shares question 3, and whoever answers one should read the other, but they
  are not one decision.
- Issue #1172 item 2 (symmetric-namespace over-withholding) and item 3 (the
  context-graph datasets that declare no `attribution_column`) are out of
  scope. Item 2 retires with #option-a; item 3 is an unverified investigation.

## References

- LLP 0188, LLP 0346, LLP 0133, LLP 0140, LLP 0192, LLP 0115, LLP 0190
- `src/core/cache/source-withhold.js`, `src/core/runtime/source_withhold.js`,
  `src/core/cache/storage.js` (the export seam),
  `src/core/commands/policy.js` (the message)
- `hypaware-core/plugins-workspace/claude/src/anthropic.js`
  (`claudeClientName`),
  `hypaware-core/plugins-workspace/claude/src/transcripts.js`
  (`claudeDesktop3pSessionRoots`, `DESKTOP_3P_CONTAINER_OWNER`,
  `loadTranscript`),
  `hypaware-core/plugins-workspace/claude/src/backfill.js` (the container
  branch), `src/core/backfill/entrypoint_owner.js`
- `test/plugins/claude-desktop-3p-transcripts.test.js`,
  `test/core/source-withhold-export-drop.test.js`,
  `test/core/source-withhold-build.test.js`,
  `test/core/backfill-entrypoint-owner.test.js`
- Issues #1168, #1172; PR #1169
