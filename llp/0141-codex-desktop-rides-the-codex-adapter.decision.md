# LLP 0141: Codex Desktop rides the ordinary Codex adapter

**Type:** Decision
**Status:** Active
**Systems:** Plugins, Sources, Onboarding
**Author:** Kenny / Claude
**Date:** 2026-07-28
**Related:** LLP 0012, LLP 0083, LLP 0115, LLP 0130, LLP 0133, LLP 0144

> Names a coverage fact that was already true in code and nowhere in the
> product surface. Nothing about capture changes here; the picker copy, the
> `unsupported_location` event, and the reference docs change so that what
> HypAware already does is legible.

## Context

`@hypaware/codex` has always captured Codex Desktop, by two independent
routes, neither of which was named anywhere a user looks:

1. **Live.** `hyp attach codex` writes a `model_provider = "hypaware"` root
   setting and a `[model_providers.hypaware]` table into
   `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). The Codex CLI
   and Codex Desktop read that same file, so one attach routes both through
   the local gateway. The live exchange projector treats the
   `x-codex-turn-metadata` header as a sufficient match signal because any
   Codex client sends it on a turn that carries turn metadata - Desktop
   included. (This bullet previously said Desktop is what sends it; that is
   false, and nothing in the coverage claim depends on it. See
   [LLP 0144](./0144-codex-lineage-from-body-client-metadata.decision.md#real-header-names).)
2. **Backfill.** The rollout tree under `$CODEX_HOME/sessions/**` is written
   by both surfaces too. That half rests on the provider's long-standing
   assumption (`codex/src/backfill.js`) and on smoke fixtures that synthesize
   a Desktop `originator`, not on a verified capture from a real Desktop
   install; step 5 of [`docs/ACCEPTANCE.md`](../docs/ACCEPTANCE.md) is the
   check that confirms it on real hardware.
   `session_meta.originator` rides into the row's
   first-class `entrypoint` column and into `attributes.codex.originator`, so
   a Desktop session is distinguishable after import: the terminal client
   reports `codex-tui`, Desktop reports its own value. The live route
   populates the same column from the request's `originator` header. Neither
   value is pinned here - Codex owns them, and the check in
   [`docs/ACCEPTANCE.md`](../docs/ACCEPTANCE.md) lists what a machine
   actually recorded rather than asserting a literal.

Three things in the product surface argued the opposite:

- The picker read `capture Codex conversations`, which a user with a desktop
  app does not obviously read as covering it.
- Claude Desktop ships a **dedicated** setup
  ([LLP 0115](./0115-claude-desktop-managed-config-attach.decision.md),
  [LLP 0133](./0133-desktop-solo-sudo-plist.decision.md)) with its own
  plugin, its own picker row, and a sudo-written managed plist. A reasonable
  reader generalizes: desktop clients need their own adapter, and Codex
  Desktop has none, so it must be unsupported.
- The backfill provider flags `~/Library/Application Support/Codex` as an
  `unsupported_location`. Read alone, that says Codex Desktop is unsupported.

## Decision

<a id="one-adapter"></a>**One Codex adapter covers Codex CLI and Codex
Desktop, and every surface says so.** The picker label and summary, the
plugin description, the `hypaware-reference` skill, and the README name both
surfaces. There is no `@hypaware/codex-desktop` plugin and no separate
attach: a second adapter would write the same file the first one does.

<a id="why-claude-desktop-differs"></a>**Claude Desktop needs its own setup
because its configuration surface is not shared, and Codex's is.** The two
cases are not analogous, and the asymmetry is a property of the vendors, not
of HypAware:

| | config surface | history on disk | HypAware path |
| --- | --- | --- | --- |
| Codex CLI + Codex Desktop | shared `~/.codex/config.toml` | shared `~/.codex/sessions/**` | `hyp attach codex` |
| Claude Code | `~/.claude/settings.json` | `~/.claude/projects/**` transcripts | `hyp attach claude` |
| Claude Desktop | `/Library/Managed Preferences/com.anthropic.claudefordesktop.plist`, root-owned | no HypAware-readable store; it delegates inference to its embedded CLI and rows land under `entrypoint: "claude-desktop-3p"` | `hyp claude-desktop install` |

Claude Desktop takes no user-writable settings file HypAware can amend, so
its route is a managed-preferences plist placed with sudo, plus a residue
check and a restart ([LLP 0133](./0133-desktop-solo-sudo-plist.decision.md)).
Codex Desktop takes the file `hyp attach codex` already writes. Same goal,
different mechanism, because the vendors expose different surfaces.

<a id="unsupported-boundary"></a>**The unsupported boundary is one opaque
directory, not a client.** HypAware does not parse the
`~/Library/Application Support/Codex` app container (nor the ChatGPT desktop
app's, nor browser local storage): recovering canonical rows from an
undocumented app-private store would be guesswork. That container is not the
only copy of a Desktop conversation, which is why flagging it costs nothing:
the same conversation is captured live through the gateway and re-importable
from `~/.codex/sessions`. The `unsupported_location` event therefore carries
a `covered_by` attribute naming both routes, so the flag cannot be read as
"Codex Desktop is unsupported".

## Consequences

- The picker gains no new row. Codex Desktop is not a separate pick, because
  it is not a separate attach.
- `hyp status` still cannot say "Codex Desktop traffic arrived recently".
  It boots with no plugins activated by design (`decideBootProfile` returns
  `{ activate: [] }` for `status`), so it has no dataset registry and no
  cache read; and client-specific knowledge in core would contradict
  [LLP 0130](./0130-declarative-picker-descriptors.decision.md)'s
  "rendering needs no plugin code" and LLP 0003's core/plugin split. Closing
  that gap needs a design decision (a declarative activity-probe descriptor,
  a status boot-profile change, an entrypoint section in
  `hyp query overview`, or gateway-tracked last-seen entrypoints in
  `status.json`), and is deliberately left open here. Until then the
  supported check is the query itself, documented in
  [`docs/ACCEPTANCE.md`](../docs/ACCEPTANCE.md).
- Proving the live Desktop route end to end needs Codex Desktop on a real
  machine, which no hermetic smoke can supply. `docs/ACCEPTANCE.md` carries
  the opt-in manual procedure; `gateway_codex_capture` stays a fixture smoke
  and is explicit that its Desktop-shaped traffic is synthetic.
