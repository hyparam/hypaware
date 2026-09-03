# LLP 0369: An unrecognized picker platform warns rather than fails the plugin

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Onboarding
**Author:** Phil / Claude
**Date:** 2026-09-03
**Related:** LLP 0368 (#platform-gate: the gate this reports on), LLP 0130 (#picker-block: the declarative picker row), LLP 0329 (#stderr-mirror: the channel a diagnostic reaches an unconfigured install by), hyparam/hypaware#1299
**Extends:** LLP 0368

> LLP 0368 settled that `validatePickerContributions` accepts any non-empty
> array of non-empty strings as a row's `platforms` gate. That leaves a typo
> (`"macos"`, `"Darwin"`, `"win"`) valid, and a valid gate that matches no
> platform withholds its row everywhere in silence. This adds the missing
> diagnostic without turning the typo into a rejection.

## The problem {#problem}

`visiblePickerDescriptors` compares a row's `platforms` against
`process.platform` by string equality. Nothing anywhere compares those values
against the set `process.platform` can actually report, so `["macos"]`
validates, loads, and then matches nothing. The row is offered on no platform
at all, which is worse than the mistake it came from and looks exactly like a
row the author forgot to write. The author's own machine gives them no signal,
because the failure is the absence of a row.

## Warn, do not reject {#warn-not-reject}

A manifest validation failure is fatal to the whole plugin: `loadManifest`
returns a `FailedManifest` and every contribution the plugin makes (sources,
sinks, datasets, commands) goes with it. Rejecting an unrecognized `platforms`
value would therefore trade one withheld picker row for a dead plugin, which
is a strictly larger failure than the one being fixed, and it would arm on the
one input nobody can enumerate in advance: a `process.platform` value Node
adds after this release.

So the shape LLP 0368 `#consequences` settled is kept exactly as written, and
the report is added beside it. `loadManifest` emits one WARN per offending
row, `manifest.picker_platform_unrecognized`, naming the manifest path, the
plugin, the row, and the unrecognized values. It mirrors to stderr (LLP 0329
`#stderr-mirror`), because the reader is a plugin author on a default install
with no telemetry provider, where an unmirrored WARN is constructed and
dropped.

The warning fires at load, not at picker display: a gated row is withheld
before it reaches any menu, so the display path is the one place the mistake
cannot be observed from.

## The known set is the diagnostic's, not the gate's {#known-set}

`KNOWN_PLATFORMS` holds the values Node documents for `process.platform`
(`aix`, `android`, `darwin`, `freebsd`, `linux`, `openbsd`, `sunos`, `win32`).
It is deliberately not consulted by the gate itself, only by the report, which
is what makes it safe to be wrong: a platform Node adds later costs one
spurious warning line on a manifest that is in fact correct, and the row still
renders where it should. Had the same list gated validation, being out of date
would have cost the author their plugin.

## Consequences {#consequences}

- `loadManifest` warns per picker row carrying a `platforms` value outside the
  known set; `validateManifest` is unchanged and still accepts it.
- The warning mirrors to stderr, so it is visible on an install that
  configured no telemetry.
- No bundled manifest emits it: `@hypaware/claude-desktop`'s `["darwin"]` is
  the only gate that ships, and a test pins that the bundled set stays quiet.
