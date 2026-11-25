# LLP 0627: Picker rows are one plain line

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins
**Author:** Kenny / Claude
**Date:** 2026-11-25
**Related:** LLP 0407 (#plain-words: extended here to every picker row), LLP 0358 (#claude-code-consequences: relaxed here), LLP 0391 (#decision: relaxed here), LLP 0167 (#onboarding: relaxed here), LLP 0171 (R12: relaxed here)

> Setup picker summaries had grown into paragraphs of caveats. A row now
> says what it records and what setup changes on the machine, and nothing
> else.

## Decision {#decision}

<a id="one-line"></a>Each picker row summary is one or two short sentences
that say what the row records. A row may name a setup step the user must
act on (reload an editor, restart a gateway) or a notable change, but it
does not have to list every change setup makes; brevity wins over
completeness. Implementation limits, routing details, missing fields,
retention, migrations, and the full list of setup changes belong in docs
and command output, not the row.

<a id="no-history"></a>Rows do not mention history import. Nearly every
recording row imports past sessions, so stating it on some rows and not
others reads as a difference that does not exist. The older
requirements are relaxed to match:

- LLP 0358 #claude-code-consequences: the Claude Desktop row still says it
  records Claude Code and edits Claude Code's settings, but no longer names
  the history import.
- LLP 0391 #decision: the OpenClaw row no longer states that its import
  recurs on a schedule.
- LLP 0167 #onboarding and LLP 0171 R12: the Claude row no longer names the
  OpenClaw case (an OpenClaw `claude-cli` backend is recorded as Claude Code),
  and the OpenClaw row no longer states its two capture tiers. Both are said
  in docs/integrations/claude-code.md and docs/integrations/openclaw.md.
- LLP 0180 #decision: the pick is still the consent for a sweep-backed
  provider's import, but no row states it. The import is what recording a
  tool means, and `backfill.on_join: false` still withholds it.

<a id="ollama"></a>The Ollama row carries no privacy warning. LLP 0474
#setup's warning (export sinks, no folder, no history import) stays in
`hyp ollama setup` output, which may print after the pick. With the folder
ask on, an Ollama chat has no folder and is not recorded at all
(LLP 0625).

The `backfill.on_join` opt-out and the attach enable prompts are unchanged.
