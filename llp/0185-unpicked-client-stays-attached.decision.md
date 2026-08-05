# LLP 0185: An unpicked client is named, not detached

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Clients
**Author:** Brendan / Claude
**Date:** 2026-08-04
**Related:** LLP 0045 (the one disk-driven undo), LLP 0129 (Reconfigure re-enters the picker), LLP 0086 (the existing attach drift diagnostic), LLP 0180 (the finale's attach lane), LLP 0031 (central layer)

> Re-running `hyp init` and unchecking a client the previous run attached
> regenerates a config without that client's adapter, while the client's own
> settings still route through the HypAware gateway. Capture stops, and the
> requests themselves can fail. Nothing in the finale or the reconciler
> reverses that attach.

## Context {#context}

The wizard finale attaches picked clients and nothing else
([LLP 0180](./0180-finale-attaches-openclaw.decision.md)). The action
reconciler's reverse lane undoes **config-named** action keys, which is the
org/central lane: a solo machine's wizard-finale attach has no marker there
and is never reversed by it. A solo machine has been able to re-enter the
picker through Reconfigure since
[LLP 0129](./0129-init-wizard-fork.decision.md#returning-gate), so the state
is reachable on master.

Two shapes, worst first:

- Unchecking one of several clients drops that client's adapter and its
  gateway upstream. The client still points at the gateway, which now has no
  upstream matching it.
- Re-picking only OpenTelemetry composes no `@hypaware/ai-gateway` at all.
  After the finale's daemon restart every still-attached client points at a
  dead port.

Neither shape is announced. `hyp status`'s only client drift check is the
port-mismatch one ([LLP 0086](./0086-attach-tracks-ephemeral-port.decision.md)),
which is scoped to clients that *are* configured.

## Options considered {#options}

1. **Detach in the finale.** Probe the previously attached clients the new
   effective config no longer enables and run the one core undo
   ([LLP 0045 §Part 3](./0045-client-attach.design.md)) on each.
2. **Warn in the finale.** Name each stranded client and the `hyp detach
   --client <name>` that clears it.
3. **Warn in `hyp status`.** An attached-but-not-configured diagnostic, so a
   run that has already closed still surfaces the state.

## Decision {#decision}

<a id="warn-do-not-detach"></a>**The finale names what it left attached and
stops there (option 2, plus option 3 as the backstop).** After the config
write and before the daemon restart, the finale lists every client whose
settings still carry a HypAware attach marker, that this run did not pick,
and that neither the written config nor the central layer enables. It prints
the clients, the consequence, and one `hyp detach --client <name>` line each.

Option 1 is deliberately **not** taken. Rewriting a client's settings file is
destructive and out of proportion to a menu confirm: unchecking a row in a
picker is not an instruction to edit `~/.codex/config.toml`. It also
overloads the picker's meaning, which up to now has only ever *added*. This
decision does not close option 1; it declines to make it on the user's behalf
inside a wizard step, and the warning is what makes choosing it later a
deliberate change rather than a bug fix.

The warning **surfaces the breakage, it does not prevent it.** A user who
ignores it is in exactly the state the issue describes. That is the honest
cost of not detaching, and it is why the status backstop below exists.

<a id="scope"></a>**The org/central lane is untouched.** A client whose
adapter the central layer names is never counted as stranded: its attach is
the reconciler's, forward and reverse
([LLP 0031](./0031-layered-config.decision.md)). The finale reads the central
layer read-only for the plugin names it declares, and nothing else.

<a id="status-backstop"></a>**`hyp status` warns on attached-but-not-
configured, on solo hosts only.** The diagnostic
(`client_attached_not_configured`) is the mirror of `client_attach_missing`
and repairs with `hyp detach --client <name>`. On a joined host the same
shape is a reconciler pass that has not run yet, not a state the operator
should undo by hand, so it is gated on the absence of a central layer, the
same gate the client-action defaults already use. It is gated a second time
on the local layer having *parsed*: a config file that is present but
unreadable empties the active-plugin set for a reason that says nothing about
what the operator enabled, and answering a parse failure with a detach for
every attached client would be reading an accident as intent, stacked on top
of the `config_unreadable` finding that is the real repair. The known gap: a
*local layer* addition stranded on a managed host is not diagnosed by status.
The finale still warns about it at the time, which is where the state is
created.

<a id="not-configured-means-not-active"></a>**"Not configured" means what
`hyp status` already means by it.** Both surfaces read a **local layer** plugin
entry with `enabled: false` as inactive, so a switched-off adapter strands its
client exactly as an absent one does. The finale and the diagnostic must agree
about the same config file; a set built two ways would eventually disagree.
This is about the local layer only: the org lane is settled by
[§scope](#scope) above, which is stronger. A client the central layer *names*
is never counted as stranded whatever its `enabled` flag says, because
reversing that attach is the reconciler's job either way, and the finale is
not the surface that gets to second-guess it.

## Consequences {#consequences}

- `FinaleSummary` gains `attachedNotConfigured?: string[]`, so the run's
  result carries what was printed. Optional, so a scripted finale runner (the
  wizard's injectable seam, tests) need not synthesize it.
- The finale performs one extra descriptor-driven settings probe per unpicked
  client, and one read of the central layer. Both are reads; a failure of
  either degrades to "nothing stranded", which can only cost a missing
  warning, never a wrong undo.
- `StatusDiagnosticKind` gains `client_attached_not_configured`.
- Option 1 remains available and is now cheap: the detection it needs is the
  function this decision added, and the undo it needs already exists.

## References

- Issue #604; #603 covers the config-side blindness of the same flow
- `src/core/cli/walkthrough.js` (`findAttachedNotConfiguredClients`, the
  finale warning), `src/core/daemon/status.js` (the diagnostic)
- LLP 0045, LLP 0129, LLP 0086, LLP 0180, LLP 0031
