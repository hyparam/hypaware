# OpenTelemetry

**Status:** Supported. **Setup id:** `otel`. **Backfill:** No.

HypAware runs an OTLP receiver on `127.0.0.1:4318` that accepts logs, traces,
and metrics over HTTP with JSON encoding. Point any OpenTelemetry exporter at
it to keep that telemetry next to your agent sessions and query it with
`hyp query`.

Rows are stored as they arrive, in the `logs`, `traces`, and `metrics`
datasets. They are not turned into sessions, so they do not appear in
conversation search or in findings. Claude Code's own telemetry is handled by
the [Claude Code integration](claude-code.md), which does turn it into
sessions.

## Set it up

Choose **OpenTelemetry** under **Customize** in `hyp setup`, or add it to an
unattended setup:

```sh
hyp setup --source otel
```

Then configure your exporter for OTLP over HTTP with JSON. Most SDKs default to
protobuf; set the protocol explicitly:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

## Limits

- JSON encoding only. Protobuf and gRPC requests are refused.
- The receiver listens on loopback only, so exporters must run on the same host.
- Attributes are stored as JSON and not interpreted: there is no session, token,
  or cost view for this data.
