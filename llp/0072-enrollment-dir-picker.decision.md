# LLP 0072: the enrollment directory picker is a skippable refinement, not a consent gate

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Onboarding
**Author:** Phil / Claude
**Date:** 2026-07-06
**Related:** LLP 0063, LLP 0069, LLP 0071, LLP 0037, LLP 0044, LLP 0011, LLP 0036

> [LLP 0063 D3](./0063-login-auto-provision-forward-sink.decision.md) settled
> that `hyp remote login` **never prompts `y/n`** — enrollment consent is a
> pre-auth warning, not a blocking question. [LLP 0069](./0069-local-only-dir-selection.spec.md)
> adds an interactive multi-select *after* enrollment. This decision reconciles
> the two: the picker is a **post-enrollment privacy refinement** that defaults
> to excluding nothing, is skippable and TTY-gated, and never blocks or
> re-litigates the enrollment decision D3 governs.
>
> @ref LLP 0069 [implements] — the picker/consent half of the spec.
> @ref LLP 0063 [constrained-by] — must not reintroduce the enrollment prompt D3 (§Decisions) rejected.
>
> **Suspended-by [LLP 0094](./0094-enrollment-picker-suspended.decision.md):**
> the login-time trigger is currently disabled pending redesign; the doctrine
> this decision settles (skippable refinement, never a consent gate) is
> unchanged and is what makes the outright suspension safe.

## Context

The tension is real and worth stating plainly. [LLP 0063 D3](./0063-login-auto-provision-forward-sink.decision.md)
explicitly **rejected** a "first-login interactive confirm," on three grounds: it
puts a prompt in a one-command story, it is a TTY edge in piped/MDM flows, and it
second-guesses the consent the operator already gave at domain-claim time. Adding
*any* interaction to the login flow has to answer those three objections, or it
reopens a settled decision.

## Decision

**The directory picker is a post-enrollment refinement, not a consent gate.** It
is distinguished from the confirm D3 rejected on every axis that mattered to D3:

| D3's rejected confirm | This picker |
|---|---|
| Gates *whether enrollment happens* | Runs *after* enrollment is decided and provisioned; enrollment already happened |
| Blocking `y/n` — must be answered | Defaults to **exclude nothing**; Enter / Ctrl-C / EOF proceeds unchanged |
| Hangs piped / MDM flows | **TTY-gated**: no interactive stdin/stderr → skipped, zero exclusions, no hang |
| Second-guesses operator's domain-claim consent | Adds *nothing* about enrollment; only lets the user withhold **their own** directories, which the org never had a claim to |

So the picker does not violate D3 — it operates in the space D3 left open. D3
forbids a prompt that *asks permission to enroll*; this asks nothing about
enrollment. It sits inside the [LLP 0036 §Consent](./0036-central-config-driven-client-actions.decision.md)
doctrine (per-instance defaults sized to blast radius) as a *narrowing* control
the user may apply after the fact, exactly analogous to how the first-run
walkthrough ([LLP 0011](./0011-setup-and-onboarding.decision.md)) offers
interactive choices without any of them being a gate on setup completing.

### Default is exclude-nothing {#default}

The picker pre-selects **nothing**. Forwarding everything is the enrollment the
user just consented to (LLP 0063 D3 pre-auth notice); the picker only *removes*
directories from that. A default that pre-excluded anything would silently
withhold data the org expects, inverting the consent the operator has. The user
must affirmatively pick a directory for it to become `local-only`. This also
makes the non-TTY skip safe: "no picker" and "picker with nothing selected" reach
the identical state — full forwarding — so a piped login is never *more*
permissive than the operator intended, only never *less*.

