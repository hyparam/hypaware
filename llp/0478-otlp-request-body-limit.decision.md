# LLP 0478: The OTLP listener limits a request body to 64 MiB decoded

**Type:** decision
**Status:** Accepted
**Systems:** Sources, Plugins
**Author:** HypForge steward / Claude
**Date:** 2026-10-09
**Related:** LLP 0477, LLP 0257, LLP 0012

@ref LLP 0477#options [implements]: option 1, the specification's recommended limit, fixed

## Decision {#limit}

The shared OTLP/JSON listener refuses a request whose body decodes to more
than 64 MiB (`MAX_DECODED_BODY_BYTES` in `src/core/otlp/server.js`). Bytes are
counted after gzip or deflate, the decoder is stopped as soon as the limit is
crossed, the rest of the upload is discarded through the shared capped drain,
and the sender gets HTTP 413. The limit is a fixed constant, not a config key.

## Why {#why}

- The OTLP/HTTP specification requires a server to limit the request body
  "including after decompression", recommends 64 MiB as the default, and
  requires 413 when it is exceeded. It recommends the same 64 MiB default for
  what a client sends before compression, so a client on that default never
  sends a body this limit refuses.
- 20 MiB, sized from single Claude items, was shown to refuse a default
  OpenTelemetry SDK batch (512 records of 48 KiB, about 24 MiB) that the
  listener accepted before. Limits for a generic OTLP source have to come from
  the protocol, not from local samples (LLP 0477#why-decision).
- A config key was not added: nothing known needs a different limit, and the
  repository adds keys only when a task calls for one.

## Who decided {#authority}

The steward, under LLP 0019, after the mayor returned the choice: Phil had
said (2026-10-09T01:44Z) that careful, easy-to-undo choices like this do not
need him. Phil was told and can overrule. Undoing it is a one-constant change.

## Consequences {#consequences}

Peak memory for one accepted request is bounded: about twice the limit in
buffers while the chunks are joined, plus the decoded string and parsed object.
A body over 64 MiB is refused and, since 413 is not retried, its records are
lost. A client on the specification's default does not send one, but the
specification allows a client to be configured with a larger limit, and such a
client loses any batch over 64 MiB. That is accepted as the compatibility
boundary: the listener is a local loopback receiver, no known producer needs
more, and a config key can be added if one does. Limits on
concurrent requests and slow uploads are not part of this decision.
