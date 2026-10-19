# LLP 0532: Setup asks the picked Claude Code for its version before writing anything

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, CLI, Onboarding
**Author:** neutral
**Date:** 2026-10-17
**Extends:** LLP 0258 (#version-floor)
**Related:** LLP 0363 (#version-floor-is-retryable), LLP 0135 (#progress), issue #975

> [LLP 0258](./0258-attach-injects-telemetry-via-settings-env.decision.md) is
> Accepted, so it is not edited. Its #version-floor makes `claude` attach refuse
> below 2.1.193, and that refusal stays where it is. What 0258 does not say is
> when setup learns about it: today a user with an old Claude Code answers every
> question, the config lands, and only then does attach refuse. This records an
> earlier, read-only check that `hyp setup` runs for the picked Claude Code, and
> what setup does with its answer.

## Context {#context}

Issue #975 came out of an onboarding session where an old Claude Code was found
only at the attach step, after the user had finished setup. The version and both
floors were already known: `claude_version.js` resolves the installed release
(`HYP_CLAUDE_CODE_VERSION`, else `claude --version` with no shell and a 3 s
timeout) and holds the attach floor, 2.1.193. LLP 0258 also names a second floor,
2.1.214, below which capture works but `tool_source` stays null.

The issue's triage settled the scope: reuse the resolver and the floors, unknown
stays unknown, refuse only the selected Claude path and before any Claude
settings change, keep the other clients, give the update and retry action, warn
on the second floor, keep the attach-time check, no automatic upgrade, and no
counted wizard step.

## Decision

### The verdict lives in the Claude adapter {#verdict}

A client registration may define an optional, read-only `preflight()` that
returns `{ refuse }`, `{ warn }`, or `{}`. Claude's reads the same resolver attach
uses and answers:

- **below 2.1.193** (`CLAUDE_OTEL_MIN_VERSION`): refuse, naming the version, the
  floor, `claude update`, and `hyp client attach claude` as the retry;
- **2.1.193 up to 2.1.214** (`CLAUDE_TOOL_SOURCE_MIN_VERSION`): warn that
  tool-decision detail needs 2.1.214, and proceed;
- **2.1.214 or newer, or a version that could not be read or parsed**: nothing.

Core never imports plugin code and has no idea what a Claude version is. It only
asks the adapters of the picked clients that define the method, so a run that
did not pick Claude runs no check at all, and every other client's path is the
one it was before.

### Setup asks once the pick is settled {#boundary}

The wizard asks right after the pick lane returns, before the recap, the
legacy-proxy preflight, the write of the folder answer, the config commit,
configure, and the finale. The interactive pick lane asks its folder question
itself, so that answer is given before the check runs, but it is not written
until later. That is the earliest point the picked set is known on every entry
path (interactive, `--yes` and explicit picks, `--dry-run`), and nothing has
been written yet. Only a run that goes on to attach asks. The check is not a lane: it
asks the user nothing, so it is absent from every itinerary and the step
denominator is unchanged (LLP 0135 #progress).

A detached client (`recording: false`) and a client whose owner failed to
activate are not asked, since the finale does not attach them either. A
preflight that throws gives no verdict.

`hyp client attach claude` keeps its own check (LLP 0258 #version-floor). It is
the JSON entry path and the one that runs after an upgrade, and it still catches
a release that changed between setup's question and the attach.

### A refusal skips Claude's attach, and only that {#refusal}

The refusal is printed once on stderr and the finale does not attach Claude, so
`~/.claude/settings.json` is not touched. The run summary records the attach as
failed. Every other picked client attaches as it would have. The exit status is
the one an attach refusal always had (warn and continue), so a scripted setup
that picked Claude and Codex still succeeds for Codex.

The Claude plugin entry stays in the config. Per LLP 0363 #version-floor-is-retryable
a version-floor refusal is retryable, so after `claude update` either
`hyp client attach claude` or the reconciler's next pass attaches without
re-running setup. Claude's skills, agents, and history import are not settings
and are left as they were.

A warning changes nothing but the output: Claude attaches.

## Consequences

- A user with an old Claude Code hears about it before the config is written,
  once, with the command that fixes it, and the rest of setup still happens.
- Setup runs one more `claude --version` than before, and only when Claude is
  picked. Attach keeps its own probe, so a setup that goes on to attach Claude
  probes twice, each bounded by the resolver's 3 s timeout; a refused Claude
  is probed once, and a setup without Claude not at all. The probe makes no
  network call: run with every proxy variable pointed at a logging listener it
  made no connection, opened no socket, and returned in about 10 ms.
- The attach-time refusal is unchanged. Setup never reaches it for a Claude Code
  it already refused, so the user sees the refusal once per setup; running
  `hyp client attach claude` before updating shows it again, as it always did.
- No automatic upgrade is attempted.
