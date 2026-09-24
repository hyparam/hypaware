# LLP 0430: Manual acceptance procedures are retired

**Type:** Decision
**Status:** Accepted
**Systems:** Process, Docs
**Author:** Kenny
**Date:** 2026-09-23
**Related:** hyparam/hypaware#2133
**Extends:** LLP 0157, LLP 0161, LLP 0171, LLP 0172, LLP 0173, LLP 0193,
LLP 0306, LLP 0374, LLP 0393, LLP 0406, LLP 0141, LLP 0164, LLP 0313

## Decision {#decision}

The repo no longer keeps written manual acceptance procedures.
`docs/ACCEPTANCE.md` is deleted, and the "acceptance smoke" tier is gone from
the repository guidance. That leaves two test tiers: traditional tests and
hermetic smokes. The release checklist keeps its smoke battery and its
`npm pack` / `npx` run on a macOS host and a Linux host. It no longer requires
running or recording a per-adapter procedure, a durable-cache upgrade
procedure, the Claude OTEL shape check, or the LaunchAgent supervisor check.

## Why {#why}

`docs/ACCEPTANCE.md` had grown to about 2,100 lines that mixed three things:
manual procedures that were not being run, rationale the LLPs already record,
and dated run logs. The docs are being published, and a public procedure
nobody follows is worse than none. It tells readers a gate exists when it
does not.

## What this retires {#retired}

Each requirement below was a manual procedure in `docs/ACCEPTANCE.md`, or a
rule that one had to run before a release. They are retired by this decision,
not satisfied:

- LLP 0157 R12 and LLP 0171 R11: the OpenClaw capture procedure and the rule
  that a human runs it before the adapter ships. The design and plan sections
  for it in LLP 0161, 0172, and 0173 are kept as history.
- LLP 0193: running the codex-backend `api: "cli"` probe with every release
  that touches the OpenClaw adapter. The probe is still an open question in
  that doc.
- LLP 0306: manual OpenCode CLI/Desktop acceptance for releases that touch
  the adapter.
- LLP 0374 #operator-contract: `github_since_inclusivity` as the home of the
  operator-facing contract and of the open `since` inclusivity question. The
  contract is stated in LLP 0374 itself; the question stays open.
- LLP 0393 #validation: the installed-daemon outage soak and cross-version
  spool checks as manual release gates.
- LLP 0406: the real macOS LaunchAgent check when the rendered plist changes.
- LLP 0141 and LLP 0164: the Codex Desktop capture procedure as the check
  that confirms Desktop traffic lands on real hardware.
- LLP 0313: the Codex login-switch procedure as the real-traffic check of
  credential routing.
- Draft docs LLP 0365, 0411, and 0416 had their procedure references edited
  directly: the LaunchAgent supervisor check, the GitHub OAuth browser check,
  and the Pi real-client release gate.

## Consequences {#consequences}

The hermetic smokes do not prove real-client or installed-daemon behavior,
and nothing now requires a human to check it before a release. A boundary
that only a real client or a real launchd can show (an upstream event rename,
a LaunchAgent environment value) can regress silently until a user reports
it. When one of those gaps matters enough, the fix is an automated check or a
new LLP that brings back a specific gate, not a revived procedures doc.