**Dismiss = finish enrolling with zero exclusions, never abort.** The picker runs
*after* the browser login already succeeded (the gateway credential is minted) and
*before* `enrollCentralSink` ([LLP 0069 §trigger](./0069-local-only-dir-selection.spec.md#trigger)).
So Enter, Ctrl-C, and EOF at the picker all mean the same thing: **select nothing
and proceed** — enrollment completes (sink provisioned, daemon installed, full
forwarding). Ctrl-C here **cannot** un-do the login; the picker can only *narrow*
an enrollment already consented to, never reverse it. This is deliberately
distinct from LLP 0063 D3's *pre*-auth `"Ctrl-C to cancel"`, which aborts before
authenticating — once the credential is minted, there is nothing left to cancel,
only directories to (optionally) withhold. Because the picker precedes
provisioning, a dismissed or abandoned picker leaves no half-enrolled machine:
the subsequent `enrollCentralSink` runs exactly as it would with no picker at all.
An **empty candidate list** — a fresh login-first box with no captured history yet
— is the same path: skip with a one-line hint pointing at the durable
`hyp ignore --local-only` command ([cli](#cli)), then proceed.

### TTY-gated, reusing the existing prompt seam {#tty}

The picker runs only when both stdin and stderr are interactive TTYs, using the
same `isTty` / `buildTtyPrompt` seam plugin-install confirmation already uses
(`src/core/cli/core_commands.js`, `src/core/plugin_install/confirm.js`) — a
multi-select (checkbox-list) variant of it, prompting on stderr so stdout stays
clean for scripts. A non-interactive login prints a one-line hint naming the
durable command ([cli](#cli)) instead of prompting, so the capability is
discoverable without being blocking. This keeps D3's "no TTY edge in piped flows"
property intact.

### Never-silent {#never-silent}

Consistent with [LLP 0063](./0063-login-auto-provision-forward-sink.decision.md)'s
never-silent ethos: when the user *does* exclude directories, the flow prints
what it did (`withholding N director(ies) from forwarding — recorded locally,
never sent`), and `hyp status` reflects the list size
([LLP 0069 R9](./0069-local-only-dir-selection.spec.md#requirements)). "Enrolled
but withholding" is a visible state, not a hidden one.

## Durable authoring outside login {#cli}

The picker is the *convenient* entry point, not the *only* one
([LLP 0069 R7](./0069-local-only-dir-selection.spec.md#requirements)). Two things
the login-time picker structurally cannot cover — directories worked in *after*
enrollment, and correcting a mistaken selection without re-running login — need a
durable command. It reuses the [LLP 0049 §cli](./0049-hypignore-usage-policy.spec.md#cli)
verb surface rather than inventing a parallel one:

- `hyp ignore --local-only [path]` — add a directory to the machine-local
  `local-only` list ([LLP 0071](./0071-machine-local-exclusion-list.decision.md)),
  defaulting to the repo root / cwd like `hyp ignore`.
- `hyp unignore --local-only [path]` — remove it.
- `hyp ignore --check [path]` — already specified to report the governing class
  ([LLP 0049 §cli](./0049-hypignore-usage-policy.spec.md#cli)); it now also
  reports `local-only` membership and, per its existing contract, how many
  already-cached rows from the scope have **not yet been forwarded**.

These are idempotent ([LLP 0049 R5](./0049-hypignore-usage-policy.spec.md#requirements))
and are the same read/modify/write over the machine-local file the picker
performs — the picker is a TTY front-end over exactly this. Exact flag spelling
(`--local-only` vs. a distinct verb) is a design detail for the follow-on design
doc; the
constraint here is only that a non-login authoring path exists and shares the
resolver + storage.

## The org-forces-forwarding policy is deferred {#org-policy}

Because the list is machine-local ([LLP 0071](./0071-machine-local-exclusion-list.decision.md)),
an org cannot currently forbid a user from withholding directories. Whether a
tenant should be able to require full forwarding (a central `local_only:
forbidden` policy, surfaced to this client the way LLP 0063 imagined a
`login_enrollment` knob) is a **central-server governance concern**, out of V1
scope and owned here as the single named home for that follow-up. V1 deliberately
ships the *user's* control first: the privacy-protective default is the safe one
to ship before the operator-override exists, never the reverse
([LLP 0049 §fail-safe](./0049-hypignore-usage-policy.spec.md#fail-safe) reasoning,
applied to governance rather than versioning).

## Consequences

- Code landing this carries `@ref LLP 0072 [implements]` on the picker in
  `runBrowserLogin` and `@ref LLP 0072#cli [implements]` on the durable
  authoring command.
- No change to the enrollment decision, the pre-auth notice, or `--no-forward`
  ([LLP 0063 D3](./0063-login-auto-provision-forward-sink.decision.md)); this
  strictly adds an optional step after them.
- The multi-select TTY component is net-new (plugin-install confirm is a single
  yes/no); it becomes a reusable core prompt other onboarding flows can adopt.
- Because the picker and the CLI share one storage + resolver path, there is one
  place to test the authoring surface and one place privacy-critical logic lives.

## Alternatives considered

- **Prompt `y/n` "exclude any directories?" first, then the list.** Rejected:
  redundant — the list *is* the prompt, and it already defaults to
  exclude-nothing, so a guard question adds a keystroke and an extra TTY edge for
  no gain.
- **Run the picker as a separate command after login (`hyp remote login` prints
  "run `hyp ignore --local-only`").** Rejected as the *primary* path: it defeats
  [LLP 0069](./0069-local-only-dir-selection.spec.md)'s point — the moment
  forwarding turns on is exactly when the user is thinking about what not to send,
  and a deferred command is one most users never run, leaking the backlog in the
  meantime ([LLP 0069 R6](./0069-local-only-dir-selection.spec.md#requirements)).
  The command still exists ([cli](#cli)) as the durable/after-the-fact path, but
  the attended picker is the default.
- **Pre-select likely-personal directories (home dir, non-org repos).** Rejected:
  guessing which directories are private and pre-excluding them silently withholds
  data the org may expect, against the operator's consent, and a wrong guess is a
  privacy *or* a completeness surprise. The user picks; the tool does not infer
  ([default](#default)).
