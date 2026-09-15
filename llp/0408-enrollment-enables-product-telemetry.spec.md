# LLP 0408: Enrollment enables product telemetry

**Type:** Spec
**Status:** Accepted
**Systems:** Observability, CLI, Daemon, Privacy
**Author:** Phil / Codex
**Date:** 2026-09-15
**Extends:** LLP 0393#policy, LLP 0393#validation

## Policy {#policy}

The remote server is the SaaS offering. New and existing enrolled users with
no saved telemetry preference automatically collect and deliver the product
telemetry defined in LLP 0393 to their enrolled organization. This replaces
the default-off requirement for these users; standalone installations remain off.

Derive eligibility from exactly one central sink in the current central config
layer (active slot or join seed), a safe destination, and its matching persisted
gateway identity with an organization claim. Honor custom identity paths.
An identity alone, a query-only remote, missing or malformed enrollment, or
ambiguous destinations do not enable reporting. No new config key is needed.

Every saved local preference takes precedence, including `off` and `local`.
Unreadable or malformed preference files fail closed. The existing commands
remain the controls; status identifies the derived policy as
`enrolled_organization`. Explicit organization opt-ins retain their existing
destination and generation guards.

Automatic queue bindings include destination, gateway and organization, and a
distinct automatic generation. Credential refresh and config-slot switches
preserve the binding; changing enrollment invalidates queued copies. Removing
the central layer disables automatic collection and delivery even if credentials
remain on disk. Returning to the same gateway and organization can deliver its
still-valid pending automatic copies within the existing seven-day retention.
An explicit preference change starts a fresh generation and discards old copies.

## Runtime and validation {#validation}

Eligibility is read at client construction and rechecked before emission and
delivery. Existing users take the default on their next CLI invocation or daemon
start after upgrade; fresh enrollment takes effect once credentials exist and a
new client starts (normally the config-apply restart). No extra polling timer,
customer-data scan, dependency, or operational OTEL activation is introduced.
Central config reads use the existing 1 MiB limit; identity and preference reads
remain bounded. The queue, runtime cadence and capability/backoff limits in
LLP 0393 remain unchanged. The server must enable its existing receiver.

Tests cover seed and applied enrollment, upgrade without a preference, explicit
overrides, malformed state, custom identity paths, refresh, removal and changed
organizations. The product telemetry smoke derives the policy from enrollment
and proves authenticated delivery with durable replay and run-specific logs.
