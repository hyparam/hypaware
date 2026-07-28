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

Declared in manifests rather than a core table because three hardcoded
lists in this area have already drifted from the manifests they shadow:
the picker row that composed nothing (LLP 0139), `PICKER_DISPLAY_ORDER`,
and `init.js`'s `--source` enum. A fourth would rot the same way, and this
one would rot silently in the direction of over-capture.

A client may claim several values: Desktop's transcripts say
`claude-desktop` while its live 3P route stamps `claude-desktop-3p`
(LLP 0133#attribution).

<a id="gate-before-projection"></a>**A session whose entrypoint is owned by
an unconfigured client is skipped before projection**, beside the
usage-policy drop and for the same reason (LLP 0049 R1): the cheapest
correct place to refuse is before any row exists. When the owner *is*
configured, the session imports and is attributed to the **owner**, not to
the plugin whose transcript tree it happened to live in. One map, both
uses.

<a id="fail-open-on-unknown"></a>**Unknown entrypoints fail open.** A value
no installed plugin claims is imported and attributed to the scanning
client. Failing closed would silently drop real history the first time a
client ships a new entrypoint value, or on a transcript predating the
field, and a backfill that quietly imports less than it should is worse
than one that files a row under a slightly wrong client. The gate
therefore closes only on the case that actually breaks consent: an
entrypoint some installed plugin explicitly claims while not being
configured. The gate strengthens as clients declare, rather than depending
on any list being exhaustive.

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
- Providers must treat `entrypointOwners` as optional. Absent or empty
  means import everything under the scanning client, which is exactly the
  behavior that shipped before this decision, so a catalog failure
  degrades toward the old behavior rather than toward dropping history.
- `@hypaware/claude` claims `cli` and `sdk-cli`. Without that, every
  ordinary Claude Code session took the fail-open path: harmless for
  import, but the gate would be inert for the common case.
- Not addressed here: the same conversation could in principle arrive
  twice for Desktop, once live via `claude-desktop-3p` and once by
  transcript via `claude-desktop`. For Claude Code the two paths dedupe
  because identity comes from the transcript either way; whether that
  holds for Desktop is unverified, and should be checked before Desktop
  live capture is relied upon.
