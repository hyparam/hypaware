# LLP 0534: Status notice for managed assets outside update coverage

**Type:** Spec
**Status:** Accepted
**Systems:** CLI, Daemon, Onboarding
**Author:** Phil / HypForge
**Date:** 2026-10-18
**Extends:** LLP 0457 #update-installs, LLP 0458 #attached-only
**Related:** LLP 0138

## Request {#request}

LLP 0458 limits update-time installation to clients the settings-marker probe
reports as attached. A client HypAware once wrote skills or agents for, but
which that probe does not select (Codex in its default transcript mode, or a
client with no attach probe at all), keeps the copies from whatever package
wrote them, and nothing tells the operator (issue #2406).

## Notice {#notice}

`hyp status`, compact and verbose, prints one informational line naming those
clients and the remedy: "Managed skills/agents for Codex are outside automatic
update coverage; run hyp skills install after package updates".

- The set is the asset ledger's client names minus the clients the status
  attach probe reports as attached, the same probe `skills install --attached`
  selects with. Names are deduped, sorted, shown by picker label, and bounded:
  past three the line says "and N more".
- It says only what those two sources establish. The ledger records that
  HypAware wrote assets for a client, not whether they are still present,
  edited, or older than the installed package, so the line claims none of that.
  A missing or unreadable ledger, or an unreadable plugin catalog, prints
  nothing.
- It is not a diagnostic. It moves neither `overall` nor the compact headline,
  and it is not part of `--json`.
- No new state: no ledger fields, digests, versions, mtimes, or refresh.

The tradeoff is that the notice is permanent for such a client. An explicit
`hyp skills install` refreshes the copies but leaves the client outside update
coverage, so the line stays. Only attachment (or removing the assets and their
ledger records) clears it. Saying something true and slightly repetitive beats
inventing a freshness claim the ledger cannot back.

## Validation and cost {#validation}

Tests cover a current transcript-mode Codex install (notice), an attached
gateway-mode Codex install (none), an empty ledger (none), and an unchanged
`overall` and headline with the notice present.

CPU and memory review: one ledger read per status collection, reusing the
attach probe results the clients rows already took. Work is linear in ledger
records, which the installer bounds by asset count per client.
