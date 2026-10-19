# LLP 0517: LangGraph records through a bounded local journal

**Type:** Spec
**Status:** Draft
**Systems:** Sources, Plugins, Onboarding, Privacy
**Author:** Phil / Codex
**Date:** 2026-10-16
**Related:** LLP 0011, LLP 0012, LLP 0130, LLP 0252, LLP 0306, LLP 0403

## Requested integration {#onboarding}

Ship a bundled LangGraph plugin, offered under Customize without detection or
first-run express selection. Global setup has no project to inspect. Reuse
`hyp client attach langgraph` to enable it later, including after Record
everything. Attach installs one managed module and prints its import and callback
example. It does not edit arbitrary applications. Detach uses the existing
managed-file undo and recording switch. JavaScript and Python callbacks share one recorder. Checkpoint import remains
separate work.

## Local transport {#journal}

The recorder writes completed normalized events into a private local journal
under HYP_HOME. The source drains that journal automatically, including records
left by an application that has exited. This removes a network delivery loop
from the application and makes collector outages ordinary pending files.

The journal has 256 fixed reservation slots, each holding at most 512 KiB.
Exclusive directory creation reserves a slot across producer processes; atomic
rename publishes a complete event. A failed or full journal never fails the
agent. Status on the callback reports dropped events and errors. Staging
slots abandoned for more than a day may be reclaimed only when their recorded
writer process no longer exists. Slots with unknown owners remain pending. No payloads are logged.
Drain at most 32 slots per pass, with one pass in flight and an unreferenced
one-second timer. Replay uses the existing session writer's persistent part-ID
dedupe. Remove an event only after successful persistence or a policy drop.

## Identity and information {#projection}

The application supplies a stable session ID. Graph invocation namespaces supply
child conversation and parent identities. New model responses use callback-run
IDs; repeated request history is not another billed response. Session rows
carry normal columns, tool definitions, visible text, tool results and usage.
Project facts are captured on the producer, never reconstructed during replay.
Callback run and parent IDs accompany the event in attributes. Generic raw
traces are not copied into a second dataset: conversation contents and policy
remain governed together in ai_gateway_messages.

The gateway owns schema expansion and dedupe (LLP 0252). The adapter reuses its
storage contracts without enabling a model proxy (LLP 0306). No new runtime
dependencies, dataset columns or provider credentials are required. Known
unsupported content is not represented as complete; reasoning content is not
recorded. Existing checkpoint history is not imported as newly generated output.

## Privacy and health {#privacy}

Both producer and consumer check the client recording switch, persistent session
exclusions, and folder policy before retaining content. Unknown or unreadable
policy fails closed. The consumer checks again at replay time. Local-only rows
retain cwd so the shared export filter withholds them. A loopback-only control
listener advertises the standard session-ignore routes. No model content is
accepted on that listener.

Health distinguishes waiting for an application from received activity and
reports pending work, drops, writes and failures. SDK errors are bounded scalar
status, never prompts or credentials. Memory holds at most a bounded run's
callback state and one drain batch; it does not retain a lifetime dedupe index.

## Python callback adapter {#python}

Python applications use their existing LangChain callback interface. The bundled
Python module starts one private Node helper per callback, using the installed
Node executable and managed module path printed by attach. This is a child of
the application, not a second daemon. It imports the same JavaScript recorder,
so projection, policy checks, journal ownership and durable acknowledgement
have one implementation. No new runtime packages are installed by HypAware.

The callback supports synchronous and asynchronous graph execution through
LangChain's synchronous callback dispatch. Its lock serializes concurrent callback
threads. IPC carries at most one 512 KiB event and one bounded acknowledgement;
a ten-second timeout closes a broken helper and marks capture failed without
failing the application. There is no background payload retry queue. Collector
outages do not interrupt this helper: completed events remain in the same disk
journal. A helper failure can lose unfinished callbacks and is reported through
callback status; a fresh callback can resume capture. `close()` or a context
manager releases the helper; finalization and interpreter shutdown also clean it
up. This trades one Node process per open callback for avoiding a second privacy
and projection implementation. Applications should reuse a callback across turns
and close it when the conversation ends.
