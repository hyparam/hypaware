# Recording claude-code with Collectivus

This walkthrough shows how to record every prompt, response, and stream event
from [`claude-code`](https://github.com/anthropics/claude-code) by routing it
through Collectivus's LLM proxy mode. The proxy is a transparent pass-through:
your `x-api-key` is forwarded verbatim to Anthropic, and a copy of the request
plus every SSE event is written to JSONL on disk.

The whole pipeline is local — no third-party services, no server-side keys.

## 1. Start collectivus with a proxy config

The fastest path is the interactive walkthrough — run `collectivus` with no
arguments and choose Standalone at the first prompt. It writes the
config to `~/.hyp/collectivus.json` (proxy on 127.0.0.1:8787 forwarding to
Anthropic), recordings to `~/.hyp/collectivus/`, and (if you opt in) sets
up the LaunchAgent / systemd unit and points Claude Code at the proxy:

```bash
npx collectivus
```

The rest of this doc shows the manual config equivalent. Save this as
`collectivus.json`:

```json
{
  "version": 1,
  "proxy": {
    "listen": "127.0.0.1:8787",
    "upstreams": [
      {
        "name": "anthropic",
        "base_url": "https://api.anthropic.com",
        "match": { "path_prefix": "/v1/messages" }
      }
    ],
    "redact_headers": [
      "authorization",
      "x-api-key",
      "anthropic-api-key",
      "cookie",
      "set-cookie"
    ]
  },
  "sink": {
    "type": "file",
    "dir": "./collectivus-data"
  }
}
```

(There's a copy of this file in [`examples/claude-code.json`](../examples/claude-code.json).)

Launch collectivus:

```bash
npx collectivus --config collectivus.json
```

You should see:

```
Proxy listener bound on 127.0.0.1:8787, recording under ./collectivus-data/<gateway_id>/proxy/
```

## 2. Point claude-code at the proxy

In another terminal:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

`claude-code` reads `ANTHROPIC_BASE_URL` and rewrites every Messages API call
to that origin. The proxy matches on `/v1/messages`, forwards the request to
`https://api.anthropic.com`, and tees the streaming response back to you while
recording it.

When Claude Code is configured through `ctvs attach` or the interactive
installer, Collectivus also installs local hooks that post the Claude session
id, current working directory, and git branch to the local proxy. That lets
Gateway/Central server parquet uploads include `cwd` and `git_branch` without
reading local `.claude` transcripts.

Run any prompt — the streamed response in your terminal is the live, unmodified
upstream traffic. Collectivus is observational only.

## 3. Watch traffic land in JSONL

```bash
GATEWAY_ID=${USER}
UTC_DATE=$(date -u +%F)
tail -f "collectivus-data/$GATEWAY_ID/proxy/$UTC_DATE.jsonl"
```

Two row kinds interleave:

- `kind: "stream_event"` — one row per SSE event, with `t_ms` measured from
  exchange start. These appear live as the response streams.
- `kind: "exchange"` — written when the request finishes, with the full
  request body, redacted headers, response status, duration, and event count.

For example, a prompt that elicits one short message produces something like:

```jsonl
{"exchange_id":"…","kind":"stream_event","t_ms":42,"event":"message_start","data":"…"}
{"exchange_id":"…","kind":"stream_event","t_ms":78,"event":"content_block_start","data":"…"}
{"exchange_id":"…","kind":"stream_event","t_ms":112,"event":"content_block_delta","data":"{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"Hi\"}}"}
{"exchange_id":"…","kind":"stream_event","t_ms":140,"event":"content_block_delta","data":"{\"type\":\"content_block_delta\",\"delta\":{\"text\":\" there.\"}}"}
{"exchange_id":"…","kind":"stream_event","t_ms":165,"event":"content_block_stop","data":"…"}
{"exchange_id":"…","kind":"stream_event","t_ms":190,"event":"message_stop","data":"…"}
{"exchange_id":"…","kind":"exchange","ts_start":"…","ts_end":"…","duration_ms":214,"upstream":"anthropic","client":{…},"request":{…},"response":{"status":200,"headers":{…},"body":null},"stream_event_count":6,"error":null}
```

The `request.headers["x-api-key"]` field is redacted as `REDACTED:<last4>` —
your secret never lands in the file.

## 4. Slice the recording with jq

Average request duration, by model:

```bash
jq -r 'select(.kind=="exchange") | [(.request.body | fromjson).model, .duration_ms] | @tsv' \
  < "collectivus-data/$GATEWAY_ID/proxy/$UTC_DATE.jsonl" \
| awk -F'\t' '{ count[$1]++; sum[$1]+=$2 }
              END { for (m in count) printf "%s\t%d calls\tavg %dms\n", m, count[m], sum[m]/count[m] }'
```

All assistant text deltas from the most recent exchange:

```bash
jq -r 'select(.kind=="stream_event" and .event=="content_block_delta") | (.data | fromjson).delta.text // empty' \
  < "collectivus-data/$GATEWAY_ID/proxy/$UTC_DATE.jsonl"
```

Replay one exchange (events plus its terminating row):

```bash
EXCHANGE_ID=$(jq -r 'select(.kind=="exchange") | .exchange_id' < "collectivus-data/$GATEWAY_ID/proxy/$UTC_DATE.jsonl" | tail -1)
jq -c "select(.exchange_id==\"$EXCHANGE_ID\")" < "collectivus-data/$GATEWAY_ID/proxy/$UTC_DATE.jsonl"
```

## 5. Shut down

`Ctrl+C` (SIGINT) on the collectivus process. Collectivus flushes and fsyncs
the JSONL file before exiting, so the last exchange row is durable.

## What's recorded vs redacted

- **Bodies are never auto-redacted.** Both the full request body and any
  non-streaming response body land verbatim. Streaming responses are decomposed
  into per-event rows — the response `body` is `null` and the data lives in
  `stream_event` rows instead.
- **Headers in `proxy.redact_headers`** (default: `authorization`, `x-api-key`,
  `anthropic-api-key`, `cookie`, `set-cookie`) are replaced with
  `REDACTED:<last 4 chars>` so operators can correlate keys without leaking
  them. Add to this list to redact more — you cannot shrink the default set.
- **Auth is pass-through.** Your `x-api-key` is forwarded to Anthropic
  verbatim; collectivus never holds a credential of its own.

## Combining with the OTLP collector

Collectivus's original OTLP receiver still works in the same process. Add an
`otel` block to the same config to record both LLM traffic and OpenTelemetry
signals from one binary:

```json
{
  "version": 1,
  "otel": { "listen": "0.0.0.0:4318" },
  "proxy": { "listen": "127.0.0.1:8787", "upstreams": [ … ] },
  "sink": { "type": "file", "dir": "./collectivus-data" }
}
```

The OTLP receiver writes normalized rows to
`<dir>/<gateway_id>/{traces,metrics,logs}/…` and raw envelopes to
`<dir>/<gateway_id>/raw/{traces,metrics,logs}/…`; the proxy writes to
`<dir>/<gateway_id>/proxy/<date>.jsonl`.

## Multi-host: gateway pulling its config from a central server

The flow above runs collectivus standalone — a single host that owns its own
config and recordings. For fleets, you can split it: one host runs
`role: "server"` and vendors per-gateway configs over the central-server API;
each gateway runs `role: "gateway"` and pulls its config from the server.

Pick this when you want centralised config management across many hosts (one
operator updates `gw-prod-1.json` on the server; the gateway picks up the
change within `poll_interval_seconds` and hot-reloads only the changed
listener) or when you want every gateway's recordings to land in a single S3
archive without per-host AWS credentials.

In Gateway mode, local disk is only a durable delivery outbox. Proxy and OTLP
rows are fsynced under `central_server.outbox_dir` (default:
`<dirname(identity.json)>/outbox`) and shipped to Central server ingest; the
Central server's ingest directory is the canonical recording source.

The interactive walkthrough exposes the Central server setup:

```bash
npx collectivus
# How will you use collectivus?
#   1) Standalone
#   2) Central server
```

Option 2 prompts for the central-server listen address, the gateway-facing
public URL, server data directory (default
`~/.hyp/collectivus/server-data`), an HMAC secret for signing JWTs, and an
optional S3 upload block — then prints the start and operator commands you
need to run next:

```bash
collectivus config bootstrap-token issue gw-prod-1 --server-config server.json
# prints:
npx collectivus --config-endpoint='https://collectivus.internal:8788/v1/bootstrap-config?token=...'
collectivus config set gw-prod-1 --server-config server.json --file gw-prod-1.json
```

Advanced users can still write a `role: "gateway"` config by hand. The normal
enterprise path is the one-line `--config-endpoint` command printed by the
central server's token issuer.

If gateways need a shorter hosted-discovery command, run a rendezvous service:

```bash
ctvs rendezvous --listen 0.0.0.0:8789 --data-dir ~/.hyp/collectivus/rendezvous \
  --registration-token "$COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN"
```

Or run the same service from the GHCR image:

```bash
docker run --rm -p 8789:8789 \
  -e COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN="$COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN" \
  -v collectivus-rendezvous:/data \
  ghcr.io/hyparam/collectivus:latest \
  rendezvous --listen 0.0.0.0:8789 --data-dir /data/rendezvous
```

The GHCR image uses `ctvs` as its entrypoint. Use `--config <path>` for
Central server, gateway, or standalone configs, and use the `rendezvous`
subcommand for hosted discovery. If one host should run both Central server and
rendezvous, run two containers from the same image with separate ports and data
volumes.

Then issue a join code from the Central server host:

```bash
collectivus config bootstrap-token issue acme-gateway --server-config server.json \
  --rendezvous https://join.collectivus.example \
  --max-uses 25
# prints:
npx collectivus join <join-code> --rendezvous https://join.collectivus.example
```

Rendezvous stores only the join-code hash and Central server connect metadata;
the short key is not the bootstrap token. Central mints a fresh one-shot
bootstrap token after each successful join until `--max-uses` is exhausted or
the `--ttl-seconds` expiry passes. When run through `npx`, the gateway resolves
the join code, writes `~/.hyp/collectivus.json`, installs `collectivus`
globally, installs the background daemon against that config, and attaches
Claude Code when the vended config includes a proxy listener. V1 does not pin
the Central URL, so use this only when gateway egress is private or constrained.

See the [Config vending](../README.md#config-vending-multi-host-deployments)
section of the README for the full operator workflow and the on-disk schema.

## Archiving recordings to S3

The Central server path in the interactive walkthrough includes an optional
**"Upload daily snapshots to S3 as Parquet?"** step. Answer `y` and it collects
bucket / region / prefix / time / signals (no AWS keys — those are read from
the environment at daemon start) and writes an `upload` block into the saved
config. Once configured, collectivus drains each previous day's JSONL into
Hive-partitioned Parquet under
`<prefix>/<gateway_id>/<signal-or-dataset>/date=<YYYY-MM-DD>/data.parquet` once a day,
leaving the local JSONL untouched. See the
[S3 upload](../README.md#s3-upload) section of the README for the full
config schema and credential resolution rules.
