# LLP 0346: A client that stamps another client's `client_name` cannot be opted out; enforce it through the entrypoint its manifest claims

**Type:** Issue
**Status:** Draft
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
already carry `client_name: "claude-desktop"`, because
`classifyTranscriptEntrypoint` attributes a session to the client whose
manifest claims its entrypoint (LLP 0140), so the existing `client_name`
test already withheld those.

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

- `hyp privacy client claude-desktop local-only` now withholds Desktop's
  live rows. `hyp privacy client claude local-only` withholds what it
  withheld before, no more and no less.
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
