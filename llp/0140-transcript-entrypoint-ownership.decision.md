# LLP 0140: A transcript's `entrypoint` decides which client may import it

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Backfill, Config
**Author:** Brendan / Claude
**Date:** 2026-07-27
**Related:** LLP 0049, LLP 0050, LLP 0103, LLP 0115, LLP 0130, LLP 0133, LLP 0139

> Claude Desktop writes its sessions into `~/.claude/projects`, the tree the
> `@hypaware/claude` backfill scans. So Desktop history was imported
> whether or not Desktop was ever configured, and filed under `claude`.
> This decision makes transcript ownership a manifest contribution and
> gates the import on it.

## Context

`@hypaware/claude`'s backfill provider walks
`~/.claude/projects/**/<session-id>.jsonl` and imports every session it
finds, filtered only by time window (LLP 0049) and usage policy
(LLP 0050, LLP 0103). Neither filter knows anything about clients.

Claude Desktop's agent sessions land in that same tree, tagged
`entrypoint: "claude-desktop"`. Two consequences, both observed on a real
machine:

1. **Import without opt-in.** Desktop history entered the cache on the
   next backfill even though `@hypaware/claude-desktop` was absent from
   the config, never attached, and its consent gate
   ([LLP 0139](./0139-desktop-picker-consent.decision.md#informed-consent))
   never shown. That gate covers the credential and plist path; it does
   not cover the door history actually arrives through.
2. **Wrong attribution.** `client_name` came from the provider's
   `DEFAULT_CLIENT_NAME`, so Desktop rows were indistinguishable from
   Claude Code rows except by the `entrypoint` column.

The second matters more than it looks, because Desktop may be capturable
*only* this way. Its agent sessions run inside a VM, and no Desktop log
references a loopback address, so it is not established that the managed
third-party-inference profile (LLP 0133) redirects that surface at all.

Measurement across 390 real transcripts: every file carries an
`entrypoint`, and every file carries exactly one distinct value. So the
field is a clean per-session discriminator: no split conversations, no
files needing a tie-break.

## Decision

<a id="manifest-declares-ownership"></a>**A client declares the transcript
`entrypoint` values it owns, in its manifest.**
`contributes.client.transcript_entrypoints` is a string array; the plugin
catalog surfaces it on `ClientDescriptor`, and the `hyp backfill` runner
resolves the value-to-owner map and hands it to providers as
`BackfillRunContext.entrypointOwners`.

The runner resolves it, not the provider, because the answer needs the
**full** catalog (the claiming plugin is typically *not* active, which is
exactly the case that closes the gate) plus the effective plugin list.
Neither is reachable from `PluginActivationContext`.

"Configured" means **membership of the effective config, read fresh**, not
membership of this process's activation set. The two differ precisely where
the opt-in happens: `hyp init` boots the `all-available` profile, which by
construction omits every `V1_EXCLUDED_FROM_DEFAULT` plugin, and
`@hypaware/claude-desktop` is on that list because it needs the credential
capability. The picker cannot change an activation set fixed at process
start, so an activation-derived answer left the gate permanently closed for
a user who had just ticked the row and accepted the consent prompt: the
plist was written and the finale's own backfill then imported none of their
Desktop history, silently. The runner therefore unions the activation set,
the boot-resolved `ctx.config`, and a fresh read of the local config
document, which is the only one of the three that reflects a config written
after boot. Unioning fails open, matching
[#fail-open-on-unknown](#fail-open-on-unknown).

Declared in manifests rather than a core table because three hardcoded
lists in this area have already drifted from the manifests they shadow:
the picker row that composed nothing (LLP 0139), `PICKER_DISPLAY_ORDER`,
and `init.js`'s `--source` enum. A fourth would rot the same way, and this
one would rot silently in the direction of over-capture.

A client may claim several values: un-attached Desktop's transcripts in
the shared tree say `claude-desktop`, and an earlier attached build stamped
`claude-desktop-3p`. Desktop does NOT claim `local-agent`, the value the
current attached build writes into its container transcripts: that string
names a CLI mode, not a client (it drifted to `local-agent-v2` within a
week, LLP 0133#attribution), and container sessions are owned by their
root instead ([#container-root-owns](#container-root-owns)), so the claim
would only misfile a shared-tree session from some future CLI mode.

<a id="container-root-owns"></a>**A session found inside another client's
container is owned by that client, whatever its entrypoint says.** The
current attached Desktop build writes transcripts under sandboxed
per-session homes inside the `Claude-3p` container, outside
`~/.claude/projects` entirely, and the claude adapter scans those trees so
the gate and enrichment see attached-Desktop sessions at all
(LLP 0133#attribution). For those roots, admission derives from the root,
not from the value found inside it: the value has already drifted between
Desktop builds, `attachment` and summary records omit the field, and a
value test over a foreign container therefore fails open exactly where
consent is at stake. The container's owner is fixed beside the code that
hardcodes its paths (`DESKTOP_3P_CONTAINER_OWNER`); `configured` comes from
the runner's configured-plugin predicate
(`BackfillRunContext.isPluginConfigured`), resolved from the same effective
plugin list as the owners map, but deliberately NOT read out of that map:
the map only has entries for plugins that declare
`transcript_entrypoints` values, and this section says values decide
nothing for container sessions, so a map lookup would have made container
admission silently depend on a declaration that is otherwise vestigial for
it (a configured Desktop dropping its value claims would have stopped
importing its own container). When the predicate does not answer true for
the owning plugin, or no predicate was supplied at all, the gate closes:
unlike the scanning client's own tree, failing closed here drops no
history the user opted into, it declines to read another client's private
directory, which `master` never read either.

<a id="gate-before-projection"></a>**A session whose entrypoint is owned by
an unconfigured client is skipped before projection**, beside the
usage-policy drop and for the same reason (LLP 0049 R1): the cheapest
correct place to refuse is before any row exists. When the owner *is*
configured, the session imports and is attributed to the **owner**, not to
the plugin whose transcript tree it happened to live in. One map, both
uses.

<a id="fail-open-on-unknown"></a>**Unknown entrypoints fail open, in the
scanning client's own tree only.** A value no installed plugin claims is
imported and attributed to the scanning client. Failing closed would
silently drop real history the first time a client ships a new entrypoint
value, or on a transcript predating the field, and a backfill that quietly
imports less than it should is worse than one that files a row under a
slightly wrong client. The gate therefore closes only on the case that
actually breaks consent: an entrypoint some installed plugin explicitly
claims while not being configured. The gate strengthens as clients
declare, rather than depending on any list being exhaustive. None of this
applies to sessions found under another client's container, where the same
fail-open direction would open exactly the door the gate exists to close:
those are owned by the root ([#container-root-owns](#container-root-owns))
and their entrypoint value decides nothing.

Unclaimed values are counted per distinct value and reported once in
`scan_complete` (`unclaimed_entrypoints`), not per session: a value nobody
claims is a property of the install, not of each conversation. Per-session
logging buried the two real gate decisions under 388 lines.

## Consequences

- `hyp backfill claude` on a machine without Desktop configured skips
  Desktop sessions and says so: `sessions_gated` in `scan_complete`, plus
  one `entrypoint_not_configured` record per skipped session.
- Attaching Desktop makes its history importable, and it lands as
  `client_name: "claude-desktop"`. Existing rows imported before this
  change keep `client_name: "claude"`; nothing rewrites them.
- Providers must treat `entrypointOwners` and `isPluginConfigured` as
  optional. For the scanning client's own tree, an absent or empty map
  means import everything under the scanning client, which is exactly the
  behavior that shipped before this decision, so a catalog failure
  degrades toward the old behavior rather than toward dropping history.
  Container roots degrade the same way, and for them the old behavior is
  the opposite: `master` never read the `Claude-3p` container, so an
  absent predicate closes that gate.
- Sessions under the 3p container gate on Desktop's config membership
  whatever their entrypoint value: absent, drifted, or unclaimed values
  change the attribution log line, never the admission decision.
- `hyp backfill plan` resolves the same map as the run and passes it on
  `BackfillPlanContext`. A plan that estimated over sessions the run then
  gates out would be wrong in the one direction the gate exists to fix.
- `@hypaware/claude` claims `cli` and `sdk-cli`. Without that, every
  ordinary Claude Code session took the fail-open path: harmless for
  import, but the gate would be inert for the common case.
- The same conversation can arrive twice for attached Desktop: live via
  the gateway and again by transcript backfill from the 3p sandbox tree.
  With the claude adapter scanning that tree, identity comes from the
  transcript on both paths (as for Claude Code), so they dedupe, except
  for a live exchange projected before its transcript line is written,
  which keeps a gateway-fallback identity and can then duplicate against
  the backfill's transcript-identity rows (the same known class as a
  Claude Code exchange whose hook never reported a transcript path).
  Rows captured before the sandbox trees were scanned are all in that
  state.
