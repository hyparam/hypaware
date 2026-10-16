# LLP 0507: the session-ignore control route requires a JSON body

**Type:** Decision
**Status:** Active
**Systems:** Gateway, Plugins, Sources, Privacy
**Author:** Phil / Claude
**Date:** 2026-10-16
**Related:** LLP 0066, LLP 0067, LLP 0256; hyparam/hypaware#1237,
hyparam/hypaware#1229, hyparam/hypaware#1236

> Extends [LLP 0066 §requirements](./0066-session-opt-out.spec.md#requirements)
> and [LLP 0067](./0067-session-opt-out.design.md)'s error taxonomy with one
> refusal: a mutating request to `/_hypaware/ignore/session` that does not
> declare `application/json` is answered 415 (Phil, 2026-10-05, on #1237).
> Both earlier documents are settled, so the rule lands here and each carries
> a forward-ref to it.

## Context

The shared control handler (`src/core/control/session_ignore.js`) parsed any
body it was sent. A `POST` carrying `content-type: text/plain`, a form, or a
multipart body is a CORS *simple* request: a browser sends it cross-origin
with no preflight, and its `Host: 127.0.0.1:<port>` passes the loopback Host
check, so any web page could reach the mutation on every host of the route.
Suppressing a real recording still needs an unguessable live session id; the
cheap effect was growth of the ignored-session set.

The compatibility cost that kept this open (#1229 item 2) no longer holds:
both shipped `hypaware-privacy` skills and every production and smoke caller
already send an explicit `content-type: application/json`.

## Decision {#json-only}

`POST` and `DELETE` on `/_hypaware/ignore/session` MUST declare a media type
of `application/json`. Any other media type, or none, is refused with
**415** and `{"error":"content-type must be application/json"}` before the
body is read, and the set is not touched.

- The media type is compared after dropping parameters and normalizing case
  (`application/json; charset=utf-8` and `Application/JSON` pass), the same
  reading the OTLP ingest path already uses for its own 415.
- The refused body is discarded through the same bounded `drainRequestBody`
  as every other refusal, so the request-drain and 64 KiB body bounds are
  unchanged.
- A refusal is observable but rate-limited: each handler counts every
  refusal and logs `session_ignore_unsupported_media_type` at warn at most
  once a minute, with `error_kind: unsupported_media_type`, the media type cut
  to 64 characters, and `rejected_total` (every refusal so far). The route is
  reachable by the page the gate refuses, so a line per refusal would swap set
  growth for unbounded log growth; the opencode snapshot route throttles its
  415 the same way.
- `GET` carries no body and acquires no media-type requirement.
- Methods, response shapes, Host protections, and the absence of permissive
  CORS headers are unchanged.

The gate sits in the shared handler, so it holds on every host that serves
the route (the gateway proxy, the shared OTLP listener behind the claude
telemetry source, and the opencode, pi, and cursor listeners), all of which
build the route from `createControlHandler`.

## Not decided {#not-decided}

This closes the preflight-free path; it does not claim to settle every
browser or loopback threat. A cross-origin `Origin` check, a custom request
header, a token, and a user config knob were not chosen and are not added.
