# LLP 0606: First-sync release keeps local evidence

**Type:** Decision
**Status:** Proposed
**Systems:** CLI, Sinks, Usage-Policy, Daemon
**Date:** 2026-11-16
**Related:** LLP 0101, LLP 0578, LLP 0596

@ref LLP 0596#yes-releases [extends]: preserve the release command while separating caller attribution from confirmation method

## Attribution {#attribution}

A terminal prompt establishes an input method, not human consent. Common agent
environment signals produce `agent-pty` or `agent-yes-flag`; other callers are
`unknown`. Configuration such as CODEX_HOME alone is not an agent signal. These
labels are diagnostic hints, never an authentication boundary. The existing
`--yes` release remains supported. This change does not add signed-in browser
approval or claim that an agent cannot release the window.

## Atomic local release {#atomic-release}

Before a manual early release, replace the still-enforcing marker with a flushed
receipt containing its deadline, release time, caller attribution and input method.
Rename it to `usage-policy/first-sync-release.json`: that atomic rename removes
the hold and preserves evidence together. If preparation or rename fails, the
marker continues to enforce its original deadline and the command sends nothing.
The latest receipt is one bounded file, read with a 4 KiB limit by status. It is
local diagnostic evidence, not a tamper-proof security audit.
Enrollment writes and early releases reuse the existing file lock, re-reading
the deadline inside it, so competing callers cannot recreate a released marker
or overwrite a later enrollment's deadline from an earlier plan.

Organization-disabled holds use the same receipt with organization attribution;
their fail-open behavior on removal failure remains LLP 0578's decision. Expiry
still removes the marker and records expiry without inventing a human release.

## Local logs and status {#visibility}

Mirror creation, expiry and release into the ordinary root daemon.log without
requiring developer telemetry. The release receipt remains available if that
append fails, and the failure emits a warning. Log the first successful export
per live sink handle; weak ownership bounds this bookkeeping and avoids an
append or disk flush on every scheduled export. Each daemon lifetime may record
its first success again. Only curated scalar metadata is written, never URLs,
credentials or captured content. Status shows the latest release time and caller
without claiming verified human approval. Existing release and expiry rules stand.
