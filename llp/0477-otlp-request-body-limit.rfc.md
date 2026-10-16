# LLP 0477: A request body limit for the OTLP listener

**Type:** RFC
**Status:** Accepted
**Spawned:** LLP 0478 (option 1 decided)
**Systems:** Sources, Plugins
**Author:** HypForge steward / Claude
**Date:** 2026-10-09
**Related:** LLP 0012, LLP 0256, LLP 0257

@ref LLP 0257#registration [constrained-by]: one shared OTLP/JSON server hosts both the Claude telemetry and the generic OTEL source, so one limit reaches both
@ref LLP 0012 [constrained-by]: the generic OTEL source accepts any OTLP producer, so its batches are not bounded by what Claude sends

## Problem {#problem}

The shared OTLP/JSON listener (`src/core/otlp/server.js`) reads a request body
with no size limit. It decodes gzip or deflate first, keeps every decoded
chunk, then makes one contiguous copy, a string and the parsed object before
the handler runs. A sender therefore chooses how much memory the daemon holds:
on `f6db92db`, 8 KiB of gzip on the wire reached the handler as an 8 MiB body
with HTTP 200, and a larger ratio is a matter of choosing the input. The
listener binds to loopback by default (its `listen_host` can bind it to a
network address), and it lives in a daemon that runs for weeks, so one
misbehaving exporter can grow it without bound.

This also falls short of the OTLP/HTTP specification, which says a server
"MUST limit the size of the request body when parsing it, including after
decompression", "RECOMMENDED to use 64 MiB as the default limit", and "MUST
respond with HTTP 413 Content Too Large" when it is exceeded. The same section
says a client "SHOULD limit the size of the request body, including before
compression" with the same recommended 64 MiB default, and does not retry a
413.

## Why this needs a decision {#why-decision}

Any limit changes what the listener captures: today every well-formed body is
accepted, after the change some are refused and their records are lost (413
is not retried). A first attempt (PR #2557 at `941bd386`) used 20 MiB, the
OpenTelemetry Collector's default `max_request_body_size`, sized from single
Claude items (largest stored item 576 KB). Independent review showed that is
not enough for the generic OTEL source: a real OpenTelemetry JS SDK 0.223.0
with its default `BatchLogRecordProcessor` (512 records) and 48 KiB records
sends a 25,290,039-byte batch, which the base stores and 20 MiB refuses.
Single-item measurements do not bound batches, so the limit has to come from
the protocol, not from local samples.

## Options {#options}

1. **64 MiB decoded, fixed (recommended).** The specification's recommended
   server default, and the same default it recommends clients hold themselves
   to before compression. Any producer that sends more is refused and loses
   that batch, whether it was configured above the default or uses an SDK that
   bounds batches by record count rather than bytes (the JavaScript SDK
   0.223.0 does, so large enough records reach it on defaults). The 512-record SDK batch above fits with room
   for records up to about 128 KiB each. Peak memory per accepted request stays
   bounded (about twice the limit in buffers plus the string and parsed
   object), and compression bombs stop at the limit. No configuration key.
2. **64 MiB default, configurable.** As option 1 plus a new config key so an
   operator can raise or lower it, which the specification's wording
   ("default limit") allows. Adds a config key the repository otherwise avoids
   inventing; worth it only if a user is known to need a different limit.
3. **20 MiB fixed (the reviewed candidate).** Lower memory ceiling, but it is
   proven to refuse a default SDK batch that the base accepts today.
4. **No limit (retire the candidate).** Keeps every batch the listener accepts
   today, but leaves the memory exposure and the specification gap in place.

## Recommendation {#recommendation}

Option 1. It closes the memory exposure and the specification gap, and it
refuses only requests larger than the specification's recommended default,
from whichever producer sends them. If accepted, the
implementation keeps PR #2557's mechanism (count decoded bytes, stop the
decoder at the limit, discard the rest through the shared capped drain, answer
413) and changes only the constant, with the reviewer's SDK reproduction as an
acceptance test: the default 512-record batch must be stored. This RFC then
spawns a small decision LLP recording the chosen limit.

## Out of scope {#out-of-scope}

Limits on concurrent requests, slow-upload timeouts, and the refused-route
drains of issue #1367.
