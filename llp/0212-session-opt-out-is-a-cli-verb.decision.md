# LLP 0212: the session opt-out is a CLI verb, not a pair of skills

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Usage-Policy, Onboarding
**Author:** Brendan / Claude
**Date:** 2026-08-12
**Related:** LLP 0049, LLP 0066, LLP 0067, LLP 0107, LLP 0142, LLP 0196

> `hypaware-ignore` / `hypaware-unignore` were written before
> `hyp session ignore` existed, so each carried its own `curl` against the
> gateway control route. Once [LLP 0067](./0067-session-opt-out.design.md)
> shipped the verb, the skills became a second implementation of it, and it
> drifted. This retires both skills, makes the CLI verb the only
> implementation, and moves the natural-language routing into
> `hypaware-reference`.

## Context

[LLP 0066 §context](./0066-session-opt-out.spec.md) records the original
order: the skills "advertise a clear, correct contract" that the gateway did
not yet serve, and the spec closed that gap "without changing the skills."
The inline `curl` in each `SKILL.md` was therefore never a design choice. It
was the only thing available when the skills were written.

[LLP 0067](./0067-session-opt-out.design.md) then shipped
`hyp session ignore` / `unignore` / `status`, which resolves the session id
for Claude and Codex, validates the reply the same three ways, reports set
membership rather than a drop (R14), and fails closed. From that point the
skills duplicated a tested implementation in untested shell, and the two
copies drifted in both directions the duplication allows:

- **Stale endpoint.** The skills fell back to `http://127.0.0.1:8787`. The
  real default is `127.0.0.1:18521` (`ai-gateway/src/config.js`, pinned to
  `DEFAULT_GATEWAY_ENDPOINT` by `test/core/init-gateway-listen-default.test.js`).
  `ANTHROPIC_BASE_URL` masked it except when the fallback was the thing that
  mattered.
- **A missing caveat.** [LLP 0066 §readable](./0066-session-opt-out.spec.md)
  R9 requires both ways an opt-out stops applying to be named. The CLI's
  `EPHEMERAL_NOTE` names the gateway restart *and* the fork;
  `hypaware-ignore`'s notes named only the restart, which is precisely the
  "taught that the other way cannot happen" failure R9 exists to prevent.

The same shell block also sat in `hypaware-privacy`, where the Codex copy had
already converged on the right pattern ("Prefer `hyp session ignore --json`,
which resolves the id and verifies the opt-out in one tested implementation")
while the Claude copy had not.

## Decision

<a id="cli-is-the-verb"></a>**`hyp session ignore` / `unignore` / `status` is
the only implementation of the session opt-out.** No shipped surface posts to
`/_hypaware/ignore/session` from shell in order to opt a session out. The
verb owns endpoint resolution, session-id resolution, reply validation, and
the wording of the receipt, so there is nothing left to keep in parity.

<a id="skills-retired"></a>**`hypaware-ignore` and `hypaware-unignore` are
retired.** With the body reduced to a single command, a skill adds nothing
over running that command: the user can type `!hyp session ignore` in Claude
Code directly, and the mechanism is identical.

<a id="routing-moves-to-reference"></a>**The natural-language routing moves
into `hypaware-reference`.** The opt-out utterances ("don't record this",
"ignore this session", "pause logging", "resume recording") are named in that
skill's `description`, and its body carries the verbs and the in-memory
caveat. `hypaware-reference` already owns "what is local-only versus opt-in"
and, before this change, said nothing at all about the session opt-out, which
was its own gap: a user who wanted to run the command themselves had no
documented path to its name.

## Costs

This is a deliberate trade against
[LLP 0142 #user-invoked-only](./0142-privacy-surface-and-skill-discoverability.decision.md#user-invoked-only),
which argued the opt-out must stay reachable in the user's own words and kept
the two skills model-invocable for exactly that reason. That argument is not
withdrawn: reachability by utterance is still the requirement, and it is
still met. What changes is that it is met by a description line inside a
general orientation skill rather than by a dedicated skill whose whole
description is that one job. The routing is one hop less direct, and a
future edit to `hypaware-reference`'s description could silently weaken it in
a way a dedicated skill's description could not.

Accepted because the duplicated implementation was a live correctness problem
(a wrong port and a missing R9 caveat, both shipped) while the routing cost
is a discoverability margin, and because Codex, which never had these skills
at all, gains the documented opt-out it lacked.

## Consequences

- The `@hypaware/claude` plugin ships four skills, not six.
- `docs/PRIVACY.md` and `README.md` name `hyp session ignore` rather than a
  skill, and both now state the fork caveat alongside the restart one.
- `hypaware-reference` is identical across the Claude and Codex copies
  (`test/fixtures/skill-host-divergence.json` records `claude-only 0,
  codex-only 0`), where it previously diverged on the one line that named the
  retired skill.
- `test/plugins/ai-gateway-session-ignore-receipt.test.js` binds R14 to the
  CLI and to the two `hypaware-privacy` copies only. The retired skills'
  assertions are gone, and the removal verb's receipt stays covered by the
  CLI-level test in the same file.
- `hypaware-privacy` still carries its own shell fallback for the case where
  `hyp` is unavailable. That is out of scope here and remains bound by
  [LLP 0066 R14](./0066-session-opt-out.spec.md); folding the Claude copy onto
  the Codex copy's CLI-first framing is a separate change.

## Annotations

- `claude/skills/hypaware-reference/SKILL.md` and the Codex copy: the
  hand-off bullet naming `hyp session ignore` carries
  `@ref LLP 0212#routing-moves-to-reference`.
