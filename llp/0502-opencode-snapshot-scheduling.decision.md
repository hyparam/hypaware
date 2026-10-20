# LLP 0502: Bound OpenCode snapshot scheduling

**Type:** Decision
**Status:** Accepted
**Systems:** Sources, Plugins
**Author:** Phil / Codex
**Date:** 2026-10-15
**Related:** LLP 0306

## Scheduling {#scheduling}

OpenCode events wake the SDK snapshot lane of LLP 0306. A 25 ms debounce alone
can repeatedly read, encode and send a growing conversation while it streams,
and permits overlapping reads when another event arrives during I/O.

Each plugin instance owns a queue containing only the latest event for each
session, one timer and at most one in-flight snapshot. Starts are separated by
at least one second. An isolated burst retains the existing 25 ms debounce;
events never postpone a cooldown timer or another session's queued work. Events
received during a read or upload request one trailing refresh, without waiting
in the OpenCode event callback. FIFO selection prevents a busy session from
starving another queued session.

The queue holds at most 128 session IDs and event names, never transcript
payloads. At capacity, new activity evicts the oldest pending session; native
session export remains the recovery path for an evicted or failed snapshot.
SDK reads and upload share a five-second abort signal. Disposal clears queued
work and cancels active I/O; timers do not keep OpenCode alive. Neither failure
nor timeout retries without another event or an explicit history import.

The cadence keeps HypAware's local capture responsive while bounding repeated
work. No runtime dependency or scheduler configuration is added.
