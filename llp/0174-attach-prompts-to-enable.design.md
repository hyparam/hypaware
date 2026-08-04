# LLP 0174: Manual attach prompts to enable the client adapter

**Type:** design
**Status:** Accepted
**Systems:** Config, CLI, Onboarding
**Author:** Brendan / Claude
**Date:** 2026-08-03
**Related:** LLP 0044 (attach-on-join, the consent framing this extends), LLP 0011 (init finale), LLP 0031 (local config layer writers), LLP 0037 (backfill on join), LLP 0045 (client attach/detach seam), LLP 0169 (OpenClaw attach surface), LLP 0170 (OpenClaw scheduled sweep)

> Proposal: when `hyp attach <client>` fails because the client's adapter
> plugin is not enabled, stop dead-ending. Interactively, turn the failure
> into the missing consent moment: offer to enable the adapter through the
> guarded config write path, restart the daemon, complete the attach, and
> then ask the same backfill question the init finale asks.
> Non-interactively, fail with an error that names the remedy. Attach still
> never enables anything silently, and no new enable/disable verb is added.

## Summary {#summary}

Enablement (which adapter plugins the kernel activates, decided by the
config's plugin list) and attach (editing a client's own settings file so
its traffic routes through the local gateway) are separate layers, and the
dependency runs strictly one way: a client can only be attached when its
adapter is enabled, because attach resolves the client through the live
gateway registry that only activated plugins populate.

Today the enablement layer is invisible everywhere except the `hyp init`
picker. There is no command that toggles it, and when its absence breaks
`hyp attach`, neither failure mode names it:

- Adapter not enabled, but some other gateway-using plugin is:
  `error: unknown client 'claude'. Registered clients: ...`
  (`src/core/commands/clients.js`, the registry lookup).
- No gateway-using plugin enabled at all:
  `attach requires the @hypaware/ai-gateway plugin to be installed and
  activated` (`src/core/commands/clients.js`, the capability gate).

Both read as "HypAware does not know this client" when the actual state is
"the adapter exists but is not enabled on this install", and the only
remedies are re-running `hyp init` (which rewrites the whole config to
flip one switch) or hand-editing the config JSON and restarting the
daemon.

This design makes manual attach the third enable-attach composition the
system already believes in, alongside `hyp join` (operator-scoped consent,
LLP 0044) and the init finale (picker-scoped consent, LLP 0011), with
consent captured per invocation by a prompt.

## Motivation {#motivation}

- **The dead end is the bug; the refusal is not.** Attach must not enable
  the adapter silently. Enablement switches on everything the plugin
  contributes, and the flows that perform it today (picker, join) each
  carry a consent step attach lacks. The refusal is correct; failing
  without naming the enablement layer or the fix is the defect.
- **Silent enablement would bypass the backfill question.** For Claude and
  Codex, enabling alone imports nothing: their backfill contributions
  carry no `sweep` field, so the daemon sweep driver never ticks them
  (`src/core/daemon/backfill_sweep.js`), and the historical import runs
  only when the init finale (after its consent prompt), `hyp join` (under
  the LLP 0037 `backfill.on_join` policy), or a manual `hyp backfill`
  invokes it. A side-door enablement path would either skip the question,
  leaving history unimported while the user assumes otherwise, or answer
  it unasked.
- **For OpenClaw, silent enablement is a consent bypass outright.** Its
  contribution declares a sweep schedule, so enablement alone imports the
  existing `~/.openclaw` session history within the sweep interval with no
  further command (LLP 0170). Any flow that enables it must say so.
- **The corpus already names attach as a config writer; the code never
  implemented it.** LLP 0031 lists the local layer as "authored by
  `init` / `attach` / `plugin install`" and its writer table names
  `init, attach`, and LLP 0044's summary describes `hyp attach` as
  having a config-layer half (citing LLP 0016). Today's implementation
  writes no config from attach at all. This design therefore restores a
  documented half of the command, not a new writer; the write reuses the
  same guarded path (backup before replace, validate) `hyp init` uses.
- **Precedent, not novelty.** `hyp join` already composes enable + attach:
  the central layer supplies the plugin entry, the apply engine enables
  it, the reconciler attaches, with `attach.on_join: false` as the off
  switch (LLP 0044). The init finale composes pick + attach + backfill
  consent. Manual attach is the only path with no consent capture in
  front of it, which is why it refuses; giving it one resolves the
  asymmetry without weakening any of the rules above.

## Design {#design}

### Detection {#detection}

The attach failure paths distinguish three states instead of two:

1. **Client unknown to the catalog**: the name matches no bundled or
   installed plugin's client descriptor. Keep the current
   `unknown client` error.
2. **Client known, adapter not enabled**: the name resolves in the static
   plugin catalog (the same discovery detach already uses, so this needs
   no live gateway) but not in the live registry, or the
   `hypaware.ai-gateway` capability itself is absent because no enabled
   plugin pulls it in. This is the new guided path.
3. **Client registered**: current behavior, unchanged.

