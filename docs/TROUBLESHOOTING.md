# Troubleshoot a HypAware installation

[Documentation](README.md) / Troubleshooting

Start with the health snapshot. It reports configuration, capture, clients,
storage, and repair commands without starting sources:

```sh
hyp status
hyp version
```

For scripts, use `hyp status --json`. Follow the specific `repair:` line for
the failing component, then repeat the relevant status check.

## No new recordings

```sh
hyp client status
hyp daemon status
hyp cache status
```

1. Check that the intended source is configured. Add it through `hyp setup`
   if needed.
2. Check that the client is attached. Preview and apply its attach using
   `hyp client attach CLIENT --dry-run` and `hyp client attach CLIENT`.
3. Check the daemon is running. Use `hyp daemon start` for an installed service,
   or follow [headless setup](HEADLESS.md) when there is no service manager.
4. Start a new client process and complete a turn so it uses the managed settings.
5. Check `hyp privacy show /absolute/path/to/project` for an ignore marking.

For Claude Code, use [the capture-health checklist](CLI.md#check-capture-and-claude-telemetry):
the installed version, configured listener, live listener, and transcript
activity help distinguish a missing attach from failed telemetry delivery.
For transcript-only clients, allow time for the scheduled recovery sweep.

Detaching a gateway-routed client restores its own connection settings if a
stopped gateway is preventing normal use. See [client management](CLIENTS.md).

## History or search results are missing

An overview covers the dates printed in its heading. A search may be limited
by dates, hit count, searchable columns, privacy, or local retention.

- Confirm the correct `HYP_HOME` and local versus remote target.
- Read stderr for withheld-row, freshness, and truncation notices.
- Use `hyp client history providers` and a provider-specific import dry run to
  check whether older transcripts are available. Cache refresh is not a history import.
- Refresh the affected local dataset with
  `hyp cache refresh ai_gateway_messages` when freshness warnings call for it.
- Use `--output ./results.json` with `--format json` for complete query output;
  this does not lift your query's own `LIMIT`.

See [querying](QUERYING.md) for searches, session drill-downs, and bounded SQL.

## An export or team upload is missing

```sh
hyp status
hyp sync --dry-run
hyp remote list
```

Check that a sink exists, its destination is correct, and the rows are eligible
to leave. An attended first-sync review hold, local-only folder or client
marking, or export retry can explain why local data is not yet on the server.
After reviewing the destination plan, use `hyp sync` to attempt delivery and
inspect each sink's result. It can partially succeed and still return failure.

Remote sign-in with `--no-forward` grants query access without setting up
forwarding. `hyp leave` disconnects forwarding but keeps local recordings.
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
[update procedure](CLI.md#upgrade-within-a-compatible-major-version).

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

## Find diagnostic logs

With the default `HYP_HOME`, service output is under
`~/.hyp/hypaware/logs/daemon.out.log` and `daemon.err.log`; processing work has
its own `~/.hyp/hypaware/processing/logs/daemon.log`. Use the paths reported for
your installation if you configured another home.

For an OTLP `421 Misdirected Request`, see the
[listener addressing guide](../README.md#an-otlp-exporter-is-refused-with-421-misdirected-request).
For CPU or memory diagnosis, see [runtime diagnostics](../README.md#runtime-diagnostics).
Optional [product telemetry](PRODUCT_TELEMETRY.md) has separate controls and
defaults off; it is not the captured conversations or the local diagnostic log.

When reporting a problem, include the version, failing command, exit status,
relevant status repair lines, and a short log excerpt around the failure.
Review excerpts for credentials, paths, and captured content before sharing.
