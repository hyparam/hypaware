# LLP 0142: one privacy surface, and when a bundled skill is user-invoked only

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Onboarding, Usage-Policy
**Author:** Brendan / Claude
**Date:** 2026-07-29
**Related:** LLP 0049, LLP 0066, LLP 0100, LLP 0102, LLP 0104, LLP 0107

> Two bundled skills answered "what sensitive content did HypAware record,
> and what should I do about it": `hypaware-privacy`
> ([LLP 0100](./0100-enrollment-privacy-review.spec.md)) and an
> undocumented `hypaware-sensitive-scan`. They gave opposite answers about
> purge. This retires the undocumented one, scopes the survivor to this
> machine's local cache deliberately, and ungates its description from
> enrollment per [LLP 0107 #gating](./0107-skills-ride-attach.decision.md#gating).
> It also records which bundled skills are user-invoked only, and why the
> session opt-out is not among them.

## Context

`hypaware-sensitive-scan` shipped without an LLP. It overlapped
`hypaware-privacy` on the survey-and-sample job and contradicted it on the
remedy: the scan skill promised **prospective opt-outs only** ("it does NOT
purge already-recorded rows"), while LLP 0100 R7 requires the privacy review
to **offer `hyp purge`** ([LLP 0104](./0104-hyp-purge.decision.md)) for every
directory marked `ignore`. A user who asked the same question twice got two
different accounts of whether their recorded data could be removed.

The overlap was not symmetric. `hypaware-privacy` carries the specced flow
(R3-R8: session self-opt-out, redacted excerpts, per-item confirmation,
`hyp` verbs only, purge offered). `hypaware-sensitive-scan` carried two
things the specced flow did not: an any-time framing, and a prompt to choose
between scanning local logs and scanning a remote server.

## Decision

<a id="one-privacy-surface"></a>**`hypaware-privacy` is the only privacy
audit surface.** `hypaware-sensitive-scan` is retired, not superseded by a
replacement: its useful half was already specced in LLP 0100, and its purge
stance was the wrong one. Where the two disagreed, LLP 0100 wins.

<a id="local-cache-scope"></a>**Scope is this machine's local cache, and the
remote-server scan is dropped on purpose.** Sampling an org server's whole
recorded history from one member's laptop is not a practical operation: the
row volume is unbounded, the useful remedies (`hyp policy set`, `hyp purge`)
are machine-local and cannot reach rows already forwarded, and the member
running the scan generally cannot act on another member's capture anyway.
Server-side review is an operator concern and belongs behind an operator
surface, not a client skill. The skill's `description` states the boundary
so the gap is visible rather than assumed.

<a id="any-time"></a>**The description advertises the any-time audit; the
first sync is the standard occasion, not a gate.** This is
[LLP 0107 #gating](./0107-skills-ride-attach.decision.md#gating) applied to
the trigger surface: enrolled-ness gates behavior, not presence, and "the
skill's deadline framing simply does not arise without a pending first
sync". The steps are unchanged and the enrollment framing is retained where
it applies; only the description and the surrounding prose stop implying the
flow is unavailable to an unenrolled machine, which is the default state.

<a id="user-invoked-only"></a>**A bundled skill is marked
`disable-model-invocation` only when invoking it is itself a consequential
act the user should choose deliberately.** That covers the three report
pipeline steps: `hypaware-publish-report` (makes a report org-visible),
`hypaware-apply-report-changes` (mutates this machine's config), and
`hypaware-report-to-html` (rewrites a git working tree). Each is a step a
user takes on purpose after reading something; none is an answer to a
question.

**Superseded-by: [LLP 0193 #gate-moves-to-the-command](./0193-skills-state-constraints-not-procedures.rfc.md#gate-moves-to-the-command)**
(2026-08-06), for this paragraph only. The three report skills are now
model-invocable: reports are meant to be asked for in the user's own words,
and the control moved onto the consequential act itself (each confirms before
publishing, applying, or editing report sources) rather than onto the skill's
discoverability. The rest of this document, including the reasoning for why
`hypaware-ignore` / `hypaware-unignore` were never in this set, stands.

It does **not** cover `hypaware-ignore` / `hypaware-unignore`. For the
session opt-out, being reachable in the user's own words *is* the feature:
[LLP 0066](./0066-session-opt-out.spec.md) is written around the utterance
"don't record *this conversation*" and treats those skills as the contract
the gateway implements. A user who has to already know the slash command has
lost the affordance the spec exists to serve. LLP 0107 #gating makes the
same point from the install side: `hypaware-ignore` is useful unenrolled,
and per-skill carve-outs lose to one rule.

`disable-model-invocation` is a Claude Code frontmatter key with no Codex
equivalent, so this policy is asymmetric by necessity: the Codex copies of
the three report skills stay model-invocable. That is acceptable because the
key is a discoverability preference, not a safety control - every one of
these skills still confirms before its consequential step.

## Consequences

- `docs/PRIVACY.md` names one skill for the whole privacy job.
- The local-cache boundary is stated in the skill's own description, so a
  user asking about server-side rows is told no rather than silently given a
  local answer to a remote question.
- A future operator-side review surface is a new decision, not a
  reinstatement of `hypaware-sensitive-scan`.
- `disable-model-invocation` is a judgment per skill against the test above,
  not a default. New bundled skills are discoverable unless invoking them
  publishes, mutates, or spends.

## Annotations

- `hypaware-privacy/SKILL.md` (both client plugins): `@ref LLP 0142#any-time`
  on the description, alongside the existing `@ref LLP 0100#skill`.
- `hypaware-ignore` / `hypaware-unignore` `SKILL.md`: `@ref LLP 0142#user-invoked-only`
  recording why these two stay model-invocable.
- The three report skills' `SKILL.md`: `@ref LLP 0142#user-invoked-only` on
  the frontmatter that carries the key.
