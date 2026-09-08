# LLP 0392: GitHub capture projects automatically

**Type:** Spec
**Status:** Accepted
**Systems:** Graph, Sources, Plugins
**Author:** Phil / Codex
**Date:** 2026-09-08
**Extends:** LLP 0023, LLP 0360
**Related:** LLP 0032, LLP 0096, LLP 0361

> Enabled GitHub capture maintains its own graph projection. An operator no
> longer needs to run `hyp graph project` after GitHub polling or backfill.

## Request {#request}

The user requests automatic projection after inspecting local GitHub capture.
This extends the manual-only trigger in LLP 0023#on-demand-projection and
LLP 0360#capture-regimes. Repository selection, activation, capture budgets,
graph identities, and merge rules retain their existing meaning.

## Capability {#capability}

The graph capability adds `project(sourceDataset)` at version 1.1.0. It uses
the existing projection engine and runs only contracts registered for that
dataset. An unknown dataset fails instead of widening to every contract.
GitHub requires this capability version and requests `github_events` after
the shared poll/sync/backfill capture tick has persisted its cursors.

The graph plugin owns the engine; GitHub owns the trigger. It adds no timer,
kernel hook, config key, dependency, or separate scheduler. AI session
projection remains manual, including the session side of cross-source links.

## Retry and lifecycle {#retry}

Each activation starts with projection due, catching up already-captured
events on the first tick even when GitHub returns no new rows. Successful
appends mark projection due again. Success clears this in-memory flag;
unchanged ticks then do no projection work.

Projection failure leaves it due, logs the failed step, and appears in the
tick's errors, command exit status, and daemon source error. Capture cursors
are already persisted and are not rolled back. The next capture tick retries
even if it appends nothing. A restart resets the optimization and therefore
also retries durable work without introducing another sidecar or cursor.
Partial capture and inventory errors do not prevent projecting durable rows.

The source awaits projection before scheduling its next tick, and stop waits
for the in-flight projection. Failures use the existing capture cadence;
projection errors alone do not select the shorter backlog interval.

## Cost and validation {#cost}

Projection runs at most once per completed tick. The existing engine scans
the GitHub source once and reads committed graph ids for deduplication. Cost
still grows with GitHub history and graph size; this is not incremental
projection. It retains the existing finite query heap budget and only one
boolean of additional long-lived state. Idle ticks after success skip those
scans; unrelated source contracts are never scanned by this trigger.

Traditional tests cover first-run catch-up, new rows after idle, failed
projection after durable cursor advancement, retry without new capture,
restart, command failure, and stop/status behavior. The `github_local_capture`
smoke must find GitHub nodes and edges before an explicit graph command,
assert that session nodes have not been projected, and verify projection
completion telemetry. Subsequent session projection still converges on the
shared Repo identity.
