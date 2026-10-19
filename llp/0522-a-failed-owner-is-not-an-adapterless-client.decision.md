# LLP 0522: A failed owner is not an adapterless client

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Plugins
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-10-17
**Extends:** [LLP 0180](./0180-finale-attaches-openclaw.decision.md)
(#decision: a client with no registered adapter is not applicable, never
failed. That reading now holds only when the client's owning plugin
activated.)
**Related:** LLP 0115 (#no-attach-on-join), LLP 0306 (#endpoint-free-clients),
LLP 0219 (#incomplete-activation-prunes-nothing), hyparam/hypaware#596

## Context {#context}

The setup finale's attach lane read "no adapter in the registry" as Claude
Desktop's deliberate no-attach posture. The loader tolerates a throwing
`activate()` and carries on, so a picked client whose owner threw also had no
adapter, and was recorded `ok: true, noAdapter: true` with nothing printed.
When the owner registered its adapter before throwing, the lane attached
through a plugin that never finished activating. A solo pick with no gateway
skipped the lane outright, so even that was silent. Setup exited 0 either way.

## Decision {#decision}

- **The owner's outcome is read first.** The dispatcher hands a command the
  boot's activation outcomes (`CommandRunContext.activations`, the loader's
  results with the thrown message withheld). The finale maps each picked
  client to the plugin whose manifest contributes it, once per run, and a
  client whose owner threw is decided before the adapter lookup. A
  registration left behind by a throw is never attached through.
- **It is a failed attach, said plainly.** The lane records it `ok: false`
  with the plugin and its error kind, writes one line naming the client, the
  plugin, and the kind, with `hyp status` and `hyp client attach` as the
  repair, and logs the same identity. The thrown message is plugin text and
  is neither printed nor logged here; the loader already logged it. The kind
  shown is one the loader assigns itself (`activate_failed`,
  `activate_missing`): a throw's own `hypErrorKind` is plugin data too, so
  any other value reads as `activate_failed`.
- **The lane runs for it with no gateway.** A failed owner enters the lane on
  its own, like an endpoint-free adapter does (LLP 0306).
- **Healthy clients carry on.** Nothing is rolled back and the wizard is not
  aborted; the other picks attach as before.
- **Setup exits 1 when it happened.** The exit code is what a scripted setup
  reads. Ordinary attach refusals keep their warn-and-continue exit; only a
  failed owner changes it.
- **Unknown is not success, and not failure.** A caller that passes no
  outcomes, or an owner that never reached activation (dep-graph elimination,
  profile withholding), keeps the LLP 0180 reading. Those holes are already
  reported by `failedPlugins` and `hyp status`; this decision is about the
  one route whose owner and error kind are known.
- **Already-done join work stands.** A client the join lane already attached
  is skipped as before, whatever this boot says about its owner.

An adapterless client whose owner activated, Claude Desktop, is still the
silent not-applicable skip LLP 0180 settled.
