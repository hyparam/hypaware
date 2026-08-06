# LLP 0193: OpenClaw backfill denies CLI-backend turns, retiring the provider allowlist

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources
**Author:** Brendan / Claude
**Date:** 2026-08-05
**Related:** LLP 0147, LLP 0157, LLP 0158, LLP 0161, LLP 0167, LLP 0170, LLP 0172; issue #640

> The Lane B sweep's projection gate flips from a vendor allowlist
> (`{anthropic, openai}`) to a denylist of CLI-backend turns, keyed on two
> rungs: the record's `api: "cli"` mechanism marker, or a provider matching
> the known sibling-adapter prefixes. Everything else that states a provider
> projects; a record that states nothing still fails closed. Ollama and every
> future direct-API provider are captured at transcript fidelity from birth,
> which is the coverage LLP 0167 promised and the allowlist never delivered.

## Context {#context}

`PROJECTABLE_PROVIDERS = new Set(['anthropic', 'openai'])` was the fail-closed
form of LLP 0157 R10's CLI-backend exclusion: an OpenClaw turn delegated to
the `claude` or `codex` binary is recorded authoritatively by the sibling
transcript adapters (LLP 0147), and re-projecting it from the OpenClaw
session file would double-count it under the wrong `client_name`, with no
dedupe possible (the two adapters mint disjoint identities: OpenClaw's
match-key hash and prompt-hash session id versus the CLI transcript's native
UUIDs). The allowlist direction was chosen because no live OpenClaw install
was reachable at implementation time (LLP 0161 Section 10): the exact
`provider`/`api` strings a CLI-backend turn writes were unverifiable, a
denylist of guesses fails open (silent double-counting), and an allowlist
fails closed (visible `excluded_backend` events, retroactively recoverable).
LLP 0161 Section 11 named the set a living list whose first addition should
land as its own short decision LLP. This is that LLP, prompted by the first
casualty: ollama turns (issue #640), which LLP 0167's sweep-lane coverage
statement ("every OpenClaw turn is captured at least at transcript
fidelity") explicitly claimed as covered while the allowlist silently
excluded them.

### Verified stamping (live install, 2026-08-05) {#verified-stamping}

OpenClaw 2026.7.1-2 (0790d9f), real session store on a working machine.
Every assistant record in the session `.jsonl` files stamps both `provider`
and `api`; user and toolResult records stamp neither. Observed session-file
pairs:

| provider     | api                | mechanism                    |
| ------------ | ------------------ | ---------------------------- |
| `claude-cli` | `cli`              | embedded Claude Code CLI     |
| `openai`     | `openai-responses` | direct API (gateway lane A)  |
| `ollama`     | `ollama`           | direct API, native dialect   |

Two caveats the decision has to carry:

- The sibling `.trajectory.jsonl` files (which backfill does not read) stamp
  the same claude-cli turns `api: "anthropic-messages"`, so the `api` value
  is a per-file-kind convention, not a stable property of the turn. The
  pre-verification test fixtures modeled session records the trajectory way,
  which was at least once a plausible convention. A deny keyed on
  `api == "cli"` alone therefore has a single point of failure in a stamping
  convention this repo does not own.
- No codex-backend records exist in the verifying machine's session store
  (OpenClaw-driven codex rollouts exist under `agent/codex-home`, but no
  session-file records name a codex backend), so codex stamping is
  unverified. See {#verify}.

## Options considered {#options}

1. **Widen the allowlist** (add `ollama`, then each next vendor). Rejected:
   it stays a vendor list, every new OpenClaw provider needs a HypAware
   release to be captured at all, and the failure mode (silent zero rows for
   a legitimate provider) has now happened in practice. It is the inverse of
   LLP 0167's coverage statement.
2. **Deny on `api == "cli"` alone.** Rejected: correct on the verified
   binary, but rests entirely on one stamping convention (see
   {#verified-stamping}); a version that stamps CLI turns with their wire
   shape would double-count every one of them.
3. **Two-rung denylist, unknown still fails closed.** Chosen; see below.

## Decision {#decision}

A record's turn is excluded from projection when its effective backend is a
CLI backend, where CLI backend means either rung:

- `api` equals `"cli"` (the mechanism marker OpenClaw stamps on turns driven
  through an embedded CLI), or
- `provider` matches a known sibling-adapter prefix (`claude-cli`, `codex`),
  the same `SIBLING_ADAPTER_COVERAGE` list that labels the exclusion events,
  which becomes load-bearing for the decision instead of labeling only.

A record whose effective backend states no provider at all is excluded as
`unknown`, exactly as before: "we cannot tell what served this" keeps the
fail-closed treatment the allowlist was right about. Every other record
projects, whatever its provider string is (`anthropic`, `openai`, `ollama`,
and any api value OpenClaw invents next).

The effective backend is resolved over the `(provider, api)` pair as a
unit, WITHIN THE RECORD'S OWN TURN only (review finding on the first cut,
which smeared file-wide and could borrow a neighboring turn's backend when
a turn's anchor record was missing, projecting a sibling-owned prompt as an
unmergeable duplicate or silently dropping a direct-API one). A `user`
record opens a turn, every `user` record, including one adjacent to
another, since the reader drops a CLI abort's non-`message` line and merging
consecutive prompts would recreate the cross-turn borrow. Within the turn:
own pair when the record states either field, else the nearest following
stated pair, else the nearest preceding one; a turn that states nothing
resolves to no backend and is excluded as `unknown`. Exclusion writes
nothing, so a turn that was merely in flight at sweep time imports intact
on the sweep after its reply lands; a permanently anchorless turn stays a
visible exclusion rather than a guessed row (the trajectory join, issue
#659, can attribute those definitively later). Smearing the fields
independently could stitch one neighbor's `provider` to a different
neighbor's `api`, fabricating a backend no record stated. Resolution runs
BEFORE the date window is applied, so a `--since`/`--until` cut bounds what
projects but can never sever a record from its turn's anchor. The sibling
prefix match is delimiter-bounded (`codex`, `codex-mini`; not `codexcloud`).

`excluded_backend` events and the `openclaw.backfill.cli_backend_excluded`
log are unchanged in shape: both exclusion classes stay visible and
countable, with `covered_by` naming the sibling route when one is known.

`PROJECTABLE_PROVIDERS` is deleted.

## Consequences {#consequences}

- Ollama turns, and every future direct-API provider, are captured at
  transcript fidelity within the sweep interval with no HypAware release.
  LLP 0167's sweep-lane coverage statement becomes true as written.
- **Accepted residual risk (fail-open):** a sibling-captured turn stamped
  neither `api: "cli"` nor a known provider prefix would project here and
  double-count. This is not purely hypothetical: the codex backend's
  session-file stamping is UNVERIFIED (see {#verify}), so until the probe
  runs, codex coverage rests on the provider-prefix rung alone, and a codex
  turn stamped with an unexpected provider string would slip both rungs.
  The reverse risk (every new legitimate provider silently dropped) has
  materialized in practice, which is why the flip is still right. If the
  residual bites, the fix is a prefix added to `SIBLING_ADAPTER_COVERAGE`,
  plus a purge of the doubled rows.
- **Accepted residual (fail-closed):** a queued prompt (two `user` records
  answered by one assistant) attributes only the prompt adjacent to the
  reply; the earlier one is excluded as `unknown`. Queuing is unverified in
  session files, and the ambiguity against the abort case is unresolvable
  positionally; the trajectory join (#659) is the clean fix.
- The pre-verification test fixtures (`provider: 'claude-cli'` with
  `api: 'anthropic-messages'`) remain excluded via the prefix rung, so the
  suite's existing R10 assertions hold without edits.
- Live-lane (Lane A) capture for ollama is untouched: still deferred, still
  issue #640's remaining scope.

## Verify {#verify}

- **Open, pre-acceptance-run:** one OpenClaw turn on a codex backend,
  confirming its session-file record stamps `api: "cli"` (either rung
  already excludes it if `provider` starts with `codex`; the probe pins the
  mechanism marker). Record the binary version with the result here or in
  the acceptance notes.
- After upgrading an affected install, one `hyp backfill openclaw` run (or
  one sweep interval) imports the previously excluded history inside
  `window_days`; `part_id` dedupe makes the re-run safe.

## References

- LLP 0147 (CLI backends are the sibling adapters' territory)
- LLP 0157 (R10, the exclusion requirement), LLP 0158 (session-file reader)
- LLP 0161 (Sections 10 and 11: unverifiable strings, the living list)
- LLP 0167 (sweep-lane coverage statement), LLP 0170 / LLP 0172 (Lane B)
- Issue #640 (ollama capture gap; the live-lane remainder)
