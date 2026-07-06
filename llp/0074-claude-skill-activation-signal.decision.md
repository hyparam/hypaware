# LLP 0074: Claude skill activation = strict three-surface union with a built-in exclusion list

**Type:** decision
**Status:** Accepted
**Systems:** Plugins, Sources
**Generated-by:** neutral
**Date:** 2026-07-06
**Related:** LLP 0073, LLP 0075, LLP 0076

> Claude records skill activation three different ways, none authoritative
> ([issue #229](https://github.com/hyparam/hypaware/issues/229) §challenges).
> This decision settles which signals mint a `Session -ran-> Skill` edge for
> Claude sessions: **the union of all three surfaces, each under a strict
> filter**, with a static built-in exclusion list gating the slash surface —
> and records why loose matching and every single-surface alternative were
> rejected.

## Decision

A Claude skill activation is derived from **any** of:

1. **`Skill` tool call** — `part_type='tool_call' AND tool_name='Skill'`,
   name = `tool_args.skill`.
2. **SKILL.md injection marker** — `role='user' AND part_type='text'` and
   `content_text` begins **at offset 0** with
   `Base directory for this skill: <abspath>`; name = basename of the base
   directory.
3. **Slash command** — `role='user' AND part_type='text'` and `content_text`
   begins at offset 0 with `<command-name>x</command-name>`; name = `x` minus
   any leading `/`, **excluding** names in a static
   `CLAUDE_BUILTIN_COMMANDS` list (§builtin-exclusion).

Each surface independently mints the `Skill` node and the `ran` edge, stamped
with its own dispatch flag (LLP 0078), so no edge can dangle and the union
needs no cross-row correlation.

## Strict filters, not loose matching {#strict-filters}

The issue measured that loose matching — marker or skill-name text anywhere,
any role — pulls **~23% false positives**: the assistant *discussing* skills,
`grep`/`cat` of SKILL.md files, query output echoing recorded markers,
analytics conversations about skill usage polluting their own signal. Only
`role='user'` + `part_type='text'` + a **leading anchor at offset 0** was
clean. So the filters are not tuning parameters; they are the decision. The
anchor is enforced twice (SQL prefix-`LIKE` and an offset-0 regex in `toRow`)
because it is the entire false-positive defense.

## Why the union, not one surface {#why-union}

- **Marker-only** rejected: the marker is convention, not contract —
  unversioned Claude Code prose whose wording change silently drops the signal
  to zero. Riding three independent surfaces means a breakage in one degrades
  coverage instead of zeroing it (the tool call and slash tag are
  machine-generated shapes, not prose). Marker-only would also flatten the
  dispatch distinction LLP 0078 exists to keep.
- **Tool-call-only** rejected: it misses the prompt/slash-invoked skills
  entirely — the issue counted ~33 sessions with a marker and **no** `Skill`
  tool call, and those are exactly the report skills this feature serves.
- **Slash-only** rejected: `<command-name>` conflates skills with built-ins
  and misses model-chosen activations.

## Built-in exclusion list {#builtin-exclusion}

`<command-name>` cannot mean "a skill ran" without knowing which names are
skills. A live catalog of installed skills would make projection depend on
machine state at projection time — breaking the pure-function-of-the-row rule
(LLP 0073 §boundedness-contract). So the slash surface is gated by a **static
in-code exclusion list of Claude Code built-ins** (`/model`, `/compact`,
`/review`, `/clear`, `/help`, `/config`, … — the full list lives with the code
and is trivially editable). Deterministic, reviewable, and cheap.

**Accepted residuals** (recorded, not solved): the list drifts as Claude Code
adds built-ins — a new built-in mints a spurious `Skill` until the list is
updated; custom slash commands that are not skills mint as skills; a
hand-pasted SKILL.md at offset 0 of a user message is indistinguishable from a
real activation. All three are bounded, visible-in-the-graph errors, and all
three vanish under the capture-side `skill_activated` event that LLP 0076
records as the honest end state. Mitigating factor for drift: every *skill*
slash invocation also injects the surface-2 marker, so the exclusion list only
guards against built-in noise, never against missing a real skill.
