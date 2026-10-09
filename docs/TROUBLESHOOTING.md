[← All documentation](README.md)

---

# Troubleshoot a HypAware installation

Check the installation's status and version:

```sh
hyp status
hyp version
```

`hyp status` reports the background service, clients, storage, and problems,
with guidance to help resolve them. Use `hyp status --verbose` for more detail
or `hyp status --json` for scripts.

## Contents

- [No new recordings](#no-new-recordings)
- [Ollama capture is unconfirmed](#ollama-capture-is-unconfirmed)
- [History or search results are missing](#history-or-search-results-are-missing)
- [An export or team sync is missing](#an-export-or-team-sync-is-missing)
- [A command is missing or rejects an option](#a-command-is-missing-or-rejects-an-option)
- [The CLI and daemon run different versions](#the-cli-and-daemon-run-different-versions)
- [Disk usage or maintenance problems](#disk-usage-or-maintenance-problems)
- [A query or graph projection refuses for memory](#a-query-or-graph-projection-refuses-for-memory)
- [Find diagnostic logs](#find-diagnostic-logs)

## No new recordings

```sh
hyp client status
hyp daemon status
hyp cache status
```

1. Check that the intended source is configured. Add it through `hyp setup`
   if needed.
2. Check that the client is attached. Preview and apply its attach using
   `hyp attach CLIENT --dry-run` and `hyp attach CLIENT`.
3. Check the daemon is running. Use `hyp daemon start` for an installed service,
   or follow [headless setup](TEAM_SETUP.md#ci-and-headless-deployment) when there is no service manager.
4. Start a new client process and complete a turn so it uses the managed settings.
   Ollama attach enables recording and prints recipes without editing client files
   or shell/service `OLLAMA_HOST`; use its
   [explicit CLI host or SDK constructor](CLIENTS.md#route-a-cli-or-sdk-client).
5. Check `hyp privacy show /absolute/path/to/project` for an ignore marking.

For Claude Code, `hyp client status claude` reports the configured and live
listener endpoints, recent telemetry, and transcript activity. If the endpoints
differ, run `hyp attach claude`, restart the daemon, and start a new Claude Code
process. Check the [client table](CLIENTS.md#choose-and-check-a-client) for minimum
version requirements.
For transcript-only clients, allow time for the scheduled recovery sweep.

Detaching a gateway-routed client restores its own connection settings if a
stopped gateway is preventing normal use where that integration manages them.
Ollama detach leaves the capture host unchanged. With its collector stopped,
launch the CLI at the preserved direct root or construct a new SDK object with
that root using [direct recovery](CLIENTS.md#stop-and-resume-ollama-recording).

## Ollama capture is unconfirmed

<!-- @ref LLP 0474#diagnostics [implements]: default status and local diagnostics distinguish readiness, observed traffic, persistence evidence and actionable finite failures -->
<!-- @ref LLP 0476#lifecycle [constrained-by]: completed inference with timed-out confirmation leaves settings unchanged and may finish in a live collector -->

```sh
hyp ollama setup
hyp client status ollama
hyp status --verbose
```

Check the **Direct upstream**, service/model inventory and **Capture root (live)**
separately. An executable on PATH does not prove a service or model is ready.
Use a model already listed and the supported CLI/SDK recipes in
[clients](CLIENTS.md#route-a-cli-or-sdk-client). A configured or stale capture root
is not a live route. After saved endpoint changes with an unconfirmed restart,
run `hyp daemon restart` and check setup again.

| Result or reason | Next step |
| --- | --- |
| Ready, no traffic | Route the next client to the printed live `/ollama` root, or explicitly run `hyp ollama verify --model NAME`. |
| Observed, awaiting persistence | Give the processor time to finish; use verify for a fresh committed-pair check. |
| Persisted stamp | The append resolved. Verify or query the particular request to establish current visibility. |
| Off or historical evidence | Successful detach keeps the running host forwarding without capture. Use `hyp client attach ollama` to resume new requests. |
| `unsupported_shape` | Use native chat/generate with `think=False`, no nonempty thinking/tools, and supported fields. Unsupported exchanges are omitted in full. |
| `malformed_stream`, `missing_terminal`, `trailing_record` | The stream must finish with exactly one completed terminal and no later nonblank records. Retry the request explicitly after fixing its producer. |
| `http_error`, `upstream_unavailable`, `transport_error` | Check the direct Ollama service and saved custom upstream with setup. Direct inference and capture are separate outcomes. |
| `capture_limit`, `processor_unavailable`, `append_failure` | Check the ordinary daemon log and processing health. Lost capture is not replayed. |
| `policy_unreadable` | Restore readable, valid policy/configuration. Verification does not bypass policy. |
| Unconfirmed attach/detach | Follow the command's recovery guidance and retry for live confirmation. A saved setting alone is not a completed barrier. |

`hyp ollama verify --model NAME --json` returns machine-readable status, reason and
whether HTTP completed; its prompt/export disclosure goes to stderr. A
`persistence_timeout` means inference completed but storage confirmation timed
out. The live collector may finish; settings are unchanged. A later check can
report `settlement_busy` until the original storage operation actually settles.
The command never retries inference automatically. If the actual collector stops
or its processor is lost, confirmation can be interrupted and remains unconfirmed.

<!-- @ref LLP 0476#cohort [implements]: the shared full refresh keeps ordinary earlier/other-client backlog and storage/sink hooks -->

Verification refreshes the shared current gateway spool, including earlier and
other-client pending rows, with normal storage/sink hooks. Its cost depends on
that backlog. The disposable query worker only reads committed data with normal
caller policy and disables legacy query-config migration. A receipt, spool row,
HTTP result, old saved stamp or hidden row cannot establish verification success.

Default status carries bounded capture evidence and finite recent failure reasons.
These summaries can lag until the next processor status update. Check the ordinary
daemon log for a safe failure reason while waiting; it also carries projection,
append and lifecycle events.
No prompt or response text is needed to diagnose these reasons. Optional dev
telemetry can supply structured run/exchange correlation, but is not required for
the ordinary status/log path. See [diagnostic logs](#find-diagnostic-logs).

When the collector has stopped, use the preserved direct-host CLI command or a
new `Client(host=...)` from [direct recovery](CLIENTS.md#stop-and-resume-ollama-recording).
This restores inference without recording. Off/stopped historical timestamps do
not claim current health. Ollama has no history import or outage replay, and its
unknown directory means directory exclusions cannot protect these API requests.

## History or search results are missing

An overview covers the dates printed in its heading. A search may be limited
by dates, hit count, searchable columns, privacy, or local retention.

- Confirm the correct `HYP_HOME` and local versus remote target.
- Read stderr for withheld-row, freshness, and truncation notices.
- Use `hyp backfill list` and a provider-specific backfill dry run to
  check whether older transcripts are available. Cache refresh is not a backfill.
- Refresh the affected local dataset with
  `hyp cache refresh ai_gateway_messages` when freshness warnings call for it.
- Use `--output ./results.json` with `--format json` for complete query output;
  this does not lift your query's own `LIMIT`.

See [querying](QUERYING.md) for searches, session drill-downs, and bounded SQL.

## An export or team sync is missing

```sh
hyp status
hyp sync --dry-run
hyp remote list
```

Check that a sink exists, its destination is correct, and the rows are eligible
to leave. An attended first-sync review hold, local-only folder or client
marking, or export retry can explain why local data is not yet in HypAware
Cloud. After reviewing the destination plan, use `hyp sync` to attempt
delivery and inspect each sink's result. It can partially succeed and still
return failure.

<!-- @ref LLP 0471#chunk-lifetime: the elapsed deadline belongs to each logical Cloud chunk, not a whole sync -->
Cloud sync gives each upload chunk a 330-second limit, including authentication,
the request, response reading and retry waits. Retries share that limit;
a healthy sync with several chunks can take longer overall. Timeout or stop
cancels the current Cloud request and waits. Unacknowledged rows remain eligible
for a later export while they remain in the local cache. Check connectivity
and the destination's failure reason, then retry with `hyp sync` after fixing it.

<!-- @ref LLP 0471#daemon-work: only a strictly later full completion for this destination establishes recovery -->
An export warning clears only when that same configured destination records a
full successful completion strictly after its failure was recorded. Starting
an upload, acknowledging some rows, queuing a follow-up or succeeding at another
destination does not clear it. The warning can remain after 24 hours; equal
timestamps do not establish recovery. Ordinary daemon logs record failure and
later recovery separately. See [diagnostic logs](#find-diagnostic-logs).

<!-- @ref LLP 0472#t4: retained diagnostic history and unresolved warnings describe different facts -->
The verbose status `recent errors` count describes retained history from the
last 24 hours, including recovered failures. It is not a count of unsent rows
or every failure the installation has ever had. A warning can clear while this
count stays nonzero. Deleting failure records or letting them age does not
deliver data; retries use the cache and saved export progress. See
[storage paths](CONFIGURATION.md#know-where-data-lives) for the diagnostic cap
and cleanup limits.

Remote sign-in with `--no-forward` grants query access without setting up
sync. `hyp leave` stops sync but keeps local recordings.
See [team setup](TEAM_SETUP.md) and [privacy controls](PRIVACY.md).

## A command is missing or rejects an option

```sh
hyp version
hyp --help
hyp plugin list
hyp query --help
```

Plugin-owned commands appear only while the owning plugin is active. Entering
a known inactive command prints a repair instruction. If a flag in these docs
is unavailable, check the installed version's command help and the
[update procedure](CLI.md#update-hypaware).

## The CLI and daemon run different versions

```sh
hyp update
hyp status
```

`hyp update` checks for a newer release and restarts an installed daemon after
updating. If installation succeeded but restart failed, run
`hyp daemon restart`. A foreground daemon needs to be relaunched by its owner
or supervisor. Source checkouts and npx-cache copies do not self-update.

For a missing global binary or broken service definition, follow
[recovery](CLI.md#reinstall-or-recover-the-current-version).

## Disk usage or maintenance problems

```sh
hyp cache status
hyp cache maintain ai_gateway_messages --dry-run
```

Check [retention and storage paths](CONFIGURATION.md) to distinguish the query
cache, exported files, retry state, and logs. Cache retention does not reclaim
exported copies. Inspect a maintenance dry run before applying it, and use
`hyp privacy purge` only when you intend to delete recorded data.

## A query or graph projection refuses for memory

Execution memory is bounded, and work that outgrows its budget refuses instead
of returning a partial answer. The refusal names the budget it hit and, where
one applies, the variable that raises it. Each is read from the environment of
the process doing the work, in MB:

- `HYP_QUERY_MAX_HEAP_MB` (default 1024) bounds a query you run. Work that
  carries its own budget, such as a graph read or projection, ignores it.
- `HYP_GRAPH_PROJECTION_MAX_HEAP_MB` (default 3072) bounds a graph projection,
  which scans whole source tables.

Narrow the work first: add a `WHERE` or date filter, a `LIMIT`, or aggregate
instead of selecting raw rows. Raise a budget only when the work genuinely
needs the memory. A value that is blank or not a number is ignored and the
default applies.

For a command you run yourself, set it in the same shell:

```sh
HYP_GRAPH_PROJECTION_MAX_HEAP_MB=6144 hyp graph project
```

The installed daemon does not read your shell. It runs scheduled work, such as
the projection after a GitHub poll, in a child of the service process, and that
child inherits the service environment. `hyp daemon install` writes no
environment block of its own, so set the variable where your service manager
builds that environment, then restart the daemon so it starts with the new
value.

On macOS (launchd):

```sh
launchctl setenv HYP_GRAPH_PROJECTION_MAX_HEAP_MB 6144
hyp daemon restart
```

On Linux (systemd user service):

```sh
systemctl --user set-environment HYP_GRAPH_PROJECTION_MAX_HEAP_MB=6144
hyp daemon restart
```

Either setting applies only to processes started afterwards, which is what the
restart is for, and both are forgotten at logout or reboot. To keep a value,
set it where the login session environment is built: an
`~/.config/environment.d/hypaware.conf` entry under systemd, or a login-time
`launchctl setenv` under launchd. Remove one with
`launchctl unsetenv HYP_GRAPH_PROJECTION_MAX_HEAP_MB` or
`systemctl --user unset-environment HYP_GRAPH_PROJECTION_MAX_HEAP_MB`, then
restart the daemon again. A foreground `hyp daemon run` takes the environment of
the shell that started it, so it needs neither step.

## Find diagnostic logs

With the default `HYP_HOME`, start with the structured log at
`~/.hyp/hypaware/logs/daemon.log`. Service stdout and stderr are in
`daemon.out.log` and `daemon.err.log` in the same directory. Processing work has
its own `~/.hyp/hypaware/processing/logs/daemon.log`. Use the paths reported for
your installation if you configured another home.

An OTLP exporter refused with `421 Misdirected Request` is pointed at a name
other than `localhost` or `127.0.0.1`; point it at one of those instead.
[Product telemetry](PRIVACY.md#product-telemetry) has separate controls; it is
automatic for enrolled organizations, defaults off on standalone installations,
and is not the captured conversations or the local diagnostic log.

When reporting a problem, include the version, failing command, exit status,
relevant status repair lines, and a short log excerpt around the failure.
Review excerpts for credentials, paths, and captured content before sharing.
