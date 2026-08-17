# LLP 0256: Session ignore reaches the claude listener over the same control route

**Type:** Decision
**Status:** Draft
**Systems:** Privacy, Plugins, Sources, CLI
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0049, LLP 0066, LLP 0245, LLP 0253, LLP 0257
**Spawned-by:** LLP 0245 (on acceptance), settled in hyparam/hypaware#798

> The claude telemetry listener hosts the same
> `/_hypaware/ignore/session` control route the gateway proxy hosts, over its
> own in-memory ignored-session set. `hyp session ignore` and
> `hyp session unignore` post to every listener that offers the route, and a
> partial success is reported, not swallowed.

## Context

LLP 0066's opt-out is an in-memory set living in the process that records the
exchange. With a second recorder in the picture, "don't record this
conversation" has to reach both, and only the recorders can answer whether it
did.

## Decision

### The listener hosts the route {#control-route-on-listener}

**The claude listener serves the same route shape, verbs, and response body as
the gateway control route**: `GET`, `POST`, and `DELETE` on
`/_hypaware/ignore/session`, idempotent mutations, and a
`{ session_id, ignored, total }` reply. One shape means one client, one skill,
and one set of tests. It is loopback-only for the same reason the listener is.

### The CLI posts to both {#cli-posts-to-both}

**`hyp session ignore` / `unignore` addresses every listener that offers the
route and reports each outcome.** A machine mid-migration has both recorders
live at once, so ignoring on one is not ignoring. A listener that is not
running is not a failure (it is recording nothing); a listener that is running
and refuses is.

### Still in memory, still nothing on disk {#in-memory-only}

**The set stays in memory and dies with the process, exactly as LLP 0066
requires.** No new on-disk contract is introduced. The durable expressions of
the same intent remain `.hypignore` and the machine-local list.

### An ignored session's bodies are deleted {#bodies-deleted}

**Ignoring a session makes its spooled bodies a deletion target, not a skip
target** (LLP 0253 #delete-on-drop). Without that, the transport works and the
content stays.

## Consequences

- `/hypaware-ignore` keeps working unchanged from the user's side across the
  attach-mode switch, which is the point.
- The ignore reaches only sessions whose ids the recorder can see; an exchange
  already projected before the ignore arrives is still recorded, exactly as
  under LLP 0066 today.
- A second host of the route means the route's tests move to a shared shape
  rather than being duplicated per plugin.
