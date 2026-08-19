# LLP 0183: A reconfigure starts from the config on disk

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Config
**Author:** Brendan / Claude
**Date:** 2026-08-04
**Extended-by:** LLP 0267 (a config that records no pick answer seeds like no config at all; #seed-from-config's "no config" carve-out is keyed to the pick answer, not the file)
**Related:** LLP 0129 (the returning gate that routes a reconfigure), LLP 0137 (retention is never asked; the pathway defaults it), LLP 0011 (detection seeds, never forces), LLP 0130 (manifest-sourced picker rows), LLP 0031 (layered config), LLP 0135 (wizard orchestration), LLP 0132 (managed local additions)

> `hyp init` on a configured machine regenerates the local config from
> detection plus pathway defaults, blind to what the machine already
> collects. This decision makes the config on disk the starting state of
> the pick phase, so the wizard edits an install instead of replacing it.

## Context {#context}

The returning gate ([LLP 0129](./0129-init-wizard-fork.decision.md#returning-gate))
sends a configured solo machine's `Reconfigure` back through the full
fork, and a managed machine's scoped re-entry through the picker. Both
land in the pick phase, which composes a fresh v2 config and writes it
over the old one. Two rounds of question-removal have since widened what
"fresh" throws away:

- Retention is no longer asked; the pathway supplies it
  ([LLP 0137](./0137-onboarding-retention-defaults.decision.md#pathway-defaults)).
- Export is no longer asked; interactive runs take `local-parquet`.

So a reconfigure re-answered two questions it never put to the user. A
solo 120-day install walking down the team path came back at 90 days, and
the next retention sweep purged days 90 to 120 of the only copy of that
history. That is silent data deletion as a side effect of a menu walk.

The checkboxes had the mirrored problem. Rows were pre-checked from
`detected.has(id) || locked.includes(id)`, and detection answers a
different question than the picker asks: it says "this client is
installed on this machine", not "this machine collects this". A row with
no `detect` rule (`otel`, the raw API rows) came back unchecked, so
confirming the picker dropped OTEL collection. A client the user had
deliberately excluded came back checked and `· detected`, so confirming
without looking re-consented to capturing it.

## Decision {#decision}

<a id="seed-from-config"></a>**The pick phase reads the local config
before it prompts, and that config decides the checkboxes.** A row is
checked when the config already collects it: everything its manifest
`compose` contribution asks for is present (its contributed plugins, the
gateway if it requires one, every upstream it requests). This is the
inverse of the composition fold
([LLP 0130](./0130-declarative-picker-descriptors.decision.md#picker-block)),
derived from the same manifest data rather than a second table.

Detection keeps its `· detected` label but stops deciding the checked
state on a reconfigure. It still seeds a first run, where there is no
config and nothing else to go on
([LLP 0011](./0011-setup-and-onboarding.decision.md#autodetect-vs-default)
is unchanged there). A newly installed client on a reconfigure is
therefore surfaced as a labeled suggestion the user ticks, not a box
ticked for them: "installed" is not consent to capture.

Only the **local** layer is read. Locked rows already arrive from the
join phase's central-layer classification
([LLP 0129](./0129-init-wizard-fork.decision.md#join-before-picker)) and
keep exactly their existing semantics; reading the merged effective
config here would fold central-layer plugins into the local layer, which
is the collision join-before-pick exists to avoid.

<a id="retention"></a>**A retention window already in the config wins
over the pathway default.** [LLP 0137](./0137-onboarding-retention-defaults.decision.md#pathway-defaults)
decides what a machine with no stated window gets; it does not license
overwriting a window the machine already states. `hyp init
--retention-days <n>` remains the explicit override, and the
non-interactive path (which states every input on its command line) still
writes what it is given.

<a id="carry-forward"></a>**Composition folds over the existing config
rather than replacing it.** The split is deliberate, not a general merge,
because a general merge would resurrect what the user just unchecked:

- **Composer-managed plugins** - the gateway, the export half's two
  plugins, and every plugin any picker row in the catalog contributes -
  live and die by the picks. One the picks no longer compose is dropped.
  The exception is a plugin named as the `writer` or `destination` of a
  sink that is itself carried forward: dropping it would leave a config
  that cannot activate.
- **Every other plugin is passed through.** A hand-added
  `@hypaware/gascity` (or a `@hypaware/central` entry) was never the
  composer's to add, so it is not the composer's to drop.
- **Per-plugin config is the user's**, merged over the manifest's
  composed values key by key, so a hand-edited otel `listen_port`
  survives a reconfigure that keeps the otel row. The one exception is
  the gateway's `upstreams`: that list is derived from the picks, not a
  preference, so composition owns it outright and unchecking a row really
  removes its upstream.
- **Sinks** the composition names merge the same way (a hand-edited
  `schedule` or `dir` wins); sinks it does not name pass through. Sink
  ids are the user's to choose, so a composed sink whose plugins some
  existing sink already runs is dropped rather than added beside it: the
  composer's `local` and a hand-renamed `exports` writing the same
  parquet to the same local-fs tree are one export, not two. Merging is
  narrower still: only the *same* sink merges, meaning the same union
  member running the same plugins, and any other occupant of a composed
  id keeps the id rather than being overwritten. Folding a blob sink
  over a request sink would keep `plugin` beside `writer`/`destination`,
  which cross-validation rejects as `request_sink_invalid_keys`; folding
  the parquet export over a jsonl one would rewrite the format and
  destination of data the composer never chose; and replacing either
  would delete a sink the composer never wrote.
- **Export is read back, not re-defaulted.** A config with a
  parquet-to-local-fs sink reconfigures as `local-parquet`; any other
  config reconfigures as `keep-local`, which preserves its own sinks
  instead of gaining a second, unasked-for one.
- **Unknown top-level keys pass through** untouched.

<a id="say-so"></a>**The overwrite confirm says the file is rewritten.**
"Overwrite it (a backup is kept)?" reads as "keep adjusting my picks".
The question now states that the config is rewritten from the picks and
names what is carried over, so the answer is a decision about the picks
rather than a bet on how much is lost.

## Why not {#why-not}

- **Merge detection into the configured set** ("detection adds
  suggestions for rows not currently configured"). Rejected: it is
  exactly the capture-consent regression above. A deliberately excluded
  client is detected on every run, so it would be re-checked on every
  run.
- **Ask about retention and export again on a reconfigure.** Rejected:
  LLP 0137 removed the retention question on its merits, and reinstating
  it for one entry path splits the onboarding script by how the user got
  there.
- **Deep-merge the whole file.** Rejected as the `upstreams` case shows:
  some composed values are consequences of the picks and must be
  recomputed, not merged. The managed/unmanaged split is what makes
  "unchecking a row removes it" and "your edits survive" both true.

## Consequences {#consequences}

- A reconfigure is now an edit. The write is still a whole-file
  regeneration guarded by the same backup, but its content is the old
  config with the picked set recomposed.
- Composition is lossy for a row whose whole contribution is an upstream
  another row also contributes (`raw-anthropic` beside `claude`): the two
  compose to identical bytes, so such a row reads as configured whenever
  its upstream is. Its checked state is cosmetic - checking or clearing
  it composes the same config either way.
- Non-interactive runs (`--yes`, presets, `--from-file`) are unchanged
  and still compose from scratch: they state every input explicitly, and
  their output stays byte-identical
  ([LLP 0131](./0131-configure-phase.decision.md#attended-only)).
- `wizard.pick.start` gains `reconfigure` and `sources_configured`
  attributes, so a run's starting state is visible in telemetry rather
  than inferred from what it wrote.
- The attach/detach asymmetry of the same reconfigure flow is a separate
  defect and is not touched here.

## References

- LLP 0129, LLP 0137, LLP 0011, LLP 0130, LLP 0031, LLP 0135
- `src/core/cli/wizard/pick.js` (reads the config, seeds the rows,
  retention and export), `src/core/cli/walkthrough.js`
  (`composePickerConfig`'s carry-forward fold,
  `configuredPickerSources`, `configuredExportChoice`,
  `defaultOverwriteConfirmFactory`)
