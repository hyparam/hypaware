# LLP 0192: Unattributed rows escape the client opt-out; fail closed pending an attribution decision

**Type:** Issue
**Status:** Draft
**Systems:** Sinks, Usage-Policy, Cache
**Author:** Brendan / Claude
**Date:** 2026-08-05
**Related:** LLP 0188 (#enforcement-scope: the two rules this row class falls between), LLP 0151 (#body-is-a-codex-signal: why the codex projector refuses to guess), LLP 0115 (#desktop-rows-are-distinguishable: the claude projector's UA fallback), LLP 0175 (live-capture misattribution)

> Extends [LLP 0188 §enforcement-scope](./0188-enrolled-default-sync-with-client-optout.decision.md#enforcement-scope):
> the residual it stated ("an opt-out is only as good as the `client_name`
> on the row") turned out to be systematic for the raw picker rows, not
> incidental. This issue lands an interim fail-closed rule at the export
> seam and defers the real fix (attribution at capture) to a future
> decision LLP.

## The gap {#gap}

LLP 0188's export-seam enforcement has exactly two rules, and a row can
fall between them:

1. **Per-row** (`shouldWithhold`): for a dataset that declares an
   `attribution_column` (today only `ai_gateway_messages`, column
   `client_name`), each row's value is matched against the opted-out
   picker source ids. The match requires a non-empty string, so a null
   or empty value never matches and the row ships.
2. **Dataset-scoped** (`shouldWithholdDataset`): a dataset with *no*
   attribution column is withheld wholesale when every contributing
   source is opted out. The rule turns itself off for any dataset that
   *has* an attribution column.

A row in an attributed dataset whose attribution value is null is
invisible to rule 1 and exempt from rule 2. It always ships, whatever
the opt-out store says.

This is systematic, not incidental, for the raw gateway picker rows
(`raw-anthropic`, `raw-openai`), because the null is itself the product
of settled attribution decisions:

- The codex projector stamps `client_name` only on transport-level
  Codex evidence, else leaves it undefined, so an unrelated client can
  never masquerade as a known one (LLP 0151 #body-is-a-codex-signal).
  All raw OpenAI-dialect traffic is therefore unattributed.
- The claude projector's fallback stamps every non-Desktop
  Anthropic-dialect exchange `client_name: 'claude'` (LLP 0115), so raw
  Anthropic traffic is *misattributed* rather than null: opting out
  `raw-anthropic` withholds nothing, and opting out `claude` also
  withholds raw API traffic. The same defect class through the other
  door.

Consequence: the sync menu (LLP 0190 #sync-gate) shows a checkbox for
`raw-anthropic` and `raw-openai` that does not do what it says. The
whole conversation history of every unidentified app ships regardless,
because attribution is decided by how traffic arrives, so entire
conversations are unlabeled end to end, never scattered rows.

## Interim decision: fail closed at the seam {#fail-closed}

Until attribution is fixed at capture, the export seam withholds an
unattributed row (no usable string in the dataset's attribution column)
whenever any picker source whose plugin **declares** that dataset
(`contributes.datasets`) is currently opted out
(`shouldWithholdUnattributed`).

The arming set is deliberately the declared owners, and for the bundled
catalog that is exactly the raw gateway rows: `ai_gateway_messages` is
declared by `@hypaware/ai-gateway` alone, so its owners are
`raw-anthropic` and `raw-openai`. The client plugins (claude, codex,
openclaw, hermes) write into the dataset through their projectors but
declare no `datasets`, so **a client-only opt-out does not arm this
rule** - and that is the intended reading, not an accident: an
unattributed row is, in practice, raw traffic (a request with no client
evidence is what the raw rows exist to capture), so the raw rows' own
sync state is the right governor. A user who opts out only `codex` gets
every codex-labeled row withheld by the per-row rule; the unlabeled
rows they left syncing belong to raw sources they left checked. The
residual: a known client's row that arrives with its metadata lost is
unattributed and ships unless a raw row is opted out - that class rides
with the misattribution residual (LLP 0175 and the `'claude'` fallback
above) and belongs to the deferred decision. A test binds this arming
set to the real bundled manifests so drift surfaces as a failure here,
not as silent scope change.

The cost, stated rather than hidden: within its arming set this
over-withholds - one raw-row opt-out withholds every unattributed row,
including traffic from an app the user never thought about. And because
`readRowsSince` is the shared export read seam, a withheld row vanishes
from local `local-fs`/iceberg exports too, not only the central forward
(pre-existing LLP 0188 semantics, named here because this rule widens
what is withheld). With no opt-outs standing, nothing changes.

## Deferred decision: attribution of last resort {#deferred}

The real fix is at capture, not at the seam: stamp unclaimed traffic
with the gateway upstream it arrived through (`raw-anthropic` /
`raw-openai`), so the labels match the picker source ids the opt-out
store keys on and the existing per-row rule simply becomes correct.
The exchange input already carries `upstream`, so the data exists at
projection time.

That is deliberately not decided here because it reopens settled ground
and needs its own decision LLP:

- LLP 0151's refusal to guess (the masquerade defense) must survive:
  a last-resort label names the capture route, never a real client.
- The claude projector's `'claude'` fallback (LLP 0115/0133 era) would
  change for generic Anthropic SDK traffic, moving rows that queries,
  reports, the context graph, and settlement enrichers currently group
  under `claude`.
- Already-recorded rows keep their null/`'claude'` labels; the decision
  must take a migration stance (relabel, or accept the residual for
  pre-fix data).

When that LLP lands and every writer populates the attribution column,
this issue's seam rule stops firing on new data by construction; it
stays as the backstop for historical rows unless the migration stance
retires it.

## Consequences {#consequences}

- `createSourceWithholdResolver` gains `shouldWithholdUnattributed`,
  and `readRowsSince` routes rows without a usable attribution value
  through it (same drop-but-advance continuation semantics).
- The `usage_policy.export_drop` event counts these drops separately
  (`dropped_unattributed_row_count`), so over-withholding in the field
  is observable rather than inferred.
- A client-only opt-out (`codex`, `claude`, `openclaw`, `hermes`) does
  not arm the rule; only a raw-row opt-out does. See #fail-closed for
  why that is the intended scope.
- `raw-anthropic` opt-outs still leak through the `'claude'`
  misattribution (the rows are labeled, just wrongly); only the
  attribution decision fixes that half.

## References

- LLP 0188, LLP 0151, LLP 0115, LLP 0175, LLP 0190
- `src/core/cache/source-withhold.js`, `src/core/cache/storage.js`
  (`readRowsSince`), `hypaware-core/plugins-workspace/codex/src/exchange-projector.js`,
  `hypaware-core/plugins-workspace/claude/src/anthropic.js`
- PR #629 review round 1/2, residual finding R3
