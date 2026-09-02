# LLP 0224: Desktop setup, second pass: deliberate tick, one question, ask once

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Onboarding, CLI
**Author:** Kenny / Claude
**Date:** 2026-08-14
**Related:** [LLP 0139](./0139-desktop-picker-consent.decision.md) (the consent design this amends), [LLP 0011](./0011-setup-and-onboarding.decision.md) (§autodetect-vs-default: the seeding rule this narrows), [LLP 0131](./0131-configure-phase.decision.md) (the configure phase whose re-run this scopes), [LLP 0190](./0190-wizard-defaults-gate.decision.md) (the defaults gates that now label these rows)
**Extended-by:** LLP 0358 (#repair-surface no longer applies to Claude Desktop: transcript capture is complete with no attach marker, so no incomplete-setup prompt is due for it)

> Amends [LLP 0139 §informed-consent](./0139-desktop-picker-consent.decision.md#informed-consent)
> and supersedes [LLP 0139 §default-no](./0139-desktop-picker-consent.decision.md#default-no).
> Everything else in 0139 stands: the whole-dependency-set composition,
> the macOS refusal, the one-gate-two-surfaces placement, the fresh-
> activation seam, `--print-commands` applying nothing, and the
> repair-must-be-runnable rule - which this decision leans on harder,
> not less.

## Context

The first outside onboarding session (2026-08-12, screen-shared) and a
reconfigure pass on an already-configured machine the next day surfaced
three frictions in the Desktop flow as 0139 shipped it:

1. **The flow contradicted itself.** Detection pre-checked the Claude
   Desktop row (its `/Applications/Claude.app` probe passes for anyone
   with the app), so the defaults gate said "record and sync all of
   these" - and the configure phase then re-asked with a consent screen
   defaulting to *no, leave Claude Desktop alone*. Opt the user in, then
   talk them back out.
2. **The consent screen led with mechanism.** Two paragraphs of
   credential-helper internals stood between the user and the decision,
   in the stretch of setup already reading as a wall of text.
3. **A reconfigure re-opened settled setup.** The configure phase ran
   `claude-desktop install` for every picked `needs_setup` row on every
   attended run, so reconfiguring an unrelated setting re-asked Desktop
   consent. A build that briefly removed the question outright showed
   the opposite failure: a yes-less flow dropped the user straight into
   the Claude OAuth browser flow, which reads as the machine acting on
   its own.

## Decision

<a id="deliberate-tick"></a>**A `needs_setup` row is a deliberate tick,
never a detection default.** Detection still labels the row
`· detected`; it arrives unchecked. The other seed tiers - the config on
disk, a re-entry's confirmed selection - are a user's recorded answer
and still check it. This narrows [LLP 0011 §autodetect-vs-default](./0011-setup-and-onboarding.decision.md):
a detected row is a suggestion, and a row whose setup acquires a
credential is not even that. When a recorded answer does put the row on
a defaults gate, the gate labels it `· needs extra setup`
([LLP 0190](./0190-wizard-defaults-gate.decision.md)), so "record all
of these" never reads as if enter alone finishes the job.

<a id="decision-led-disclosure"></a>**The disclosure leads with the
decision, keeping every fact.** "Claude Desktop needs extra setup", why
it is different (the credential posture), then the concrete change list:
sign-in or org key, the helper path, the residue clear when present, the
plist and its sudo prompt, the restart, and the undo (delete the plist,
which needs sudo, and `hyp claude-account logout`). 0139's requirement
survives verbatim: a user who reads only this block can predict every
file that changes.

<a id="one-question-default-yes"></a>**One question stands between the
disclosure and the steps, and it defaults to yes.** The opt-in the old
no-default protected has moved upstream (#deliberate-tick): a user at
this prompt chose to be here, and the root escalation still cannot
happen without the sudo password. What the question exists for is the
step a yes triggers *immediately*: on a machine not signed in, step 1
launches the Claude OAuth flow in a browser, and that launch must never
be a surprise. So the prompt names it - "if you are not signed in yet,
the first step opens the Claude sign-in in your browser" - conditioned
on the reader's state rather than probed, because the only live probe
reachable from the command (`claude-account status` via `commands.run`)
prints its own diagnostics into the middle of the consent screen.
`org_key` mode drops the clause, being the one case config settles.

The non-answer rule survives 0139 §default-no unchanged: a cancel, an
absent or non-stream stdin, and a stdin that ends without a line all
decline with the hint naming `--yes` and `--print-commands`, and EOF
resolves rather than hanging. What inverts is only the reading of an
*answered* prompt: a bare enter takes the stated default, and only an
explicit `n`/`no` declines. `--yes` accepts in advance;
`--print-commands` skips disclosure and question both; an
already-configured machine (plist matches, helper present) sees
neither.

<a id="ask-once-per-pick"></a>**The setup question is asked per pick,
not per run.** The pick lane reports which picked ids the existing
config already composed (`previouslyConfigured`), and the configure
phase skips those rows: their setup question was asked the run they were
first ticked, so a reconfigure that keeps them re-runs nothing and
re-asks nothing. Only newly checking the row reaches the question.

A row whose setup was declined or failed is carried the same way -
composed-in-config is the signal, and it does not distinguish finished
from abandoned. That is accepted, not accidental, because the incomplete
state already has a standing surface (#repair-surface); re-offering
setup on every reconfigure was precisely the annoyance being removed.

<a id="repair-surface"></a>**The incomplete-setup surface is the
existing `client_attach_missing` diagnostic, and it is now test-pinned.**
0139 §repair-must-be-runnable already routes this: `hyp status` warns
when a client's plugin is enabled with no attach marker, and for an
adapterless client the repair names the picker row's own
`configure_command` - so a declined or failed Desktop setup shows
`[WARN] client_attach_missing: ... run 'hyp claude-desktop install'` on
every `hyp status`. (Review of the first draft recorded "no core
surface points at the repair" as a known gap; that finding was
overstated - the message is assembled in `src/core/daemon/status.js`
from the descriptor, so the literal command string appears nowhere in
core, but the surface exists and fires.) A status-collector test now
pins the diagnostic and its repair string, so the claim cannot silently
rot.

One recorded limitation: `claude-desktop` declares no attach probe, so
its client reports unattached unconditionally and the diagnostic keys on
the enabled plugin alone - it clears only via the reconciler's attach
action, not by observing the plist. Giving the client a plist-reading
attach probe, so a *finished* setup quiets the warning by observation,
is the named follow-up; it is orthogonal to everything above.

## Consequences

- The wizard never opts a user into Desktop setup on detection's guess,
  never re-opens it on a reconfigure, and never launches a sign-in
  without a prompt that names it. The three 8/12-8/13 frictions each
  map to one anchor above.
- A user who declines setup keeps the composed plugins (0139's
  converging state, unchanged) and sees the repair in `hyp status`
  rather than in every future wizard run.
- 0139's amendment blocks now point here; its original §default-no text
  is retained beneath the pointer as the record of the earlier
  reasoning.