Bare `hyp attach` defaults the client to `claude` and therefore takes
the guided path like an explicit name. `hyp attach all` keeps expanding
over the live registry and never prompts mid-run (a gauntlet of enable
questions inside a bulk command is the picker's job, badly reinvented);
instead it prints a one-line note per catalog client that is known but
not enabled, routing to the single-client flow where the consent prompt
lives (settled at grill, 2026-08-03).

### Bootstrap floor {#bootstrap-floor}

The prompt path requires an existing local config. Settled at grill
(2026-08-03):

- **No config file at all** (init never ran): guided error naming
  `hyp init` as the fix, no prompt. First-run consent (export choice,
  retention, daemon install, backfill) is init's job; duplicating it
  inside attach is scope creep this design refuses.
- **Config exists but no daemon is installed** (`hyp init --no-daemon`):
  after the enable write, attach falls into its existing
  endpoint-resolution ladder (live capability, configured `listen`,
  daemon `status.json` port, give up), with the give-up message extended
  to name `hyp daemon install` / `hyp daemon start`. Attach gains no
  daemon orchestration beyond the restart in {#prompt}.

### The interactive prompt {#prompt}

On state 2 with a TTY, attach prompts before doing anything:

> The Claude adapter is not enabled on this install. Attaching requires
> it. Enable @hypaware/claude (and @hypaware/ai-gateway) now? [y/N]

The dependency list comes from the same composition the picker uses
(`requires_gateway` and friends), so the prompt names everything the
write will add. On yes:

1. **Guarded config write**: add the plugin entries through the same
   backup-and-validate path `hyp init` uses (LLP 0031). No new writer.
2. **Daemon restart**: the kernel must reboot for the adapter to activate
   and the gateway registry to know the client. Reuse the existing daemon
   lifecycle machinery; wait for the gateway to bind.
3. **Attach**: dispatch to the adapter's `attach()` exactly as today.
4. **Backfill consent**: ask the same question the init finale asks, and
   run the client's backfill provider on yes. Declining leaves history
   unimported, exactly as declining in the finale does.

Each step reports its own failure. A partial failure (config written,
daemon did not come back) says exactly which step failed, notes that the
config change persists and where the backup is, and that re-running
`hyp attach` resumes from the new state.

### The OpenClaw variant {#openclaw}

For OpenClaw, step 4 is a disclosure, not a question: enabling starts the
scheduled sweep, which imports existing session history within the
interval regardless of any answer (LLP 0170). The prompt at the top of
the flow must therefore state it up front:

> The OpenClaw adapter is not enabled on this install. Enabling it starts
> a periodic sweep that will import existing OpenClaw session history
> within about 5 minutes. Enable @hypaware/openclaw (and
> @hypaware/ai-gateway) now? [y/N]

The attach step still ends with the `openclaw gateway restart`
instruction (LLP 0169), and refuse-on-existing still applies unchanged.

### Non-interactive and fleet behavior {#non-interactive}

- **No new flags** (settled at grill, 2026-08-03): v1 is prompt-only.
  No `--enable` / `--backfill` accept-flags; an unattended consumer that
  wants enable+attach either is a fleet (which has `hyp join` and the
  LLP 0044 reconciler) or can edit the config knowingly. A
  consent-bypassing invocation is cheap to add later and expensive to
  retract. The attach usage string's `[--yes]` token is drift (nothing
  parses it) and is removed in the same change.
- **No TTY, or `--json`**: no prompts. Fail with a guided error that
  names the state and both remedies, for example:
  `the claude adapter is not enabled on this install; enable it with
  'hyp init', or add @hypaware/claude to <config path> and run
  'hyp daemon restart', then re-run attach`.
- **Fleet-managed machines**: mostly a non-case, by LLP 0031's own
  layering. If the central layer names the adapter plugin, the adapter
  is already enabled and the guided path never fires; if it does not
  name it, the local layer is explicitly permitted to contribute the
  entry additively, so the prompt path proceeds exactly as on a
  non-joined host. The one blocked state is a central entry that names
  the plugin as disabled: a local write can never override a
  central-named entry, so the flow must detect that and refuse with an
  explanation ("this adapter is disabled by your fleet config") instead
  of writing an entry the merge would silently drop.

## Non-goals {#non-goals}

- **No `hyp client enable` / `hyp source disable` verb.** Settled during
  drafting: a second imperative surface for the enablement layer adds a
  new thing to explain and a new writer to guard. The prompt inside
  attach is the only new UX; config and the picker remain the enablement
  surfaces of record.
- **No change to `hyp join` / reconciler attach** (LLP 0044 untouched).
- **No change to backfill consent semantics**; the flow reuses the
  finale's question and the existing providers.
- **Not reopening LLP 0170's first-sweep consent stance.** Whether the
  OpenClaw sweep's first run deserves its own consent gate (enabling
  auto-imports history within the interval, unlike Claude/Codex which
  ask first) is a challenge to an Accepted decision and belongs to a
  future request against LLP 0170. This design's obligation ends at the
  disclosure wording in {#openclaw}.
- **Not fixing the wizard finale's OpenClaw asymmetry** (the finale
  attaches picked Claude/Codex clients but only enables a picked
  OpenClaw, `src/core/cli/wizard/pick.js` hardcodes the client list).
  Related, but a separate request; this design reduces its sting by making
  the follow-up `hyp attach --client openclaw` self-sufficient.
  Extended-by: LLP 0177 (issue), LLP 0179 (the fix decision).

## Open questions {#open-questions}

- ~~Should attach gain script-friendly flags (`--enable`,
  `--backfill`)?~~ Settled (grill, 2026-08-03): no, prompt-only; see
  {#non-interactive}.
(none remaining; all settled at grill, 2026-08-03)
- ~~Does the error-copy fix ship ahead of the interactive flow?~~
  Settled (grill, 2026-08-03): yes. First change set: three-state
  detection ({#detection}) plus the guided error at both failure sites,
  shipping the dead-end fix to every user including non-TTY. Second
  change set: the interactive flow ({#prompt}), built on that
  detection. One design, two change sets.

## References

- LLP 0044 (consent framing and the join composition), LLP 0011,
  LLP 0031, LLP 0037, LLP 0045, LLP 0169, LLP 0170
- `src/core/commands/clients.js` (both failure sites),
  `src/core/daemon/backfill_sweep.js` (why Claude/Codex enablement alone
  imports nothing), `src/core/cli/wizard/pick.js` (the finale's
  hardcoded client list)
