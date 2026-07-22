# LLP 0130: Picker entries are declarative manifest contributions

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Onboarding, CLI
**Author:** Phil / Claude
**Date:** 2026-07-22
**Related:** LLP 0005, LLP 0011, LLP 0128, LLP 0131

> Spawned by [LLP 0128](./0128-install-experience-overhaul.rfc.md) on
> acceptance. Extends [LLP 0005](./0005-plugin-manifest.spec.md): the
> manifest gains a `contributes.picker` block; core stops owning the
> hardcoded `PICKER_SOURCES` list.

## Decision

<a id="picker-block"></a>Each source or client plugin describes its wizard
presence as **data in its manifest**, alongside the existing declarative
`contributes.client`:

```json
"picker": {
  "label": "Claude Desktop",
  "summary": "The Claude Mac app",
  "detect": { "app_bundle": "/Applications/Claude.app" },
  "needs_setup": true,
  "configure_command": "claude-desktop install"
}
```

- `detect` is probe **data**, evaluated by core to seed the initial
  checkbox state (the [LLP 0011](./0011-setup-and-onboarding.decision.md#autodetect-vs-default)
  autodetect doctrine unchanged: pre-check only, never force, never
  hide). Settings-file probes reuse the `attach_probe` shape; app-bundle
  and path probes are new data kinds.
- `needs_setup` marks entries whose selection implies a configure phase
  ([LLP 0131](./0131-configure-phase.decision.md)).
- <a id="configure-command"></a>`configure_command` names the plugin's
  ordinary CLI verb; the wizard runs that command in-process. The wizard
  and the standalone command are the same code, so they cannot drift;
  progress narration and resume-on-re-run belong to the command itself.

**Rejected: a code contract** (plugins exporting `detect()` /
`configure()` with declared step lists). It would load plugin code just to
render a checkbox list, split "what does this plugin contribute" across
manifest and module, and duplicate the resume behavior idempotent re-run
already provides. A command wanting machine-readable progress can emit
structured step events later, additively.

## Consequences

- Core keeps composition (merging picks into a valid local-layer config)
  but stops owning the list; `PICKER_SOURCES` and the hardcoded
  `composePickerConfig` rules migrate onto the plugins they describe.
- Claude Desktop and hermes get detection and picker presence for the
  first time.
- The manifest stays the single reviewable statement of what a plugin
  contributes; rendering the picker needs no plugin code execution.
