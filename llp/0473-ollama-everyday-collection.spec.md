# LLP 0473: Everyday installed Ollama collection

**Type:** Spec
**Status:** Accepted
**Systems:** Onboarding, CLI, Config, Gateway, Plugins, Sources, Observability
**Author:** HypForge designer
**Date:** 2026-10-07
**Related:** LLP 0468, LLP 0469, LLP 0130, LLP 0466
**Extends:** LLP 0468, LLP 0469 (installed lifecycle, native client compatibility and mixed-content markers)
**Source:** [HYP-71](https://linear.app/hyperparam/issue/HYP-71/complete-ollama-collection-detection-onboarding-routing-and-capture), issue UUID b3a15c80-6744-47c1-ae6b-f25d9e93dc6d, revision 2026-10-07T22:28:19.870Z
**Extended-by:** LLP 0474 (technical design)

## Intent {#intent}

An existing Ollama user can discover Ollama in normal HypAware setup, enable it,
route a supported native client, verify a persisted conversation, stop recording
and restore direct use. The primary path uses an installed HypAware daemon and
ordinary commands, without hand-editing JSON or a disposable developer install.

HYP-71 is a new follow-up to merged PR #2540. Completed mission HYP.0.39 and
the earlier API capture evidence remain complete. Source and owner were freshly
verified on 2026-10-07 at 22:34Z under mission HYP.0.71. Full source, provenance
and stage checkpoints live in the mission's SOURCE.md and source-check files.

@ref LLP 0468#requirements: preserve completed snapshots, local storage, unknown context, usage and bounded transport
@ref LLP 0469#exchange-scope: retain exchange-local identity without listener-lifetime state

## Required behavior {#requirements}

1. Offer Ollama through the declarative picker, even when detection misses it.
   Detection suggests selection only. Distinguish installation evidence,
   reachable configured local service and installed model availability with
   bounded probes. Do not infer, download, scan networks, start or reconfigure
   Ollama for detection.
2. Fresh setup, adding to an existing installation, repeat setup and the existing
   noninteractive configuration path compose the adapter and gateway, preserving
   unrelated choices and custom upstreams. Show direct upstream, actual capture
   endpoint, supported clients and any remaining routing step. Enabled is not
   evidence of capture. Explain export sinks, unknown cwd/repository, directory
   exclusion limits and the absence of history import and outage replay.
3. Integrate `hyp client attach ollama`, `detach` and status with the established
   recording switch and organization policy. Settle explicit, scoped, reversible
   routing before implementation. Cover ordinary local text `ollama run` and
   native API/SDK clients, with the minimal discovery/control and generation
   endpoints their actual supported versions require. Do not repoint the Ollama
   server at the gateway or silently rewrite global shell/service settings.
4. Attach/detach are idempotent. Detach stops new recording for already-running
   routed clients, keeps prior rows and other clients, and restores direct use
   where HypAware owns routing. Setup, update and reconciliation do not undo
   detach. State collector-outage and endpoint-change recovery truthfully;
   transparent failover requires its own implementation and proof.
5. Verify actual CLI/SDK request shapes, default streaming and explicit
   nonstreaming against named versions. Admit harmless supported text controls,
   including `think: false`. Preserve supported text and ordered image/file
   markers using existing parts and metadata. Strip media payloads and explain
   omission; do not discard a completed supported exchange merely because its
   media bytes are omitted. Cover text plus image, media-only messages and
   media in tool-result content where the selected protocol supports it.
6. Failed, interrupted, malformed, unsupported and over-budget exchanges remain
   distinct from intentional media omission. Preserve snapshot identity,
   repeated context, honest missing usage, one current-response usage carrier
   and bounded exchange-local state. Tools and thinking retain unsupported
   semantic handling; media parity does not grant them support.
7. Provide a guided first-capture check using an existing model and a bounded
   wait for correlated persisted rows. Normal status/client status distinguishes
   configuration and routing readiness, no traffic, successful persistence,
   disabled recording and capture failures without SQL. Bounded, secret-safe
   default diagnostics cover unsupported shapes, unavailable upstream,
   malformed/interrupted streams, transport budget loss and append failure.

@ref LLP 0130#picker-block: manifest data owns picker presence and detection
@ref LLP 0466#switch: reuse recording false on the owning plugin entry
@ref LLP 0466#central-refuses: preserve organization policy and refusal before mutation
@ref LLP 0466#reattach-paths: only explicit attach resumes a detached client

## Extension boundaries {#extension}

This request extends the earlier pilot's exclusions of managed lifecycle,
ordinary CLI routing, required native generation endpoints and mixed media
markers. It replaces its developer-only primary recipe and stated production
diagnostic limitation for this new journey. It preserves the delivered capture,
identity, usage, privacy and bounded-resource contracts.

Full media-byte storage/retrieval, new audio/video processing, tool-call or
thinking-output support, transcript/history import, crash-before-append replay,
OpenAI-compatible parity and OpenClaw live steering remain separate. A narrowly
required dependency must be evidenced and brought to the owner. Reuse the plugin,
picker, registry, recording/config and storage contracts. No new runtime
dependencies or speculative schema/config fields.

## Acceptance {#acceptance}

Deterministic checks cover detection, preserved configuration, repeated setup,
routing/undo, running-client detach, status, supported defaults and mixed content.
Hermetic coverage follows setup -> route -> capture/query -> restart ->
detach/direct use, checking visible outcomes and run-correlated telemetry.

At the exact independently reviewed candidate, exercise named actual Ollama
CLI/SDK versions and an existing model through the normal installed daemon.
Prove correlated persistence, restart retention, detach enforcement and fresh
direct use. Earlier pilot evidence and curl fixtures cannot accept this journey.
User documentation makes installed setup primary and includes scope, diagnosis
and stop/resume guidance. CPU/memory review verifies bounded probes, diagnostic
retention and no per-status history scans or listener-lifetime growth.
