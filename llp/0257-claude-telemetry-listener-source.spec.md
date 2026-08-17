# LLP 0257: The Claude telemetry listener source

**Type:** Spec
**Status:** Draft
**Systems:** Sources, Plugins, Privacy, Observability
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0012, LLP 0015, LLP 0016, LLP 0021, LLP 0030, LLP 0032,
LLP 0049, LLP 0066, LLP 0103, LLP 0245 (the RFC this spec realizes; Draft until
0245 is accepted), LLP 0251, LLP 0252, LLP 0253, LLP 0254, LLP 0255, LLP 0256
**Tracker:** hyparam/hypaware#798

> The source that receives Claude Code's own telemetry: an OTLP http/json
> listener plus a body-file reader, registered by `@hypaware/claude`, producing
> `ai_gateway_messages` rows and `claude_telemetry_events` rows. This is the
> requirements document the listener implementation and its tests answer to.
> The decisions it composes are LLP 0251 through LLP 0256; the rationale lives
> there and in LLP 0245, not here.

## Summary

A **listener source** in the sense of LLP 0012: it owns a daemon lifecycle,
implements `start`, returns a `StartedSource`, and writes rows into the
intrinsic cache. It never sees sinks. What is new is that one source has two
inputs (an HTTP endpoint and a directory) and two outputs (two datasets).

## Ownership and registration {#registration}

- **S1** The source is contributed by `@hypaware/claude` through the kernel
  source registry, with its own name and its own config section. The plugin
  also contributes and registers the `claude_telemetry_events` dataset
  (LLP 0255 #owned-by-claude).
- **S2** The OTLP http/json server machinery (routing, content-type and
  encoding handling, `partialSuccess` envelopes) is shared with
  `@hypaware/otel` rather than copied. Payload interpretation is
  Claude-owned.
- **S3** The listener binds loopback-only, on its own port, separate from the
  `@hypaware/otel` receiver and from the gateway. The port is config with a
  default; `0` requests a dynamic port and the bound port is what attach
  writes into the settings `env` block (LLP 0251 #env-keys).
- **S4** The self-telemetry loop guard of LLP 0021 applies: the daemon's own
  exports must never be ingested by this listener.

## Endpoint contract {#endpoint}

- **S5** Accepts OTLP over HTTP with `Content-Type: application/json` on the
  logs and metrics paths. Protobuf is out of scope, as it is for the existing
  OTLP receiver.
- **S6** Serves the session-ignore control route on the same listener,
  identical in shape to the gateway's (LLP 0256 #control-route-on-listener).
- **S7** Rejects non-loopback peers, and answers anything else with a
  well-formed OTLP error rather than a crash: an exporter that cannot be
  fixed from our side must not be able to stop the daemon.

## Ingest {#ingest}

- **S8** Events are the primary producer and are projected once each
  (LLP 0252 #events-first). Row identity comes from `message.uuid`.
- **S9** Body files named by `api_request_body.body_ref` are read only for
  `system_text`, the `tools` list, message ordering, and untruncated tool
  arguments, then deleted (LLP 0252 #bodies-for-gaps,
  LLP 0252 #project-then-delete).
- **S10** The usage-policy check runs inline before any row is written, using
  the cwd recorded by the SessionStart hook (LLP 0254 #policy-inline). A
  session with no hook record is undetermined, not clean.
- **S11** A dropped session's spooled bodies are deleted (LLP 0253
  #delete-on-drop).
- **S12** The spool is created `0700` under the HypAware home, capped, and
  evicted oldest-first (LLP 0253 #spool-location, LLP 0253 #byte-cap).

## Outputs {#outputs}

- **S13** `ai_gateway_messages` rows carry the same projected-exchange values
  the live proxy and backfill producers yield today, with unchanged dedupe,
  partitioning, and repo identity columns (LLP 0252 #projection-unchanged).
- **S14** `claude_telemetry_events` rows are one per event, hot fields typed,
  the remainder in an `attributes` JSON column, with the source signal set for
  central forwarding (LLP 0255 #row-shape).
- **S15** `parent_uuid`, `logical_parent_uuid`, `user_type`, and
  `permission_mode` read null on this path by design.

## Status and capture health {#status-and-health}

- **S16** `status()` reports `state`, `rowsWritten`, and details carrying the
  bound address, the last event seen, and the spool's current byte size and
  eviction count.
- **S17** `hyp status` renders a capture-health line comparing last event seen
  against last transcript activity, and raises a diagnostics entry with a
  severity when the gap exceeds a threshold. Status keeps answering from the
  status file only.

## Failure modes {#failure-modes}

- **S18** Delivery is best effort. A down daemon loses events; content is
  recovered by transcript backfill, and behavioral-event loss in that window
  is accepted (LLP 0245 open question 1).
- **S19** A body that cannot be parsed or projected is deleted and counted,
  not retried forever (LLP 0252 #project-then-delete).
- **S20** An unrecognized event name is recorded in
  `claude_telemetry_events` with its attributes rather than discarded.
- **S21** Upstream shape drift is detected two ways: the capture-health line
  in production, and a release-gate shape assertion against the installed
  Claude Code.

## Observability {#observability}

- **S22** Per the repository's log-driven development rules, the listener
  emits structured signals at the boundaries that can fail: listener start,
  event batch received, body projected, body evicted, policy drop, dataset
  write, and control-route mutation, each with `component`, `operation`,
  `status`, and where applicable `error_kind`.
- **S23** No signal records credentials, raw prompt text, or hidden reasoning.
  Payload identity is carried by hashes or short redacted excerpts.

## Testing {#testing}

- **S24** The primary seam is a hermetic smoke: POST OTLP/JSON at the
  listener, drop body fixtures into the spool, drive the SessionStart hook,
  then assert rows out of `hyp query sql`, body deletion, and the capture
  spans. Tests never reach into projector internals.
- **S25** Privacy smokes cover the ignored-session case both ways
  (`.hypignore` and the control route): only clean rows land, the drop signal
  fires, and the ignored session's bodies are gone from the spool.
- **S26** Deterministic parts are unit tested in the root suite: spool cap
  eviction order, event-plus-body projection identity, capture-health
  rendering and its threshold.
