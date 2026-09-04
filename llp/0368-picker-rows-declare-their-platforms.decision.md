# LLP 0368: A picker row can name the platforms it is offered on

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Onboarding, CLI
**Author:** Phil / Claude
**Date:** 2026-09-03
**Related:** LLP 0130 (#picker-block: the declarative picker row this extends), LLP 0011 (#autodetect-vs-default: a probe pre-checks, it never forces and never hides), LLP 0202 (#hidden-rows: display filtering is never a catalog deletion), LLP 0139 (#macos-only: the Desktop commands already refuse off macOS), LLP 0297 (#problem: the first reading of this gap), LLP 0358 (the decision that made the Desktop row visible again), hyparam/hypaware#1283
**Extends:** LLP 0130
**Extended-by:** LLP 0370 (the request covering what #display-only's carry leaves with no interactive exit: on the gating platform a configured gated row is kept unconditionally and silently, no menu answer removes it, and its `compose` riders come back with it)

> LLP 0130 settled that a picker row is declarative manifest data and that
> `detect` seeds its checkbox. LLP 0011 settled that detection may only
> pre-check, never force and never hide. Between them, a row for a client
> that cannot exist on this operating system has no way to say so: it
> renders unchecked, and ticking it is a dead end. This adds one field,
> `platforms`, and gates display on it.

## The problem {#problem}

`@hypaware/claude-desktop`'s row probes `detect.app_bundle:
/Applications/Claude.app`. On Linux that probe fails, so the row arrives
unchecked, and an unchecked box is still an offer. Ticking it composes
`@hypaware/claude-desktop` alongside `@hypaware/claude`, and the Desktop
half scans `claudeDesktop3pSessionRoots`, hardcoded to `Library/Application
Support/Claude-3p/...`. That is a macOS container layout. On Linux those
paths cannot exist, so the Desktop half captures nothing, while the Claude
Code half keeps working. The failure is therefore silent: the user picked a
Desktop row, got rows from Claude Code, and nothing said Desktop was never
in play.

LLP 0297 read this same gap (`#problem`, item 3: "The row renders on Linux,
where the plist path does not exist") and solved it by hiding the row on
every platform, because at the time selecting it also walked a sudo'd system
write. LLP 0358 superseded that and made the row visible again, correctly:
Desktop capture is now a plain transcript import with no privileged setup.
But 0297's platform argument was independent of its consent argument, and
only the consent one was answered. The row came back on Linux too.

LLP 0139 `#macos-only` already refuses `client claude-desktop install` and
`verify` on a non-macOS platform, "the same loud contract `hyp daemon
install` already has". The picker had no equivalent, so the one surface that
recommends the integration was the one surface with no platform opinion.

## The gate {#platform-gate}

A `contributes.picker` row may declare the platforms it is offered on:

```json
{ "name": "claude-desktop", "label": "Claude Desktop", "platforms": ["darwin"] }
```

`platforms` is a non-empty array of `process.platform` values. Absent means
every platform, which is what almost every row wants. A row whose gate does
not name the running platform is not offered.

This is deliberately not another `detect` variant. A probe answers a question
about *this machine* ("is Claude Desktop installed here?"), and LLP 0011 is
right that such an answer may only pre-check: the user may be about to
install the app, or keep it somewhere the probe does not look, so the box
stays theirs to tick. `platforms` answers a question about *the integration*
("is there a Desktop capture path on this operating system at all?"). No
user action changes that answer, so there is no choice to leave open.

## Display only {#display-only}

`platforms` gates exactly what `hidden` gates and nothing further: the single
display filter `visiblePickerDescriptors` (LLP 0202 `#hidden-rows`). A gated
row keeps every other property of a picker source. `hyp init --source
claude-desktop` still composes it, `configuredPickerSources` still reads back
a config that collects it, and its id still reaches
`datasetOwnedSourceIdsFromCatalog`, which arms the export seam's
unattributed-row withholding (LLP 0192 `#fail-closed`). Dropping rows from
the catalog would turn that privacy guard off; filtering the menu does not.

Routing through the existing filter rather than adding a second one carries
two things for free:

- The sync-scope lane (LLP 0276 `#sync-gate`) already accounts for rows the
  display filter removed, passing them on as `candidatesHiddenIds` and
  `lockedHidden` so it never says nothing syncs while a filtered row still
  ships. A platform-gated row that reached a config through `--source`
  inherits that handling unchanged.
- `--source` still composes the row. The gate withholds an offer, it does not
  refuse a choice, which is the same escape hatch every hidden row has. The
  cost of being wrong stays a dead-end selection the user asked for by name.

Withholding an offer and refusing a choice come apart at one place, the pick
lane's carry-through. A row the menu cannot show is unpickable, so a
reconfigure that re-derives the config from the menu drops it. LLP 0202
`#carry-through` already solved that for `hidden` rows, and the carry is
therefore keyed on what the display filter withheld rather than on `hidden`
itself: a seeded, non-derivatively-read-back gated row (LLP 0297
`#own-plugins`) rides through the selection. Without that, walking the menu
again on Linux would silently un-compose a `--source claude-desktop` install,
which is the choice refused that this section says the gate does not do.

## Testing a host-dependent menu {#testability}

The visible row set is now a function of `process.platform`, so a test over
the real bundled catalog would answer differently on a developer's Mac and on
Linux CI. `runPickerWalkthrough` and `runWizardPick` therefore take an
optional `platform`, defaulting to `process.platform`, the same shape the
wizard's first ask already uses for launcher resolution. A test that counts
menu rows names the platform it counts on.

## Consequences {#consequences}

- `PluginPickerContribution` and `PickerDescriptor` gain `platforms?: string[]`.
- `validatePickerContributions` rejects a `platforms` that is not a non-empty
  array of non-empty strings.
- `visiblePickerDescriptors(descriptors, platform)` filters on `hidden`, then
  on the gate.
- The pick lane's carry-through is keyed on the rows that filter withheld,
  not on `hidden`, so a reconfigure on the gating platform preserves a config
  that already collects a gated row.
- `@hypaware/claude-desktop`'s row declares `"platforms": ["darwin"]`.
- Onboarding on Linux loses one row. macOS is unchanged, and no other bundled
  row declares a gate.
