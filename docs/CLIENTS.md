[← All documentation](README.md)

---

# Manage clients and import history

Use `hyp setup` to choose which AI clients to record. Setup configures those
clients and imports supported session history. You can also run
`hyp attach <client>` to configure a client and `hyp backfill <provider>` to
import history.

## Contents

- [Choose and check a client](#choose-and-check-a-client)
- [Attach and verify new activity](#attach-and-verify-new-activity)
- [Bring in existing history](#bring-in-existing-history)
- [Stop capture or keep it local](#stop-capture-or-keep-it-local)
- [Collect GitHub activity](#collect-github-activity)
- [Install client skills](#install-client-skills)
- [Direct Ollama API text capture](#direct-ollama-api-text-capture)

## Choose and check a client

```sh
hyp setup
hyp client status
hyp client status codex
```

On an existing installation, choose **Reconfigure** to add a client. Team-managed
choices are locked; local additions remain yours to configure.

| Client | Capture behavior |
| --- | --- |
| Claude Code (`claude`) | OTEL events and transient raw bodies, plus transcript recovery. Requires Claude Code 2.1.193 or newer; 2.1.214 adds full tool-decision detail. |
| Codex (`codex`) | Scheduled import of the shared local session rollouts, covering CLI and Desktop. Gateway capture is an explicit `capture_mode` opt-in. |
| OpenCode (`opencode`) | Managed global JavaScript plugin and bounded `opencode export` recovery for CLI and Desktop. |
| Claude Desktop (`claude-desktop`) | macOS-only transcript import every five minutes by default. Also enables the shared Claude integration. |
| OpenClaw (`openclaw`) | Gateway routing plus scheduled transcript recovery. |
| Cursor (`cursor`) | Native session recovery for the Cursor editor and CLI, including the file contents and command output its tools see. Token usage is not available. |
| Hermes Agent (`hermes`) | Reads Hermes's local state database read-only: a backfill plus ongoing polling. Makes no changes to Hermes. |
| Pi (`pi`) | A managed Pi extension plus bounded recovery of native sessions, including recent history. |

Available integrations depend on active plugins and the installed version.
Check `hyp plugin list` and `hyp backfill list` for your
installation. Raw proxy sources do not configure an AI client; use a client
integration for conversation capture.

## Attach and verify new activity

For a configured client, preview its changes and apply them:

```sh
hyp attach codex --dry-run
hyp attach codex
hyp client status codex
hyp status
```

Attach is safe to repeat and preserves unrelated client settings. Start a new
client process so it reads the updated configuration, complete a short turn,
then check `hyp query overview` or search for a distinctive phrase with
`hyp query grep`. Capture and cache visibility can take time to settle.

For missing recordings, see [troubleshooting](TROUBLESHOOTING.md#no-new-recordings).

## Bring in existing history

Discover provider IDs and preview the scan before importing:

```sh
hyp backfill list
hyp backfill codex --since 2026-09-01T00:00:00Z --dry-run
hyp backfill codex --since 2026-09-01T00:00:00Z
hyp cache status
```

Both `codex` and `--since` are optional. Omit the provider to import from all
enabled providers; use `--since` to choose a start date. Without it, the import
uses the configured history window.

`backfill --dry-run` scans and
projects without writing, so it previews the result but is not a cheap probe.
Inspect each provider's output because one provider can fail while others
succeed.

Import writes the local cache. If exports are configured, eligible imported
rows can subsequently leave through those sinks. Apply your
[privacy markings](PRIVACY.md) before importing sensitive history.

Some integrations run scheduled recovery automatically. A positive
`backfill.window_days` limits both join-time backfill and scheduled recovery;
widening it can make older history eligible on the next sweep. `hyp detach` stops a client's schedules. The adapters
differ in how `backfill.on_join` affects schedules, so consult the
[recovery reference](CLI_REFERENCE.md#scheduled-recovery-sweeps-and-backfillwindow_days)
before changing those settings.

## Stop capture or keep it local

```sh
hyp detach codex --dry-run
hyp detach codex
```

Detach stops recording this client: no new sessions from it reach the cache,
including the scheduled transcript imports, and the running daemon picks this
up without a restart. Detach also reverses the client's managed settings.
Recorded history is kept; [`hyp privacy purge`](PRIVACY.md) deletes it.
`hyp status` then shows the client as "Not recording". Run `hyp attach codex`
to record it again. If team policy requires the integration, detach refuses
and changes nothing.

To keep a client's recordings local, exclude a directory or session, or delete
recorded rows, use [privacy controls](PRIVACY.md). For missing recordings, see
[troubleshooting](TROUBLESHOOTING.md).

## Collect GitHub activity

The optional `@hypaware/github` integration records repository activity alongside
AI sessions. It captures structural metadata for issues, pull requests, commits,
files, reviews, and comments; their content remains on GitHub.

With the integration enabled, sign in and check access:

```sh
hyp github login
hyp github status
```

GitHub's `repo` authorization scope includes write access, although HypAware only
reads. Review the repositories selected in the plugin configuration. Use
`hyp github backfill owner/repo` to import existing activity or `hyp github sync`
to poll now. See the [GitHub reference](CLI_REFERENCE.md#collect-github-activity)
for authentication and import behavior.

## Install client skills

Setup and `hyp attach` automatically install HypAware's skills in supported
clients so your agent can look up recorded sessions. To reinstall the skills:

```sh
hyp client skills install
```

This installs skills for all eligible clients. For launching an agent on a
question, see [queries](QUERYING.md#explore-recordings-with-your-agent).

## Direct Ollama API text capture

This opt-in adapter records native text `POST /api/chat`, JSON (`stream: false`)
and NDJSON (`stream: true` or omitted), through a request URL you choose.
It captures ordered system/user/assistant text context and the new assistant
response. It does not attach a client, capture `ollama` CLI history, import
transcripts, or cover `/api/generate`, OpenAI-compatible endpoints, tools, images,
audio or thinking. Use an installed model producing supported text responses.
Unsupported shapes are forwarded but omitted from capture as a whole exchange.

Admission is strict: request keys are limited to `model`, `messages`, `stream`,
`format`, `options` and `keep_alive`. Message keys are only `role` and `content`,
with system/user/assistant roles and string content (including empty strings).
Response-record keys are limited to `model`, `created_at`, `message`, `done`,
`done_reason`, `total_duration`, `load_duration`, `prompt_eval_count`,
`prompt_eval_cached_count`, `prompt_eval_duration`, `eval_count` and `eval_duration`.
An extra key in any of these objects drops the whole exchange with
`unsupported_shape`, even when the response would otherwise be text. For example,
the request control `think: false` is not admitted. This does not restrict nested
keys inside the admitted `options` or `format` values.

Each request is a **context snapshot**, identified by its gateway exchange ID.
Earlier context submitted again appears again in the next snapshot. Equal text
at different positions and repeated real requests remain distinct. Empty text
positions also retain rows and links; their `content_text` is null under the
existing empty-value convention. Only the newly generated response has usage.
Submitted historical assistant text has no new usage or inferred historical
model/timestamp. Rows carry the responding model for this exchange; the request
model is a fallback only when the response reports no model.

### Create a disposable collector

Run from the candidate checkout root with its installed dependencies, using its
binary throughout. This recipe uses a separate home and no export sinks. It
does not change the existing Ollama service or your normal HypAware install.
Choose a free explicit loopback port, then keep these variables in this shell:

```sh
HYP_BIN="$PWD/bin/hypaware.js"
PILOT_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/hyp-ollama.XXXXXX")
export HYP_HOME="$PILOT_ROOT/hyp-home"
export HYP_CONFIG="$HYP_HOME/hypaware-config.json"
export HYP_DEV_TELEMETRY=1
export DEV_RUN_ID="ollama-pilot-$(date -u +%Y%m%dT%H%M%SZ)-$$"
DIRECT_URL=http://127.0.0.1:11434
CAPTURE_URL=http://127.0.0.1:18741
MODEL=gemma3:4b
mkdir -p "$HYP_HOME"
cat > "$HYP_CONFIG" <<'JSON'
{
  "version": 2,
  "auto_update": false,
  "plugins": [
    { "name": "@hypaware/ai-gateway", "config": { "listen": "127.0.0.1:18741" } },
    { "name": "@hypaware/ollama" }
  ]
}
JSON
node "$HYP_BIN" config validate --path "$HYP_CONFIG"
curl --fail --silent --show-error "$DIRECT_URL/api/tags"
```

Confirm the tags include `$MODEL`; otherwise select an installed model producing
supported text responses. Do not download a model for this check. The upstream defaults
to `127.0.0.1:11434`. If your local service uses a different address, use the
gateway's existing `upstreams` setting with name `ollama`, `base_url` set to that
address and `path_prefix: "/api/chat"`. Keep `DIRECT_URL` consistent.

Launch the foreground daemon in a shell job whose PID you retain. The processing
child inherits dev telemetry and the stable run ID. This does not install a service:

```sh
node "$HYP_BIN" daemon run --foreground > "$PILOT_ROOT/collector.log" 2>&1 &
PILOT_PID=$!
node "$HYP_BIN" status --json
```

Wait for status to show a healthy gateway on the configured endpoint and a
healthy processing child before sending a request. Inspect
`$PILOT_ROOT/collector.log` if startup fails. An occupied explicit port fails
loudly; select another free port in the config and `CAPTURE_URL`, validate again,
and relaunch. A successful curl response alone does not prove capture.

### Send and query a snapshot

```sh
cat > "$PILOT_ROOT/request.json" <<JSON
{"model":"$MODEL","messages":[{"role":"system","content":"Answer briefly."},{"role":"user","content":"Say hello in one sentence."}],"stream":false}
JSON
curl --fail --silent --show-error "$CAPTURE_URL/api/chat" \
  -H 'Content-Type: application/json' -H "x-hyp-dev-run-id: $DEV_RUN_ID" \
  --data-binary "@$PILOT_ROOT/request.json" > "$PILOT_ROOT/response.json"
cat "$PILOT_ROOT/response.json"
node "$HYP_BIN" query schema ai_gateway_messages
QUERY_DEADLINE=$(($(date +%s) + 30))
SNAPSHOT_READY=0
while [ "$(date +%s)" -lt "$QUERY_DEADLINE" ]; do
  node "$HYP_BIN" query sql "select request_id, message_index, role, content_text, model
    from ai_gateway_messages where provider = 'ollama'
    order by message_created_at desc, message_index limit 30" --refresh always --format json \
    > "$PILOT_ROOT/snapshot.json" || break
  if node -e 'const rows = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.exit(rows.some(row => Number(row.message_index) === 2 && row.role === "assistant") ? 0 : 1)' "$PILOT_ROOT/snapshot.json"; then
    SNAPSHOT_READY=1
    break
  fi
  sleep 1
done
cat "$PILOT_ROOT/snapshot.json"
test "$SNAPSHOT_READY" = 1
```

Capture and JSONL export are asynchronous. The bounded retry above waits for the
initial disposable request's new assistant row; `--refresh always` only settles
data already appended, and does not wait for pending processor work. If the
deadline expires or a query fails, preserve the output and inspect the run's
diagnostics below before declaring missing capture. For later requests, retry
their correlated query on the same 30-second deadline until all expected
positions, including the new response, arrive.

Take the generated response's `request_id` from the output. Set `EXCHANGE_ID`
to that opaque ID, then inspect exactly that snapshot:

```sh
EXCHANGE_ID='paste-the-request-id'
node "$HYP_BIN" query sql "select request_id, session_id, message_id,
  previous_message_id, message_index, part_index, role, content_text, provider,
  model, cwd, repo_root, attributes, raw_frame, status
  from ai_gateway_messages where request_id = '$EXCHANGE_ID'
  order by message_index, part_index" --refresh always --format json
```

`attributes.gateway.exchange_id` equals `request_id` and `session_id`.
Each row links to its immediate predecessor; the first has an empty link array.
Structured JSON fields may print as objects or serialized JSON, so inspect the
schema/output before writing JSON extraction SQL. The response's observed native
counts and `done_reason` are in `raw_frame`; canonical accounting uses
`attributes.usage`. Net `input_tokens` is prompt count minus observed cache count.
Missing cache count leaves net input unknown, even with a gross prompt count.
Observed zero remains zero. Invalid counts are omitted, valid independent counts
can remain, and no total is invented. `status.finish_reason` retains a token-limit
`length` reason rather than calling it a natural stop.

For streaming, send the same ordered context with `stream: true` (or omit
`stream`). Use `curl --no-buffer` and save the NDJSON. Capture requires one valid
`done: true` terminal as the last nonblank record, including its content.
Malformed, truncated, error or trailing records drop the whole exchange.
For a second turn, build `messages` with your previous user text, the actual
assistant text from the first response, and the new user question. Query the new
exchange separately; previous context has no usage on that exchange.

### Diagnose missing capture

Failed, interrupted and unsupported exchanges produce no prompt/partial-response
rows, even when forwarding succeeds. In this recipe, read the actual local
diagnostics across **all processor PID files**, including after restart:

```sh
rg 'plugin\.ollama\.(capture_dropped|invalid_usage)|aigw\.exchange_write_failed' \
  "$HYP_HOME/hypaware/dev-telemetry" -g 'logs-*.jsonl'
```

Adapter diagnostics carry an exchange ID and bounded reason, without prompts,
response text or credentials. Allow up to 30 seconds for processor/exporter
arrival, checking these files once per second for the expected run/exchange and
reason. A missing diagnostic at that deadline is unresolved evidence, not proof
that an exchange was dropped. For failed-exchange checks, first obtain its
expected diagnostic, then refresh and compare rows against a baseline whose
prior successful snapshots have all arrived.
These JSONL files differ from gateway and processing
`logs/daemon.log`. Transport drops use `gateway.capture_dropped` in the gateway
daemon log and capture-drop counts in status. Without dev telemetry or an existing
configured OTel exporter, adapter-specific reasons are not automatically visible
in daemon.log or default status. This is a diagnostic limitation of the adapter.

The split daemon abandons capture copies on budgets, timeouts or processor
outage while forwarding continues: 16 MiB per exchange, 32 active/finishing
captures, 32 MiB retained raw bytes in the receiver, 4 MiB/256 pending IPC frames,
64 KiB chunk frames and a 30-minute capture lifetime. Decoding and row allocations
add memory; these are raw-copy limits, not a total RSS ceiling. No history replay
recovers exchanges lost before append. Unknown cwd/repository stays null, so
directory-based exclusions cannot protect this directory-blind API lane.
Local inference can still be exported in installations with configured sinks;
this recipe stays local because it has no sinks.

### Restart and stop only this collector

Before saving IDs/counts, use the bounded correlated queries above to settle
every prior successful request. Restore your test client's direct URL **first**, then
stop only the process you launched, leaving the Ollama service running:

```sh
REQUEST_URL="$DIRECT_URL"
kill -TERM "$PILOT_PID"
wait "$PILOT_PID"
node "$HYP_BIN" query sql "select request_id, message_id from ai_gateway_messages
  where provider = 'ollama' order by request_id, message_index, part_index" --refresh always --format json
curl --fail --silent --show-error "$REQUEST_URL/api/chat" \
  -H 'Content-Type: application/json' --data-binary "@$PILOT_ROOT/request.json"
```

Saved rows remain queryable after stop. To test retention, relaunch the same
foreground command with the **same** `HYP_HOME`/config, retain its new PID, wait
for both processes to be healthy, and compare IDs/counts before sending another
request. Restart alone must add no rows. New real submissions are new snapshots.
Select the direct URL again before stopping the relaunched collector.
