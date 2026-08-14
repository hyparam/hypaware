# LLP 0139: The Desktop picker row composes its whole dependency set, gated by informed consent

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Onboarding, Config
**Author:** Brendan / Claude
**Date:** 2026-07-27
**Related:** LLP 0016, LLP 0024, LLP 0041, LLP 0153, LLP 0116, LLP 0117, LLP 0130, LLP 0131, LLP 0133

> [LLP 0133](./0133-desktop-solo-sudo-plist.decision.md) shipped
> `hyp claude-desktop install` and gave the plugin a `needs_setup` picker
> row. The row was never reachable: it composed nothing, so ticking it
> wrote a config the row's own `configure_command` could not run in. This
> decision makes the row compose its full dependency set and replaces the
> config-file friction that had been standing in for a credential opt-in
> with an explicit consent gate.

## Context

A picker row's composition is a fold over each picked descriptor's
`compose` contribution ([LLP 0130](./0130-declarative-picker-descriptors.decision.md#picker-block)).
The Claude Desktop row shipped `needs_setup: true` and
`configure_command: "claude-desktop install"` but no `compose` block, the
only one of the eight bundled rows without one. The fold skips a
descriptor with no `compose`, so ticking Claude Desktop wrote a config
containing neither `@hypaware/claude-desktop` nor the
`@hypaware/claude-account` its manifest requires.

The failure was a dead end rather than an error. The configure phase ran
`claude-desktop install`, which exited nonzero because the command's
plugin was absent from the config just written; drop-on-failure
([LLP 0131](./0131-configure-phase.decision.md#drop-on-failure)) printed
the catch-up hint `hyp claude-desktop install`, which failed identically
on every subsequent run. Because `/Applications/Claude.app` satisfies the
row's detect probe, the row arrived pre-checked for every user who had
Desktop installed.

Two adjacent surfaces made the state harder to diagnose than it should
have been:

- Following the dispatch repair hint literally (adding only
  `@hypaware/claude-desktop`, [LLP 0153](./0153-inactive-not-unknown-dispatch-miss.decision.md))
  produced a worse error, not a better one. The plugin fails its
  `requireCapability('hypaware.anthropic-credential')` call, so its
  commands never register and the dispatcher reports
  `unknown command 'claude-desktop status'`.
- `hyp status` offered `hyp attach --client claude-desktop` as the repair
  for the resulting un-attached client. The plugin registers no
  `ctx.clients` adapter by design (LLP 0133), so that command answers
  `unknown client 'claude-desktop'`. (`overall: healthy` alongside it is
  correct and deliberate: `client_attach_missing` is non-degrading per
  [LLP 0041](./0041-central-config-client-actions.design.md) §failure-is-surfaced-not-fatal.)

The reason the row had been left inert was real. `@hypaware/claude-account`
is excluded from default activation because it holds an Anthropic
credential, and `V1_EXCLUDED_FROM_DEFAULT` treats holding a credential as
a deliberate `plugins[]` decision. Composing it from a checkbox appears to
route around that.

## Decision

<a id="compose-the-whole-dependency-set"></a>**A `needs_setup` row
composes every plugin its `configure_command` needs, not just its own
adapter.** The Desktop row composes the gateway, the anthropic upstream,
`@hypaware/claude-account` (`mode: "subscription"`), and
`@hypaware/claude-desktop`. `PluginPickerCompose` gains `plugins[]` beside
the singular `plugin` for rows that contribute more than one, under the
same gateway-relative placement rule.

Composing half a dependency set is strictly worse than composing none: the
adapter fails its capability requirement, so its commands never register
and the failure surfaces as `unknown command` rather than as the missing
capability. A test asserts the general rule across every bundled row, so a
future `needs_setup` row cannot ship inert the same way.

<a id="informed-consent"></a>**The credential decision is gated by an
explicit consent prompt at the point of action, not by config-file
friction.** `hyp claude-desktop install` explains what it will change
before it changes anything: the gateway endpoint it points Desktop at, why
this client is different, the sign-in, the helper path, the residue clear
when residue is present, the root-owned plist and its sudo prompt, the
restart, and how to undo it. A user who reads only that block can predict
every file that changes.

> **Scope correction ([LLP 0140](./0140-transcript-entrypoint-ownership.decision.md)).**
> This gate covers the live-capture path only: the credential, the helper,
> and the managed plist. It is not the sole door Desktop content enters by.
> Desktop writes its sessions into `~/.claude/projects`, so the
> `@hypaware/claude` backfill imported them with no Desktop opt-in at all.
> Read "the picker tick is the consent point" below as scoped to live
> capture; history is gated separately, by transcript-entrypoint ownership.

> **Amended 2026-08-13.** The explanation stands and the question stays,
> but it flips to defaulting to yes and now names its consequence. By the
> time this command runs the user has already opted in: the picker row is
> never pre-checked (detection only labels it, per the 2026-08-13 seeding
> change), so it was ticked deliberately - or the command itself was
> typed - which is why the old no-default read as the install
> second-guessing a choice the picker had just recorded (8/12 onboarding
> feedback). The question cannot be removed outright, though: a yes on a
> signed-out machine immediately launches the Claude OAuth flow in a
> browser, and a run that jumps into an auth flow with nothing standing
> in front of it reads as the machine acting on its own (8/13 feedback,
> from the build that briefly shipped without the prompt). So one
> question stands between the disclosure and the steps, defaults to yes,
> and says "if you are not signed in yet, the first step opens the Claude
> sign-in in your browser" wherever a yes can do that. It says *can*, not
> *will*: the only live sign-in probe reachable from the install command
> is `claude-account status` through `commands.run`, whose own output
> would land on the consent screen, so the sentence is conditioned on the
> reader's state instead. `org_key` mode drops the clause outright, being
> the one case config alone settles. `--yes` accepts in advance;
> `--print-commands` skips disclosure and question both; an
> already-configured machine sees neither. And the question is asked for
> a *new pick* only: the wizard's configure phase skips a `needs_setup`
> row the existing config already composed (a reconfigure's carried
> answer), so reconfiguring an unrelated setting never re-opens Desktop
> setup - `hyp claude-desktop install` stays the finish and repair path.
> Known gap, left open: a row whose setup was declined or failed is
> carried the same way (composed-in-config is the only signal the
> configure phase has), so a reconfigure never re-offers it and no core
> surface points at the repair. Closing that needs a completeness signal
> from the adapter.

This is a better gate than the exclusion list was, for three reasons.
First, the acquisition of a credential was already attended: step 1 of
`install` runs `claude-account login` interactively and refuses outright
without a TTY, so composing the plugin only enables something that *can*
hold a credential. Second, a `plugins[]` edit is silent about what it
implies, whereas the prompt states the posture in the words that matter:
unlike Claude Code and Codex, which keep their own sign-in while HypAware
rewrites only a base URL, Desktop's third-party profile has no
credential-passthrough mode ([LLP 0116](./0116-desktop-credential-client-presented.decision.md#helper-contract)),
so attaching it necessarily makes this machine hold an Anthropic
credential. Third, the picker tick is attended and specific, so it is a
real decision rather than a default.

The mode question resolves along the same seam: the picker is the solo
path, so it composes `subscription`. `org_key` is fleet policy and arrives
through the central layer on `hyp join`, never through the picker
([LLP 0117](./0117-claude-account-credential-plugin.decision.md)).

<a id="default-no"></a>

> **Amended 2026-08-13: the prompt now defaults to
> yes.** The opt-in this default protected has moved upstream - the row
> is never pre-checked, so a user at this prompt chose to be here - and
> the root escalation still cannot happen without the sudo password. What
> survives of this section is its non-answer rule, unchanged: a cancel,
> an absent stdin, and a stdin that ends without a line all decline with
> the hint, and EOF resolves rather than hanging. Only an explicit no
> declines; only a real enter is a yes. The original text is kept below.

**The prompt defaults to no**, unlike the backfill
consent prompt, which defaults to yes. Backfill reads local files this
machine already has; this acquires a credential, escalates to root, and
writes a file outside the user's home. A bare enter must not do any of
that. A decline is a no-op that exits nonzero, which is what routes the
wizard onto its existing drop-on-failure path so the catch-up command is
printed instead of Desktop being reported as attached.

Every non-answer is a no, and says so. A cancel (esc / ctrl-c), an absent
stdin, and a stdin that ends without a line all decline with the same hint
naming `--yes` and `--print-commands`. The last case is the one that
matters in practice: the dispatcher defaults `ctx.stdin` to
`process.stdin`, so an absent stream never occurs, while a redirected one
(`hyp claude-desktop install < /dev/null`) does. Waiting on a `readline`
answer there hung forever with the hint unprinted, which is the same
unattended-hang class as the `--print-commands` bug below.

Consent is asked once, not on every re-run: a machine whose plist already
matches and whose helper is already written has been through the prompt,
and LLP 0131's idempotent re-run has to stay cheap enough to use as the
documented repair step.

<a id="macos-only"></a>**Before any gate runs, the command refuses on a
non-macOS platform.** Every surface it touches is macOS-specific: the
managed plist under `/Library/Managed Preferences`, the `Claude-3p`
residue under `~/Library/Application Support`, the `cfprefsd` flush. The
wizard already cannot reach the flow elsewhere (the row's detect probe
stats `/Applications/Claude.app`), but a direct invocation had no gate,
and on Linux it would half-succeed: consent, login, and helper write all
run, then `sudo mkdir -p '/Library/Managed Preferences'` creates
root-owned junk at the filesystem root while configuring nothing.
`install` and `verify` now refuse up front, mutating nothing and naming
the platform: the same loud contract `hyp daemon install` already has for
an unsupported platform. The refusal gates the applying path only:
`install --print-commands` passes everywhere, by the same rule that lets
it skip consent (it applies nothing, #print-commands-applies-nothing).
(`profile`, `status`, and `install-helper` also stay ungated: rendering
the MDM payload or staging the helper touches no macOS surface and is
legitimately useful on a non-Mac admin box preparing a fleet push,
LLP 0133#one-surface.) Platform reach beyond this is a
repo-level scope fact, not this adapter's gap: core supports darwin and
linux only, Claude Desktop has no Linux build, and a Windows port is
gated on a core service backend plus live-test discovery of the Windows
policy surface (the method LLP 0133 records for macOS).

<a id="one-gate-two-surfaces"></a>**The gate lives in the command, so the
wizard inherits it.** The configure phase already invokes
`claude-desktop install` in-process through `ctx.commands.run`
([LLP 0130](./0130-declarative-picker-descriptors.decision.md#configure-command)),
so putting the prompt in the command covers the standalone and wizard
surfaces with one implementation. This follows LLP 0131's existing rule
that the wizard adds no second implementation of a configure command.

<a id="seam-fresh-activation"></a>**The seam activates a freshly
config-enabled command plugin, so the wizard can reach the gate at all.**
The gate living in the command only covers the wizard if the wizard can
dispatch the command. It could not: `hyp init` boots the `all-available`
profile, which by construction never activates a `V1_EXCLUDED_FROM_DEFAULT`
plugin, and the activation set (with the command registry it populated) is
fixed at process start, while the picker writes its composed config later
in that same process. So on a first-run init the configure phase's
in-process `claude-desktop install` missed dispatch, exited 2, and
drop-on-failure printed the catch-up hint - the consent prompt was
unreachable from the surface it was built for, and only the standalone
re-run ever showed it.

The fix follows the entrypoint gate's rule ([LLP 0140](./0140-transcript-entrypoint-ownership.decision.md)):
only a fresh read of the config reflects a write that happened after boot.
On a registry miss, `ctx.commands.run` re-reads the effective config from
disk and, when a `config`-profile boot of that fresh read would select the
plugin declaring the missed command's head token, activates it into the
running kernel together with its config-selected dependency closure, in
dependency order (for the Desktop row: `@hypaware/claude-account` first,
which provides the credential capability, then `@hypaware/claude-desktop`;
the gateway is already active under `all-available`). This is scoped to the
in-process seam: a shell-invoked `hyp <cmd>` boots with the `config`
profile, which already activates config-listed plugins before dispatch.
The exclusion list still governs defaults - nothing activates that the
effective config does not name, and the config names Desktop's plugins only
because the row was ticked. Activation is not the gate; the prompt is, and
it still defaults to no. On any failure the seam stays silent and the
dispatch miss path reports unavailable-plus-repair exactly as before
([LLP 0153](./0153-inactive-not-unknown-dispatch-miss.decision.md)).

<a id="print-commands-applies-nothing"></a>**`--print-commands` applies
nothing, including the non-privileged steps.** It previously honored the
flag only for the plist write and the restart, still running the credential
login and helper write for real. That made the one flag whose purpose is
avoiding unattended side effects the flag most likely to hang: on a machine
that was not signed in it dropped into an interactive OAuth flow. All five
steps now print under the flag, which is also what makes it correct for the
consent gate to skip it.

<a id="repair-must-be-runnable"></a>**A diagnostic's repair must be a
command that runs.** `client_attach_missing` takes its repair from the
client plugin's own picker row `configure_command` when it has one, falling
back to `hyp attach --client <name>` otherwise. A client that declares
`contributes.client` for probe and status plumbing but registers no runtime
adapter has to name its own setup command, or the repair we print answers
`unknown client`.

## Consequences

- Ticking Claude Desktop in `hyp init` now works end to end: compose,
  explain, confirm, login, helper, residue, plist, restart. *(Amended
  2026-08-13: the confirm defaults to yes and names the sign-in launch.)*
- Declining leaves `@hypaware/claude-account` and
  `@hypaware/claude-desktop` in the written config with no credential and
  no plist. That is the converging state, not a broken one: the re-run
  repair works precisely because the plugins are present, and `hyp status`
  now names that re-run as the repair.
- `V1_EXCLUDED_FROM_DEFAULT` still excludes both plugins from default
  activation. Nothing enables them without either a picker tick or an
  explicit `plugins[]` edit; the exclusion governs defaults, and the picker
  is not a default.
- `--yes` accepts the changes in advance for scripted use. An unattended
  fleet is unaffected: MDM places the same plist and never reaches this
  command (LLP 0133#one-surface).
