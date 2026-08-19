# LLP 0254: The OTEL path settles at ingest, so flush-time settlement and its late drop are not used

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Cache, Plugins, Privacy
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0027, LLP 0049, LLP 0050, LLP 0085, LLP 0103, LLP 0262 (the
RFC this decision realizes, accepted 2026-08-17), LLP 0252, LLP 0257

> Events carry `message.uuid`, so a row's identity is known when it is written
> and there is no provisional row to settle later. The usage-policy check runs
> inline at ingest with cwd in hand, so there is no late-resolved drop either.
> Both mechanisms stay exactly as they are for the proxy and backfill paths.

## Context

LLP 0027 exists because the proxy sees an exchange before the session's
identity is known, so rows are written provisionally and repaired at flush.
LLP 0085 exists because that repair window let a row whose `.hypignore` verdict
resolved late slip through. Neither cause is present when the producer stamps
identity on every event.

## Decision

### Native identity ends the settlement race {#identity-at-ingest}

**A row projected from an OTEL event is final when written.** `session.id`,
`message.uuid`, `prompt.id`, and `request_id` arrive on the event itself, so
nothing is provisional and the flush-time settlement pass of LLP 0027 has
nothing to repair on this path.

### The policy check runs inline, with cwd known {#policy-inline}

**`.hypignore` and the machine-local list (LLP 0049, LLP 0103) are evaluated at
ingest, before the row is written**, using the cwd the retained SessionStart
hook recorded and the existing usage-policy drop sentinel. A row that must not
exist is never written, rather than written and dropped later, so the fail-open
window LLP 0085 patches cannot reappear here: there is no window.

### The SessionStart hook stays {#hook-stays}

**The hook remains the source of `cwd`, `git_branch`, `git_remote`,
`head_sha`, and `repo_root`.** Events do not carry `workspace.host_paths` on a
plain local session (LLP 0262 spike finding), and deriving repo identity from
the body's system text is parseable but fragile. Removing the hook would cost
both the repo columns and the inline policy check that depends on them.

### Scope: this path only {#scope}

**LLP 0027 and LLP 0085 remain in force for the live proxy and for transcript
backfill.** They are not retired, superseded, or deleted; those producers still
write provisional rows and still need the late drop. This decision narrows
where the machinery runs, and nothing else.

## Consequences

- One less asynchronous repair stage on the hot capture path, and one less
  place a privacy verdict can arrive after the data does.
- The hook is now load-bearing for privacy on this path, not only for repo
  identity, so a session with no hook record has no cwd and must be treated as
  undetermined rather than as clean.
- Transcript backfill keeps its own settlement behavior, so a machine running
  both producers has both regimes live at once, which is expected and already
  the case today.
