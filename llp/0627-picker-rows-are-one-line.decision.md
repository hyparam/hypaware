# LLP 0627: Picker rows are one plain line

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins
**Author:** Kenny / Claude
**Date:** 2026-11-25
**Related:** LLP 0407 (#plain-words: extended here to every picker row), LLP 0358 (#claude-code-consequences: relaxed here), LLP 0391 (#decision: relaxed here)

> Setup picker summaries had grown into paragraphs of caveats. A row now
> says what it records and what setup changes on the machine, and nothing
> else.

## Decision {#decision}

<a id="one-line"></a>Each picker row summary is one or two short sentences:
what the row records, plus the local side effects setup causes (edits a
client's settings, adds a hook, plugin file or skills, opens a local port).
Implementation limits, routing details, missing fields, retention, and
migrations stay out of the row; they belong in docs and command output.

<a id="no-history"></a>Rows do not mention history import. Nearly every
recording row imports past sessions, so stating it on some rows and not
others reads as a difference that does not exist. The older
requirements are relaxed to match:

- LLP 0358 #claude-code-consequences: the Claude Desktop row still says it
  records Claude Code and edits Claude Code's settings, but no longer names
  the history import.
- LLP 0391 #decision: the OpenClaw row no longer states that its import
  recurs on a schedule.

The `backfill.on_join` opt-out and the attach enable prompts are unchanged.
