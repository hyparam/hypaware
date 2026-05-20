# Collectivus

![collectivus](collectivus.jpg)

[![npm](https://img.shields.io/npm/v/collectivus)](https://www.npmjs.com/package/collectivus)
[![minzipped](https://img.shields.io/bundlephobia/minzip/collectivus)](https://www.npmjs.com/package/collectivus)
[![workflow status](https://github.com/hyparam/collectivus/actions/workflows/ci.yml/badge.svg)](https://github.com/hyparam/collectivus/actions)
[![mit license](https://img.shields.io/badge/License-MIT-orange.svg)](https://opensource.org/licenses/MIT)
[![container](https://img.shields.io/badge/container-ghcr.io%2Fhyparam%2Fcollectivus-blue)](https://github.com/orgs/hyparam/packages/container/package/collectivus)

Collectivus records AI-agent and application telemetry into local files you
can query. Run it as a transparent LLM proxy for Claude Code, Codex,
Anthropic, and OpenAI-compatible APIs; accept OTLP traces, metrics, and logs;
subscribe to gascity supervisor transcripts; or register arbitrary JSONL as a
SQL table. The default path is Standalone: config, recordings, and query cache
stay on this machine.

- **LLM proxy capture**: full request/response and SSE event recordings for
  Claude Code, Codex, Anthropic, and OpenAI-compatible APIs.
- **Agent transcripts**: gascity supervisor capture writes one queryable row
  per content block with agent identity and token usage.
- **Application telemetry**: OTLP traces, metrics, and logs over HTTP,
  normalized to JSONL by signal and service.
- **Local query**: Iceberg-backed `ctvs query` commands and SQL over
  `logs`, `traces`, `metrics`, `proxy_messages`, `gascity_messages`, and
  registered JSONL collections.
- **Optional operations path**: export to local Parquet, archive daily
  snapshots to S3, or run Gateway/Central server deployments when many hosts
  need one control plane.

## Quick start: record Claude Code

The fastest path is the `npx` walkthrough:

```bash
npx collectivus
```

Choose Claude Code when asked what to collect, or press Enter to collect all
available sources. The walkthrough writes `~/.hyp/collectivus.json`, stores
recordings under `~/.hyp/collectivus/`, installs a background daemon, and
attaches Claude Code when selected.

To run the proxy in the foreground with an existing config:

```bash
npx collectivus --config ~/.hyp/collectivus.json
```

Then point Claude Code at it from another terminal:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

After a prompt, inspect the JSONL recording:

```bash
tail -f "$HOME/.hyp/collectivus/$USER/proxy/$(date -u +%F).jsonl"
```

Or write a config by hand:

```bash
# 1. Save examples/claude-code.json (proxy on 127.0.0.1:8787 → api.anthropic.com)
npx collectivus --config examples/claude-code.json

# 2. In another terminal:
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude

# 3. Run a prompt, then watch the recording:
tail -f "collectivus-data/$USER/proxy/$(date -u +%F).jsonl"
```

Full step-by-step: [`docs/walkthrough-claude-code.md`](docs/walkthrough-claude-code.md).

To capture agent-attributed transcripts from a gascity supervisor (separate
from the proxy capture above), attach a city to the same daemon:

```bash
npx collectivus gascity attach hyptown
npx collectivus query sql "select gascity_template, count(*) as parts from gascity_messages group by 1 order by parts desc"
```

See [Gascity source (`gascity_messages`)](#gascity-source-gascity_messages) below.

## Installation

Use `npx collectivus` for first-run setup and foreground CLI commands:

```bash
npx collectivus --help
```

The package also publishes the shorter `ctvs` binary. Install globally only
when you want to run `ctvs` directly:

```bash
npm install -g collectivus
ctvs install --config ~/.hyp/collectivus.json
```

Install as a project dependency when you want the programmatic API:

```bash
npm install collectivus
```

The GHCR image is available for containerized Standalone, Gateway, Central
server, and rendezvous deployments. See
[Advanced deployments](#advanced-deployments) when you need that path.

## Configuration

Pass a JSON config with `--config <path>` (a local path or url). The schema:

```json
{
  "version": 1,
  "otel":  { "listen": "0.0.0.0:4318" },
  "proxy": {
    "listen": "127.0.0.1:8787",
    "upstreams": [
      {
        "name": "anthropic",
        "base_url": "https://api.anthropic.com",
        "match": { "path_prefix": "/v1/messages" }
      }
    ],
    "redact_headers": ["authorization", "x-api-key", "anthropic-api-key", "cookie", "set-cookie"]
  },
  "sink": { "type": "file", "dir": "./collectivus-data" },
  "query": { "cache": { "enabled": true } }
}
```

| Block | Purpose |
|-------|---------|
| `version` | Schema version. Required. Currently `1`. |
| `otel`    | Enable the OTLP receiver. Omit to disable. |
| `proxy`   | Enable the LLM proxy. Omit to disable. Requires `sink` in Standalone mode. |
| `sink`    | Root directory for Standalone JSONL recordings. Proxy rows land under `<sink.dir>/<gateway_id>/proxy/`; OTLP rows land under `<sink.dir>/<gateway_id>/<signal>/`. Required when `otel` or `proxy` is set in Standalone mode. Accepted but unused in Gateway mode. |
| `central_server` | Gateway-mode Central server URL, identity settings, config poll interval, and optional `outbox_dir`. Gateway rows are first fsynced to this durable local outbox, then shipped to Central ingest. |
| `upload`  | Optional. Enables the daily S3 parquet drain. See [S3 upload](#s3-upload). |
| `query`   | Optional. Configures the local `ctvs query` query cache. `query.cache.enabled` defaults to `true`; `query.cache.dir` defaults to `<recording-root>/.collectivus-query/cache`. |

`--print-config` loads, validates, and pretty-prints the resolved config:

```bash
npx collectivus --config collectivus.json --print-config
```

### v1 schema

`version: 1` introduces array-shape `upstreams`, an optional `upload` block,
and makes `sink` mandatory whenever `otel` or `proxy` is set in Standalone
mode. v0 configs (missing the `version` field) hard-fail with a clear error —
the walkthrough writes v1 only.

## LLM proxy mode

The proxy is a transparent reverse proxy for Anthropic's Messages API and
OpenAI-compatible APIs. With `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`,
every Claude Code call routes through collectivus, gets forwarded to
`https://api.anthropic.com`, and is recorded to JSONL.

Two row kinds in `<sink.dir>/<gateway_id>/proxy/<UTC-date>.jsonl`:

**Per stream event** (one per SSE event for streamed responses):

```json
{
  "exchange_id": "01HX...",
  "kind": "stream_event",
  "t_ms": 137,
  "event": "content_block_delta",
  "data": "{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"...\"}}"
}
```

**Per exchange** (always emitted, after the response completes):

```json
{
  "exchange_id": "01HX...",
  "kind": "exchange",
  "ts_start": "...",
  "ts_end":   "...",
  "duration_ms": 14444,
  "upstream": "anthropic",
  "client":  { "ip": "127.0.0.1", "user_agent": "claude-code/..." },
  "request": {
    "method": "POST",
    "path":   "/v1/messages",
    "headers": { "x-api-key": "REDACTED:abcd", "...": "..." },
    "body":    "{...}"
  },
  "response": { "status": 200, "headers": {}, "body": null },
  "stream_event_count": 47,
  "error": null
}
```

For non-streaming responses, only the `kind: "exchange"` row is written, with
`response.body` populated.

### Header redaction

Request and response headers in `proxy.redact_headers` are rewritten as
`REDACTED:<last 4 chars>`. The default list (`authorization`, `x-api-key`,
`anthropic-api-key`, `cookie`, `set-cookie`) is always applied — you can
extend it but not shrink it.

Bodies are never auto-redacted: full visibility is the intended behavior.

### Auth

Pass-through. The client's `x-api-key` is forwarded to upstream verbatim;
collectivus does not hold a credential.

### Codex

Codex can route through the same proxy by configuring a Codex model provider.
Use an OpenAI upstream whose path prefix matches `/v1/responses`:

```json
{
  "version": 1,
  "proxy": {
    "listen": "127.0.0.1:8787",
    "upstreams": [
      {
        "name": "openai",
        "base_url": "https://api.openai.com",
        "match": { "path_prefix": "/v1" }
      }
    ]
  },
  "sink": { "type": "file", "dir": "./collectivus-data" }
}
```

Attach or detach Codex explicitly:

```bash
ctvs attach --config collectivus.json --client codex
ctvs detach --client codex
```

This writes a managed provider to `~/.codex/config.toml` using Codex's
documented `model_provider` / `model_providers.<id>` configuration format:

```toml
model_provider = "collectivus"

[model_providers.collectivus]
name = "Collectivus OpenAI Proxy"
base_url = "http://127.0.0.1:8787/v1"
requires_openai_auth = true
wire_api = "responses"
supports_websockets = false
```

`supports_websockets = false` keeps Codex on HTTP/SSE requests, which is the
proxy path collectivus records today. See OpenAI's Codex docs for the
underlying [configuration file](https://developers.openai.com/codex/config-basic#codex-configuration-file)
and [provider fields](https://developers.openai.com/codex/config-reference#model_providers).

## Local query

`ctvs query` reads local recordings only. It never contacts S3 and it does not
auto-refresh its query cache unless you ask for that explicitly.

```bash
ctvs query refresh /path/to/gw1/logs/2026-05-11.jsonl --config collectivus.json
ctvs query refresh --all logs --config collectivus.json
ctvs query logs --config collectivus.json --since 1h
ctvs query traces slow --config collectivus.json --limit 20
ctvs query metrics series latency.ms --config collectivus.json
ctvs query proxy get <conversation-id> --config collectivus.json --format json
ctvs query sql "select serviceName, count(*) as logs from logs group by serviceName"
ctvs collect random-log.jsonl --name random-log --config collectivus.json
ctvs collect --glob '.gc/runtime/**/*.jsonl' --name session-segments --config collectivus.json
ctvs query sql "select * from random_log" --config collectivus.json
```

Cache cursors are written under
`<recording-root>/.collectivus-query/cache/datasets/<dataset>/gateway_id=<id>/date=<YYYY-MM-DD>/cursor.json`.
Rows live in local Iceberg tables under the same partition directory. Refreshes
append from the last recorded JSONL cursor when possible; truncation, rewrite,
or schema drift starts a new source epoch.

Freshness is treated asymmetrically (since v1.7.0):

| Partition state | Behavior |
| --- | --- |
| `fresh` | Query proceeds silently. |
| `stale` (cache exists, source changed since refresh) | Query proceeds; a `warning: query cache last refreshed at …` line is written to stderr. Stdout is unchanged. |
| `missing` (no cache table/cursor) | Query exits with the exact file-targeted `ctvs query refresh …` command to run when the source file is known. |

Use `ctvs query refresh <file.jsonl>` to refresh selected source files, or
`ctvs query refresh --all [dataset]` when you explicitly want the broader
walk. Repeat `--date` to query or refresh several UTC date partitions at once.
Use `--refresh always` to force a refresh before the query runs. Use
`--strict-freshness` to restore the pre-1.7 behavior where stale partitions
are a hard error (useful in CI / scheduled jobs that must never read
outdated data).

> **Migration note (v1.7.0).** Stale partitions no longer exit non-zero
> by default — scripts that depended on that exit code must add
> `--strict-freshness`. Stdout formats (table, json, jsonl, markdown) are
> unchanged; the new warning is written only to stderr. `missing`
> partitions still error.

Logical datasets are `logs`, `traces`, `metrics`, `proxy_messages`, and `gascity_messages`. `ctvs collect <file.jsonl> --name <name>` registers an external JSONL file as a dynamic table; `ctvs collect --glob '<pattern>' --name <name>` backs one table with many source files. Names are normalized for SQL, so `--name random-log` becomes table `random_log`; quoted SQL can also reference the original collection name as `"random-log"`. Collection tables include `_ctvs_source_path`, `_ctvs_line_number`, `_ctvs_raw`, and inferred top-level JSON fields. Deleted glob sources remain queryable from their cache-only partitions until the collection is removed. `ctvs query schema <table>` prints the schema, and `ctvs query catalog` shows which datasets have source and cached rows.

```bash
ctvs query sql "select date, count(*) from proxy_messages group by date" \
  --date 2026-05-14 --date 2026-05-15 --refresh always
```

### Conversation log model

Recorded LLM proxy traffic is exposed as a single logical dataset, `proxy_messages`. Each row is one content part — a text block, reasoning block, tool call, tool result, image, file, or error — so a single assistant turn that contains text + a tool call + more text becomes three rows. The grain is per-part on purpose: callers can filter, count, and join parts without unpacking nested JSON, and downstream analytics (`SUM(usage)`, conversation walks, tool-call/result joins) become single-table SQL.

Rows are globally deduplicated by `message_id` — a 16-character hex prefix of `sha256(conversation_id : role : canonicalJson(content))`. Identical content in the same conversation always produces the same id, so the user-history blocks that Anthropic replays on every request are written once. The walker also tracks `previous_message_id` across exchanges so callers can reconstruct conversation order even after dedup.

`conversation_id` is resolved tiered — Claude Code's `metadata.user_id.session_id` when present, otherwise a stable 16-hex hash of the first user message's content, otherwise a hash of `exchange_id` (so even single-shot malformed exchanges get a deterministic id). `conversation_source` is `claude_code` when the recorded user-agent starts with `claude-cli/`, else `api`. When Claude Code is configured through `ctvs attach`, a local hook records `cwd` and `git_branch` into the proxy JSONL so those fields survive Gateway/Central server shipping; local query/export also scans Claude Code transcripts to enrich matching rows with JSONL metadata such as `provider_uuid`, `parent_uuid`, `request_id`, `entrypoint`, `client_version`, and `user_type`.

JSON columns (`attributes`, `status`, `tools`, `tool_args`, `compact_metadata`, `raw_frame`) carry sparse structured data; scalars are accessed with `JSON_VALUE(<col>, '$.path')`. `attributes` holds request settings, per-message `usage` (assistant only), `timing.latency_ms`, and `client.claude_version` when available; `status` holds `tool_status` on tool results, `finish_reason` on the last assistant part, and `error_code` / `error_message` on error parts.

For the full per-column derivation table see [skills/collectivus-query/references/query-cli.md](skills/collectivus-query/references/query-cli.md).

### Gascity source (`gascity_messages`)

`ctvs gascity` is a separate listener that subscribes to a gascity supervisor's
REST API, normalizes provider frames (Claude / Codex), and writes one row per
content block (text / thinking / tool_use / tool_result / attachment) directly
to Parquet at `~/.collectivus/sink/gascity_messages/date=<YYYY-MM-DD>/city=<name>/`.
There is no JSONL stage and no `.meta.json` sidecar: the sink IS the queryable
store, so `ctvs query gascity_messages` is always reading what the daemon has
flushed up to the moment of the call.

```bash
ctvs gascity attach hyptown
ctvs gascity list
ctvs query schema gascity_messages --format markdown
ctvs query sql "select gascity_template, count(*) from gascity_messages group by 1"
```

`gascity_messages` carries agent-identity columns the proxy can't see —
`gascity_template`, `gascity_rig`, `gascity_alias` — plus per-frame token usage
with cache breakdown (`input_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`). Use it when you need agent-attributed cost
analysis or tool-call inspection; use `proxy_messages` for HTTP-level retry
visibility and request timing. They UNION cleanly via `gateway_id` (a constant
`gascity-scribe` on every gascity row tags the source).

The bundled [`ctvs-gascity` skill](src/cli/init_presets/gascity_skill.md) — installed per-workspace by
`ctvs init gascity` — teaches Claude Code and Codex how to query all three
gascity-aware tables (`events`, `session_segments`, `gascity_messages`) and
their cross-source joins with `proxy_messages`.

### LLM skill

Install the bundled `collectivus-query` skill so Claude Code and Codex know how
to inspect local recordings with `ctvs query`:

```bash
ctvs skills install --client all
```

The skill assumes the default `~/.hyp/collectivus.json` config unless the agent
discovers a non-default service config from `ctvs status` or the service unit.

## OTLP receiver

The OTLP receiver accepts JSON and protobuf payloads on the standard endpoints:

- `POST /v1/traces`
- `POST /v1/metrics`
- `POST /v1/logs`

Output layout under `sink.dir`:

```
collectivus-data/
└── <gateway_id>/
    ├── raw/
    │   ├── traces/<UTC-date>.jsonl       # raw export envelope
    │   ├── metrics/<UTC-date>.jsonl
    │   └── logs/<UTC-date>.jsonl
    ├── traces/<UTC-date>.jsonl           # one row per span
    ├── metrics/<UTC-date>.jsonl          # one row per data point
    └── logs/<UTC-date>.jsonl             # one row per log record
```

Each normalized row includes the source `service.name`, while files are
partitioned by `gateway_id`, signal, and date.

### Verify the OTLP receiver

```bash
npx collectivus --config collectivus.json &
curl -X POST localhost:4318/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[]}'
```

## CLI

```text
ctvs --config <path>                         Run with config file
ctvs --config <path> --print-config          Validate + print resolved config
ctvs query <command> [...]                   Query local recordings
ctvs collect <file.jsonl>|--glob <pattern> --name <name>
                                             Add external JSONL as a query table
ctvs export --config <path> [...]            Convert recorded JSONL to local Parquet (one-shot)
ctvs --help                                  Show usage
```

`SIGINT` and `SIGTERM` trigger graceful shutdown: stop accepting new requests,
drain in-flight, fsync sinks, exit 0.

### Export to Parquet on demand

`ctvs export` walks the configured sink dir and converts what it finds
into local Parquet. Runs once and exits — independent of the daily upload
scheduler, and includes today's open files (which the upload pipeline
deliberately skips).

Two sinks are drained:

| Source | Destination |
| --- | --- |
| `<sink.dir>/<gateway_id>/proxy/<date>.jsonl` (proxy recorder) | `<out>/proxy/messages.parquet` |
| `<sink.dir>/<gateway_id>/<signal>/<date>.jsonl` (OTLP) | `<out>/<gateway_id>/<signal>/date=<YYYY-MM-DD>/data.parquet` |

Proxy export walks each gateway's days chronologically so the conversation
walker can dedupe `message_id`s across day boundaries, then concatenates the
result into a single `messages.parquet` file. The per-day `kind: "exchange"` /
`kind: "stream_event"` JSONL rows on disk are unchanged — only the Parquet
projection was reshaped.

```text
ctvs export --config <path> [--out <dir>] [--date YYYY-MM-DD]
                            [--gateway-id <id>] [--signal logs|traces|metrics]
```

`--date`, `--gateway-id`, and `--signal` only filter the OTLP path; proxy
JSONL is always drained when present.

## S3 upload

Standalone and Central server modes write JSONL to their configured local
recording root. When the `upload` block is configured, a daily scheduler drains
the previous day's JSONL into Parquet partitions in S3. Object keys are
Hive-partitioned:

```
<prefix>/<gateway_id>/<signal-or-dataset>/date=<YYYY-MM-DD>/data.parquet
```

OTLP signals use `logs`, `traces`, or `metrics` as the middle segment. Proxy
traffic is materialized as the `proxy_messages` dataset.

This is useful for long-term retention, columnar queries with
Athena / DuckDB / Snowflake, and offsite backup of recordings that would
otherwise live only on the daemon host. The local JSONL is the source of
truth; the S3 drain is additive and idempotent (a per-(gateway_id, signal,
date) ledger and a HEAD check on the destination key prevent duplicate
uploads).

Add an `upload` block to drain JSONL to S3 once a day:

```json
{
  "version": 1,
  "proxy": { "listen": "127.0.0.1:8787", "upstreams": [] },
  "sink":   { "type": "file", "dir": "./collectivus-data" },
  "upload": {
    "bucket": "my-collectivus-archive",
    "prefix": "collectivus",
    "region": "us-east-1",
    "time":   "00:10",
    "signals": ["logs", "traces", "metrics", "proxy"]
  }
}
```

| Field         | Required | Default     | Notes                                         |
|---------------|----------|-------------|-----------------------------------------------|
| `bucket`      | yes      | -           | Destination S3 bucket name.                   |
| `prefix`      | no       | `collectivus` | Key prefix under the bucket.               |
| `region`      | no       | `AWS_REGION` env, or `us-east-1` | AWS region. |
| `time`        | no       | `00:10`     | Daily run time, `HH:MM` UTC.                  |
| `signals`     | no       | all four    | Subset of `logs`, `traces`, `metrics`, `proxy`. |
| `catchupDays` | no       | `30`        | Look back this many days for unuploaded JSONL. |
| `endpoint`    | no       | -           | Custom S3-compatible endpoint (e.g. MinIO).   |

### Credentials

Credentials are never stored in the config. They are resolved at daemon start
from one of these sources:

- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for local/dev or explicit
  static credentials.
- ECS task-role credentials exposed through
  `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` or
  `AWS_CONTAINER_CREDENTIALS_FULL_URI`.
- `AWS_CONTAINER_AUTHORIZATION_TOKEN` or
  `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` when the container credential
  endpoint requires an auth token.
- `AWS_SESSION_TOKEN` (optional, for temporary credentials)
- `AWS_REGION` (optional; the `upload.region` config field overrides this)

When `upload` is set in the config but no supported AWS credential source is
available, the daemon fails fast at startup rather than at the first daily tick.

## Programmatic use

```javascript
import { Collector } from 'collectivus'

const collector = new Collector({ port: 4318, outputDir: './otel-data' })
await collector.start()
// ...
await collector.stop()
```

The proxy is config-driven only — programmatic embedding of the proxy is not
yet a supported public API.

## Install as a daemon (macOS, Linux)

Keep collectivus running across reboots by registering it with the system
process supervisor — a user LaunchAgent on macOS, a systemd user unit on
Linux — and (optionally) route [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)
through the proxy in the same step.

### Quickstart (macOS)

The recommended path is the top-level walkthrough:

```bash
npx collectivus
# What do you want to collect? Press Enter for all available sources,
# or choose Claude Code.
# ✓ Daemon installed (LaunchAgent: com.hyparam.collectivus)
# ✓ Claude Code attached (~/.claude/settings.json)
```

If you prefer direct `ctvs` commands:

```bash
npm install -g collectivus
ctvs install --config /path/to/collectivus.json --yes
# ✓ Daemon installed (LaunchAgent: com.hyparam.collectivus)
# ✓ Claude Code attached (~/.claude/settings.json)
# Logs: ~/.hyp/collectivus/collectivus.log
```

The LaunchAgent is set with `RunAtLoad=true` and `KeepAlive=true`, so the
daemon starts at login and launchd restarts it if it exits. Logs land in
`~/.hyp/collectivus/`:

- `collectivus.log` — stdout
- `collectivus.err.log` — stderr

### Quickstart (Linux, systemd)

The same walkthrough creates the systemd user unit:

```bash
npx collectivus
# What do you want to collect? Press Enter for all available sources,
# or choose Claude Code.
# ✓ Daemon installed (systemd unit: com.hyparam.collectivus.service)
# ✓ Claude Code attached (~/.claude/settings.json)
```

Or use direct `ctvs` commands:

```bash
npm install -g collectivus
ctvs install --config /path/to/collectivus.json
# ✓ Daemon installed (systemd unit: com.hyparam.collectivus.service)
# ✓ Claude Code attached (~/.claude/settings.json)
```

On Linux, `install` writes a systemd user unit to
`~/.config/systemd/user/com.hyparam.collectivus.service`, runs
`systemctl --user daemon-reload`, then `enable` and `restart`. The unit is
configured with `Restart=always`, `RestartSec=5`, and
`WantedBy=default.target` so systemd starts it at login and respawns it on
exit. Logs are written via `StandardOutput=append:` /
`StandardError=append:` to the directory you pass as `logDir` (the CLI
defaults to `~/.hyp/collectivus`).

> **Linger required for non-login boots.** User-level systemd services run
> only while the user has a session. To keep the daemon up across reboots
> when you are not logged in (e.g. a headless server), enable lingering
> once:
>
> ```bash
> sudo loginctl enable-linger "$USER"
> ```
>
> Without this, the unit stops when your last login session ends and only
> restarts when you log back in.

System-level systemd units (root-owned, in `/etc/systemd/system/`) and
non-systemd init systems (Alpine's OpenRC, Void's runit, etc.) are not
supported in this build.

### Subcommands

| Command | Purpose |
|---------|---------|
| `ctvs install --config <path> [--yes\|--no]` | Install LaunchAgent and (optionally) attach Claude Code |
| `ctvs uninstall` | Stop and remove the LaunchAgent; revert any attached clients (Claude Code, Codex) |
| `ctvs attach (--config <path> \| --port <n>) [--client claude\|codex\|all]` | Route Claude Code and/or Codex through the proxy without touching the daemon |
| `ctvs detach [--client claude\|codex\|all]` | Revert Claude Code and/or Codex without uninstalling the daemon |
| `ctvs status` | Print daemon (loaded / PID) and Claude Code (attached) state |
| `ctvs export --config <path> [...]` | Convert recorded JSONL to local Parquet without invoking the upload scheduler |
| `ctvs query <command> [...]` | Query local recordings through the explicit query cache |
| `ctvs collect <file.jsonl>\|--glob <pattern> --name <name>` | Register external JSONL as a dynamic query table |
| `ctvs skills install [--client claude\|codex\|all]` | Install the bundled Collectivus query LLM skill |

If stdin is not a TTY, `install` refuses to guess: pass `--yes` to attach
Claude Code unattended, or `--no` to skip the attach step.

### Status

```bash
ctvs status
# Daemon
#   Status: loaded (PID 12345)
#   Plist: /Users/you/Library/LaunchAgents/com.hyparam.collectivus.plist
#   Config: /path/to/collectivus.json
#   Logs:
#     stdout: /Users/you/Library/Logs/Collectivus/collectivus.log
#     stderr: /Users/you/Library/Logs/Collectivus/collectivus.err.log
#
# Claude Code
#   Status: attached
#   Attached at: 2026-05-07T16:30:00.000Z
#   Port: 8787
#   Marker version: 1.1.0
#   Settings: /Users/you/.claude/settings.json
```

> On Linux, `ctvs status` does not yet report systemd unit state.
> Use `systemctl --user status com.hyparam.collectivus.service` for the
> daemon view; `ctvs status` will still report Claude Code attach
> state correctly.

### Reverting

```bash
ctvs detach [--client claude|codex|all]          # un-route, leave daemon running
ctvs uninstall                                   # remove daemon and revert attached clients
```

All revert paths are idempotent and tolerate already-reverted state.

## Advanced deployments

Standalone is the default mode: one machine owns its config, local proxy,
recordings, and query cache. Use Gateway and Central server only when a fleet
needs central config vending, durable gateway outboxes, and one canonical
ingest store. The JSON schema still uses `role: "server"` for the Central
server role and `role: "gateway"` for managed hosts.

### Containers

The GHCR image uses `ctvs` as its entrypoint, so container commands mirror the
CLI:

```bash
docker pull ghcr.io/hyparam/collectivus:latest
docker run --rm ghcr.io/hyparam/collectivus:latest --help

# Standalone, Gateway, or Central server: selected by role in the config file.
docker run --rm ghcr.io/hyparam/collectivus:latest --config /config/collectivus.json

# Same, but with config JSON injected as an environment variable.
docker run --rm -e COLLECTIVUS_CONFIG_JSON ghcr.io/hyparam/collectivus:latest \
  --config-env COLLECTIVUS_CONFIG_JSON

# Hosted-discovery rendezvous service.
docker run --rm ghcr.io/hyparam/collectivus:latest rendezvous --help
```

### Config vending (multi-host deployments)

Central server vendors per-gateway configs over `GET /v1/config`, accepts
gateway ingest, and can print one-line setup commands for Gateway hosts.
Gateways poll `central_server.poll_interval_seconds` and hot-reload only the
listener whose section changed.

```bash
# Central server host.
npx collectivus --config /etc/collectivus-server.json

# Operator workflow on the Central server host.
ctvs config bootstrap-token issue gw-prod-1 --server-config /etc/collectivus-server.json
ctvs config set gw-prod-1 --server-config /etc/collectivus-server.json --file gw-prod-1.json
ctvs config list --server-config /etc/collectivus-server.json

# Gateway host, using the command printed by the token issuer.
npx collectivus --config-endpoint='https://collectivus.internal:8788/v1/bootstrap-config?token=bt_abc123...'
```

Gateway mode treats Central server as the canonical recording store. Proxy and
OTLP rows are first fsynced to `central_server.outbox_dir`, then shipped to
`POST /v1/ingest/<signal>`.

### Self-hosting and rendezvous

The repo ships a reference [`docker-compose.yml`](docker-compose.yml) and
[`.env.example`](.env.example) that run Central server plus hosted-discovery
rendezvous for the `ctvs invite create` to `ctvs join` flow:

```bash
cp .env.example .env
# Fill in COLLECTIVUS_ADMIN_TOKEN, COLLECTIVUS_IDENTITY_SECRET,
# COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN, COLLECTIVUS_RENDEZVOUS_URL,
# and COLLECTIVUS_PUBLIC_URL.
docker compose up -d
```

Rendezvous stores only join-code hashes and Central server connect metadata;
it does not store plaintext join codes, configs, telemetry, JWTs, issuer
secrets, or bootstrap tokens. The full Docker walkthrough covers TLS,
secret rotation, backups, and troubleshooting in
[`docs/self-hosting-docker.md`](docs/self-hosting-docker.md). The Claude Code
walkthrough has the shorter Gateway/Central path in
[`docs/walkthrough-claude-code.md`](docs/walkthrough-claude-code.md#multi-host-gateway-pulling-its-config-from-a-central-server).

### AWS ECS

An optional CDK app under [`infra/aws/`](infra/aws/) deploys Central server and
rendezvous as ECS Fargate tasks behind ALBs, with encrypted EFS state and a
private S3 archive bucket. Use it only when AWS is already the deployment
target; the Docker Compose path is the simpler self-hosting default.
