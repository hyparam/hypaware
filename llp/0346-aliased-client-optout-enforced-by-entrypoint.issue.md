# LLP 0346: A client that stamps another client's `client_name` cannot be opted out; enforce it through the entrypoint its manifest claims

**Type:** Issue
**Status:** Draft
**Extended-by:** LLP 0356 (the request for the capture-side decision that retires the residual recorded in #local-agent-residual below)
**Systems:** Sinks, Usage-Policy, Cache
**Author:** Phil / Claude
**Date:** 2026-09-01
**Related:** LLP 0188 (#opt-out, #enforcement-scope: the decision this defect breaks the enforcement half of), LLP 0133 (#attribution: why Desktop rows carry `client_name: "claude"`), LLP 0140 (#manifest-declares-ownership: the entrypoint-ownership declaration this reuses), LLP 0192 (the sibling residual, null attribution), LLP 0175 (live-capture misattribution)

> Extends [LLP 0188 §opt-out](./0188-enrolled-default-sync-with-client-optout.decision.md#opt-out):
> the store is keyed by picker source id and the seam tests those ids
> against the row's `client_name`. For one shipped picker id those two
> key spaces are, by an earlier and still-correct decision, different
> values. This issue lands the seam-side enforcement; it changes nothing
> the decision settled.

## The gap {#gap}

The opt-out store holds **picker source ids**
(`<state>/usage-policy/client-sync.json`, LLP 0188 #opt-out). The export
seam tests them against the dataset's declared `attribution_column`,
which for `ai_gateway_messages` is **`client_name`**
(`src/core/cache/source-withhold.js`, `src/core/cache/storage.js`). The
rule is only sound where the two key spaces agree.

Across the shipped catalog they agree everywhere but one place:

| picker id | `client_name` on its `ai_gateway_messages` rows |
| --- | --- |
| `claude` | `claude` |
| `codex` | `codex` |
| `opencode` | `opencode` |
| `openclaw` | `openclaw` |
| `hermes` | `hermes` |
| `otel` | contributes no row to this dataset (its own datasets declare no attribution column, so LLP 0188 #enforcement-scope's dataset-scoped rule covers it) |
| `raw-anthropic`, `raw-openai` | null (the LLP 0192 residual, already fail-closed) |
| **`claude-desktop`** | **`claude`** on the live route |

`claude-desktop` is a real picker id with a real picker row, so
`hyp privacy client claude-desktop local-only` writes a real entry and
reports success. But Desktop delegates inference to its embedded CLI, so
its live rows deliberately land under `client_name: "claude"` with a
Desktop-owned `entrypoint` (LLP 0133 #attribution). The entry can never
match a row. The scheduled tick keeps forwarding Desktop conversations to
the org server while the machine owner believes the client is local-only,
and the failure is silent on both sides.

Only the **live** route was unenforceable. Desktop's *backfilled* rows
already carry `client_name: "claude-desktop"`, by whichever of LLP 0140's
two admission rules applies to where the session was found: a session in
the shared `~/.claude/projects` tree is attributed by
`classifyTranscriptEntrypoint` to the client whose manifest claims its
entrypoint (LLP 0140 #manifest-declares-ownership), and a session inside
the `Claude-3p` container is attributed by `classifyContainerSession` to
the container's root whatever its tag says (LLP 0140
#container-root-owns, `DESKTOP_3P_CONTAINER_OWNER`). Either way the
existing `client_name` test already withheld those.

## The decision {#entrypoint-refinement}

**Read the second attribution axis the
rows already carry.** A row's `entrypoint` is matched against the
`contributes.client.transcript_entrypoints` declarations the catalog
already folds (LLP 0140 #manifest-declares-ownership, the same
declaration the backfill admission gate reads). When that value is
claimed by a client whose name is an **opted-out picker source id**, the
row is withheld, on the same drop-but-advance terms as every other seam
rule (LLP 0070 #incremental). The column is forced into the export scan
exactly as `cwd` and the attribution column are, so no caller's `columns`
projection can bypass it.

Two constraints make this a fix rather than a second defect:

1. **Additive, never a relaxation.** The `client_name` test is unchanged
   and runs first; the entrypoint test can only add withholding. Opting
   out `claude` therefore still withholds every `client_name: "claude"`
   row, Desktop's included, exactly as before. That is deliberately
   wider than "Claude Code", and it is the safe direction: it is what
   an existing opt-out already does, and narrowing it would start
   shipping rows a user had already been told stay local.

2. **Scoped to the clients that declare entrypoint ownership.** The
   `entrypoint` vocabulary is per-client, not global: hermes stamps its
   session source, and its interactive values are literally `cli`, `tui`,
   `cron`, while the claude client claims `cli` and `sdk-cli`. Reading an
   entrypoint as an ownership claim on a row whose own `client_name`
   belongs to a client that declares no ownership would withhold hermes
   rows because `claude` is opted out: a different broken promise, not a
   fix. The scope is therefore the map's *value* side (the set of
   declaring clients), which across the shipped catalog is exactly
   `{claude, claude-desktop}`. That pair is the whole blast radius.

Rejected: **mapping picker ids to `client_name` values directly**
(`claude-desktop` -> `claude`). It is the obvious repair and it is
wrong: `claude` and `claude-desktop` would become the same key, so
opting out one would silently withhold the other's rows.

Rejected: **re-keying the store on `client_name`** (LLP 0188's other
named option). It cannot represent `claude-desktop` at all, which is the
one case that needs representing, and it would silently rewrite a
privacy store whose entries a user authored.

Rejected: **a new manifest field, config key, or row column** naming the
alias. Nothing needed adding: `entrypoint` is an existing column and
`transcript_entrypoints` an existing declaration, and a third key space
would be a third thing to keep in agreement with the other two.

## Consequences {#consequences}

- `hyp privacy client claude-desktop local-only` now withholds the live
  rows whose `entrypoint` is one Desktop's manifest claims
  (`claude-desktop`, `claude-desktop-3p`). `hyp privacy client claude
  local-only` withholds everything it withheld before; the
  container-drift note below is the one case where it can now withhold
  more.
- <a id="local-agent-residual"></a>**The refinement does not reach the
  current attached-Desktop build.** Desktop app 1.13576.0 / embedded CLI
  2.1.177 runs each conversation in a per-session sandbox home inside its
  `Claude-3p` container and tags the transcript
  `entrypoint: "local-agent"` (LLP 0133 #attribution); the live gateway
  route copies that value onto the row (`assignTranscriptIdentity`).
  Desktop's manifest deliberately does not claim `local-agent`: it names
  a CLI mode, not a client, it drifted to `local-agent-v2` within a week,
  and LLP 0140 #container-root-owns rules that a container value cannot
  carry consent. So on that build a `claude-desktop`-only opt-out still
  ships the live rows, for the same reason the no-`entrypoint` residual
  below does, and only the capture-side attribution fix LLP 0192 defers
  retires it. The values this issue does enforce are
  `claude-desktop-3p` (LLP 0133's first live test) and `claude-desktop`
  (un-attached Desktop, shared tree). What the pins actually catch:
  `test/core/source-withhold-export-drop.test.js` fails if the seam
  starts withholding an unclaimed or absent `entrypoint`, and the
  catalog pin in `test/core/source-withhold-build.test.js` fails if a
  manifest ever claims `local-agent`. Neither fails on the capture-side
  fix itself, which changes what capture writes into `client_name`
  rather than anything the seam reads, so retiring the residual that way
  means deleting these pins deliberately.
- The scoping set is `{claude, claude-desktop}`, so a row carrying
  `client_name: "claude-desktop"` also has its `entrypoint` read as an
  ownership claim. A container session whose tag drifts to a value the
  `claude` client claims (`cli`, `sdk-cli`) would then be withheld by a
  `claude`-only opt-out even though the row is Desktop's. That is
  over-withholding, the safe direction, and it is the price of deriving
  the scope from the manifests instead of hardcoding the one aliasing
  direction LLP 0133 documents.
- A Desktop row that reached the cache with **no** `entrypoint` (an
  exchange the projector could not correlate to a transcript) still
  ships under a `claude-desktop`-only opt-out. It is indistinguishable
  from a Claude Code row at the seam, and the LLP 0192 fail-closed rule
  does not reach it because it is attributed, just not to Desktop. This
  residual is stated, not hidden; the capture-side attribution fix that
  would retire it is the same one LLP 0192 defers.
- The scoping rule is load-bearing and invisible in the data: a future
  client that declares `transcript_entrypoints` joins the namespace and
  its rows become subject to entrypoint reinterpretation. The pinned
  catalog test in `test/core/source-withhold-build.test.js` fails when
  that set changes, so the decision gets revisited rather than drifting.
- Not fixed here, and deliberately: `hyp sync --history`'s pre-send gate
  (`src/core/commands/sync.js`) reads the same store and presents it as
  an authoritative refusal. It leaks nothing the daemon was not already
  shipping, and now that the seam enforces, it is consistent with it.

## References

- LLP 0188, LLP 0133, LLP 0140, LLP 0192, LLP 0070
- `src/core/cache/source-withhold.js` (`shouldWithholdEntrypoint`,
  `entrypointColumnFor`), `src/core/cache/storage.js` (seam),
  `src/core/runtime/source_withhold.js`
  (`clientEntrypointOwnersFromCatalog`),
  `src/core/backfill/entrypoint_owner.js` (`resolveEntrypointOwners`,
  reused), `test/core/source-withhold-export-drop.test.js`,
  `test/core/source-withhold-build.test.js`
