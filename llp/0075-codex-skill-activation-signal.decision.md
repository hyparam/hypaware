# LLP 0075: Codex skill activation = path-pattern on the `exec_command` SKILL.md read

**Type:** decision
**Status:** Accepted
**Systems:** Plugins, Sources
**Generated-by:** neutral
**Date:** 2026-07-06
**Related:** LLP 0073, LLP 0074, LLP 0076

> Codex shares **zero** skill-activation signal with Claude
> ([issue #229](https://github.com/hyparam/hypaware/issues/229) §challenges):
> no SKILL.md injection marker, no dedicated `Skill` tool, and its tool results
> are `role='tool'`, not `role='user'`. This decision settles the Codex rule:
> a `Session -ran-> Skill` edge is derived from an `exec_command` tool call
> whose command string reads `.codex/skills/<name>/SKILL.md`.

## Decision

Match `part_type='tool_call' AND tool_name='exec_command'` rows whose command
string (`tool_args.cmd`, the wire shape pinned by this repo's Codex projector
fixtures; fallback `tool_args.command`) contains a path matching

```
[\/~]\.codex\/skills\/([^\/\s'"]+)\/SKILL\.md
```

The captured `<name>` is the skill; the edge carries `dispatch_shell_read`
(LLP 0078) so consumers can distinguish this inferred signal from Claude's
richer ones.

Example from the recordings (Codex running `hypaware-query`):

```
exec_command: sed -n '1,240p' /Users/<user>/.codex/skills/hypaware-query/SKILL.md
```

## Why it cannot share the Claude rule {#no-shared-rule}

Every assumption in the Claude derivation (LLP 0074) fails on Codex: there is
no injection marker (a Claude-shaped rule returns **zero** for Codex), no
`Skill` tool call, no `<command-name>` tag, and the message-shape assumptions
differ (`role='tool'` results vs Claude's `role='user'`). Codex's only
activation trace is a plain shell read of the skill file. Forcing one shared
rule would either silence Codex or loosen Claude's filters — both worse than
two small per-client rules living side by side in the same contract.

## Accepted ambiguity: read ≡ activation {#read-is-activation}

A shell read of `.codex/skills/<name>/SKILL.md` is indistinguishable from
merely *inspecting* the file, except by the path pattern itself. Accepted:
the `~/.codex/skills/` tree exists to be read at activation time, inspection
reads of one's own installed skills are rare, and the mis-signal is bounded
(it can only name an actually-installed skill). The distinct
`dispatch_shell_read` flag keeps the weaker provenance visible instead of
laundering it into the Claude-grade signals. The honest fix is capture-side
(LLP 0076), not a smarter regex.

## Rejected alternative: `<skills_instructions>` roster {#rejected-roster}

Codex's `developer`-role `<skills_instructions>` block is a clean
per-conversation **availability** roster — but availability is not activation;
minting `ran` edges from it would assert usage that never happened. It stays
unused here. (It is the natural future source for an `offered` edge / the
adoption-gap denominator — out of scope for #229, noted for the capture-side
design LLP 0076 anticipates.)
