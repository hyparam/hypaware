# LLP 0229: status derives attach state by the reconciler's own desired() gate

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Config, Plugins
**Author:** Phil / Claude
**Date:** 2026-08-14
**Related:** LLP 0044 (#status-surface: the attach-on-join loop and the surface this constrains), LLP 0045 (the attach design `desired()` implements), LLP 0115 (#no-attach-on-join: Claude Desktop, the probe-less client this is derived from), LLP 0139 (#repair-must-be-runnable: the repair rule this leaves standing), LLP 0224 (#repair-surface: why the `client_attach_missing` diagnostic is deliberately outside this gate), LLP 0143 (superseded; made the same observation about OpenClaw, before LLP 0169 gave OpenClaw a probe back), LLP 0169 (the attach surface OpenClaw regained), [#544](https://github.com/hyparam/hypaware/issues/544)
**Extended-by:** LLP 0358 (#diagnostic-is-out-of-scope is retired: Desktop capture no longer depends on attach, so the probe-less gate now covers the `client_attach_missing` diagnostic too)

> `hyp status` and the attach reconciler answered "is this client an attach
> target?" by two different rules, so a client the reconciler will never act on
> was rendered as one it has not acted on *yet*: a `pending` that never
> resolves and a `not attached` that no command can change. Status derives
> attach state by `desired()`'s own gate, or it does not derive it. The
> `client_attach_missing` diagnostic is deliberately left outside the gate,
> because LLP 0224 made it something other than attach state.

## Context {#context}

Attach-on-join ([LLP 0044](./0044-client-attach-on-join.decision.md)) is a
reconciled, reversible action. Its precondition is a **reversible write to the
client's own settings file**, and the manifest's `attach_probe` is what makes
that write observable and therefore reversible. So
`action_attach.desired()` skips any client descriptor that declares no
`attach_probe` (`src/core/config/action_attach.js`): attach must be reversible,
and only the probe can reverse it.

The consequence is total, not partial. For a probe-less client `perform()`
never runs, so **no marker is ever written**, and no marker will ever be
written, on any host, at any time.

`hyp status` derived two surfaces of attach *state* against the attach contract
without that gate. Both read the reconciler's permanent silence as a permanent
negative:

- `buildClientActionsReport` built its declared-attach set from every enabled
  client descriptor on a joined host, so *no marker* plus *declared* plus
  *joined* resolved to `pending`, forever.
- the clients row mapped a probe-less descriptor to `{ attached: false }` and
  printed `not attached`, where nothing is attachable.

This was a missed gate rather than a design choice: the doc comment above
`buildClientActionsReport` already stated the intended invariant, that
`pending` and `n/a` are derived for declared targets the reconciler *would act
on* but has not yet.

The corpus already has the sibling of this rule. `readAttachPolicy` and
`readBackfillPolicy` exist so that status and the reconciler cannot disagree
about what an `on_join` block means. Attach-eligibility is the second thing the
two sides can disagree about, and until now nothing kept them together.

## Decision {#decision}

<a id="status-derives-by-the-same-gate"></a>**Every `hyp status` surface that
reports attach *state* derives it by the same gate `action_attach.desired()`
uses.** A client descriptor with no `attach_probe` is one the reconciler will
never name; status says so rather than reporting a state that can never resolve
([#544](https://github.com/hyparam/hypaware/issues/544)).

Concretely, and in the general form, not per client:

- **Client actions.** A probe-less declared target carries `inert: true` and
  derives `n/a`. That joins `on_join: false` and a non-joined host as the third
  way of saying the same thing: the reconciler is a no-op for this target. It
  is **not** dropped from the report. A vanished row is its own wrong answer,
  since the reader cannot tell "nothing to do here" from "status forgot to
  look".
- **The clients row.** `ClientAttachReport` carries a required
  `attachable: boolean`, set from `!!descriptor.attachProbe` and never from a
  probe *result*. The text surface prints `attach n/a` instead of
  `not attached`. `hyp status --json` carries `attachable` beside an
  **unchanged** `attached` boolean, so a consumer pinning `attached` does not
  break, and one that wants to distinguish "no marker" from "no such thing as a
  marker" reads the new key.

<a id="diagnostic-is-out-of-scope"></a>**The `client_attach_missing`
diagnostic stays outside this gate, and keeps firing for a probe-less client.**
It looks like the third surface and is not one.
[LLP 0224 #repair-surface](./0224-desktop-setup-second-pass.decision.md#repair-surface)
made it the *standing incomplete-setup prompt*, and stopped the wizard
re-offering setup on every reconfigure specifically because that prompt exists.
Gating it here would leave a declined or failed Claude Desktop setup with **no
surface at all**, which is a worse answer than an imprecise one.

LLP 0224 reached that position with its eyes open: it records, as a known
limitation, that Desktop declares no probe, so the diagnostic "keys on the
enabled plugin alone" and clears only via the reconciler, never by observing
the plist. The fix it names is to give Desktop a plist-reading `attach_probe`,
at which point the client becomes `attachable`, the warning becomes clearable
by observation, and it rejoins this rule with no further decision. That is the
follow-up, and it is the only thing that should retire this exception. Until
then the exception is recorded rather than argued away, because a warning that
over-fires is a nag and a warning that never fires is a silent failure.

<a id="unattachable-not-unattached"></a>**A probe-less client is unattachable,
not unattached.** A negative we never observed must not be rendered as one we
did. This is a gate, not a new signal: nothing here reports whether a
probe-less client is in fact routing. That remains each adapter's own question,
answered by its own command (Claude Desktop's is
`hyp claude-desktop verify`), not by the attach surface.

<a id="keys-on-the-descriptor-not-the-probe-result"></a>**The gate keys on the
descriptor, never on the probe's outcome.** A client whose probe resolves and
finds no marker, and a client whose probe *errors*, are both `attachable: true`
and keep the full `not attached` / `pending` / `client_attach_missing` trio. An
unresolvable probe is a real negative that a user can act on; the absence of a
probe is not. Collapsing the two would suppress exactly the warning the surface
exists to raise.

<a id="the-rule-outlives-its-clients"></a>**The rule is stated over the
manifest, not over a client roster.** Which clients are probe-less is a fact
about today's shipped set and changes under us: OpenClaw was probe-less under
[LLP 0143](./0143-openclaw-registers-no-attach-probe.decision.md) and is
probed again under [LLP 0169](./0169-openclaw-attach-surface-returns.decision.md);
`claude-desktop` is the only probe-less client at the time of writing
([LLP 0115 #no-attach-on-join](./0115-claude-desktop-managed-config-attach.decision.md#no-attach-on-join)),
and a fleet's third-party plugin can add another tomorrow without touching
core. Nothing in core enumerates them, and nothing should: the gate reads the
descriptor, so a client that gains or loses a probe changes its status answer
by construction.

## Consequences {#consequences}

- Claude Desktop's permanent `attach claude-desktop [pending]` becomes `n/a`,
  and its clients row reads `attach n/a`. This is the remaining half of #544:
  the OpenClaw half closed when
  [LLP 0169](./0169-openclaw-attach-surface-returns.decision.md) gave OpenClaw
  a probe back, which made its rows correct without any change here.
- [LLP 0139 #repair-must-be-runnable](./0139-desktop-picker-consent.decision.md#repair-must-be-runnable)
  and [LLP 0224 #repair-surface](./0224-desktop-setup-second-pass.decision.md#repair-surface)
  are untouched. `hyp status` still prints
  `client_attach_missing: ... run 'hyp claude-desktop install'` for a declined
  or failed Desktop setup, and the `configure_command` lookup is still reached.
  A reader of the clients row now sees `attach n/a` beside that warning: the
  two are answering different questions, and the warning's own text names the
  command that answers its one.
- `ClientAttachReport.attachable` is **required**, not optional, so a new
  construction site that forgets it fails `npm run typecheck` rather than
  silently reintroducing the wrong negative.
- A client that regains a probe regains all three states with no core change,
  which is what happened to OpenClaw between LLP 0143 and LLP 0169 and is the
  reason this rule is worth stating separately from either.

## Open questions {#open-questions}

- `desired()` has a second skip this gate does not mirror: it also skips a
  descriptor whose plugin registers no runtime client. Status deliberately does
  not activate plugins, so it cannot observe that fact and cannot close the
  rule the same way. It is unreachable in the shipped set today (the only
  adapterless client is also probe-less, and so already gated), and it is named
  here so "status derives by the same gate" is not read as fully closed.
- A `done` attach marker written before a client lost its probe still renders
  `attach <name> [done]` beside a clients row saying `attach n/a`.
  Marker-derived, outside this gate's path, and arguably the honest reading of
  both facts, but worth revisiting if a client ever loses a probe with an
  installed base.

## References {#references}

- [LLP 0044](./0044-client-attach-on-join.decision.md): attach on join, and the status surface this constrains
- [LLP 0045](./0045-client-attach.design.md): the client attach design `desired()` realizes
- [LLP 0115](./0115-claude-desktop-managed-config-attach.decision.md): Claude Desktop registers no `attach_probe`
- [LLP 0139](./0139-desktop-picker-consent.decision.md): the repair-must-be-runnable rule this leaves standing
- [LLP 0224](./0224-desktop-setup-second-pass.decision.md): #repair-surface, the standing incomplete-setup prompt this gate is kept away from
- [LLP 0143](./0143-openclaw-registers-no-attach-probe.decision.md) (Superseded): where this observation was first written down, against OpenClaw
- [LLP 0169](./0169-openclaw-attach-surface-returns.decision.md): OpenClaw's probe returns, which is why the rule is stated over the manifest
- [#544](https://github.com/hyparam/hypaware/issues/544): a probe-less client reads as permanently unattached
