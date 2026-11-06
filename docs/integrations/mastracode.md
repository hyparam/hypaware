# Mastra Code

**Status:** Supported. **Setup id:** `mastracode`. **Backfill:** Yes.

HypAware reads [Mastra Code](https://github.com/mastra-ai/mastra)'s local
database, `mastra.db`, read-only. Mastra Code is the `mastracode` npm package
from mastra-ai; this integration is tested with version 0.49.0. HypAware
polls the database every 60 seconds for new messages, and a scheduled import
every 15 minutes brings in existing threads. It does not route Mastra Code's
model traffic or change Mastra Code's settings or threads, and it writes
nothing in your projects. Reading the database can leave SQLite's own
working files beside it (see [Limits](#limits)). Capture needs Node.js 22.13
or newer.

Mastra Code keeps every thread in one database:

| Platform | Default location |
| --- | --- |
| Linux | `~/.local/share/mastracode/mastra.db` |
| macOS | `~/Library/Application Support/mastracode/mastra.db` |
| Windows | `%APPDATA%\mastracode\mastra.db` |

## What is recorded

Threads and messages, including your prompts, Mastra Code's responses, tool
calls and their output, the model of each step, and each thread's project
directory. A thread's title is generated from your conversation, so it is
treated as message content. Reasoning parts and other part types HypAware
does not recognize are skipped.

Mastra Code does not store token counts per turn. It keeps one running
counter on each thread and adds to it after every step, including when you
continue a thread. HypAware carries that counter on the last part of the
thread's latest response, as the `mastracode.process_token_usage` attribute,
and no row carries per-turn token usage. The counter is not a per-turn value,
and it is not guaranteed to be a thread total: Mastra Code skips an update it
fails to save.

HypAware reads only the `mastra_threads` and `mastra_messages` tables. It
never reads Mastra Code's `settings.json`, `auth.json`, `mastra-vectors.db`,
its observability store, `~/.mastracode`, a project's `.mastracode`
directory, or any other table in `mastra.db`. The workspace details Mastra
Code stores with each response, which hold absolute paths, are dropped
before a row is built.

## Set it up

`hyp setup` offers Mastra Code. On Linux it is pre-checked when the database
exists at the default location. On macOS and Windows it is offered but not
pre-checked, because setup looks only at the Linux location; pick it and
HypAware reads the default location for that platform. On a new installation
you can pick it without the prompts:

```sh
hyp setup --source mastracode
hyp status
```

To add Mastra Code to an existing installation, run `hyp setup` in a
terminal, choose **Reconfigure**, and select Mastra Code; your current
choices stay selected. `hyp setup --source mastracode` refuses to change an
existing configuration, and `--force` replaces it rather than adding to it.

This integration installs no skills into Mastra Code.

### Use a different database location

HypAware uses the first of these that is set: the `db_path` setting,
`MASTRA_DB_PATH`, `MASTRA_APP_DATA_DIR` (as `<dir>/mastra.db`),
`XDG_DATA_HOME` (as `<dir>/mastracode/mastra.db`, on Linux only, as Mastra
Code itself uses it), then the default for your platform. Each variable
counts only when it is an absolute path. The daemon does not see those variables when they are set
only in your shell, because it runs under launchd or systemd with its own
environment. A `hyp backfill mastracode` run from that shell does see them,
so the two can read different databases. If you moved the database, add this
entry to the existing `plugins` list in your HypAware configuration,
preserving the other entries:

```json
{
  "name": "@hypaware/mastracode",
  "config": {
    "db_path": "/absolute/path/to/mastra.db"
  }
}
```

See [configuration](../CONFIGURATION.md#locate-and-validate-configuration)
for the config location, then apply and check the change:

```sh
hyp config validate
hyp daemon restart
hyp status
```

The same `config` object takes `poll_interval`, such as `"60s"`, and
`"enabled": false` turns ongoing capture off.

## Import existing history

Setup does not import your existing threads itself. The scheduled import
picks them up within 15 minutes, or run it now:

```sh
hyp backfill mastracode --dry-run
hyp backfill mastracode
```

New messages arrive on the next poll, up to a minute after Mastra Code
writes them. A scheduled import also runs every 15 minutes. It picks up
changes Mastra Code makes to a message it already wrote, so a late edit can
take up to 15 minutes to appear. Set `backfill.window_days` to limit both
imports to recent threads. With `backfill.on_join` set to `false`, neither
runs.

Mastra Code keeps chat history for 90 days, so an import finds at most that
much. HypAware keeps a thread Mastra Code deletes, but drops messages Mastra
Code prunes from a thread still in use. Mastra Code prunes both: whole
threads, and single messages from a thread that still exists.

## Privacy

Directory markings and `.hypignore` apply to each thread's project
directory. To stop recording one thread, pass its HypAware session id, which
is `mastracode-` followed by the Mastra Code thread id. List the ids HypAware
has recorded with:

```sh
hyp query sql "select distinct session_id from ai_gateway_messages where client_name = 'mastracode'"
hyp session ignore mastracode-<thread-id>
```

HypAware reads saved exclusions on the next Mastra Code poll, so an ignore
takes effect within a minute.

The command saves the exclusion through the HypAware gateway, so it works only
while HypAware also records another client through its gateway. On an install
that records only Mastra Code, it prints one `hyp session` error line, exits
`3`, and saves nothing.
Ignore the project directory instead, which also stops recording every other
Mastra Code thread there:

```sh
hyp privacy ignore /path/to/project
```

See [marking directories](../PRIVACY.md#marking-directories).

**Mastra Code makes its own network calls.** HypAware does not change them.
Mastra Code 0.49.0 sends PostHog product analytics by default, and
`MASTRA_TELEMETRY_DISABLED=1` turns them off.

**Deny mode still runs tools.** In Mastra Code 0.49.0,
`--permission-mode deny` did not stop a shell tool from running. HypAware
records what ran; it does not enforce Mastra Code's permissions.

## Limits

- Remote Turso and Postgres stores are not supported. When `MASTRA_DB_URL`
  is set in the daemon's environment, HypAware reads no local file and
  `hyp status` says so.
- Reading the database can leave an empty `mastra.db-wal` and a
  `mastra.db-shm` beside `mastra.db` until Mastra Code next closes it
  cleanly. These are SQLite's own working files and hold no content.
- Windows is offered in setup, but no run has validated capture there.
- If Mastra Code changes its database schema, `hyp status` reports the
  missing table or column and HypAware records nothing until a release
  supports the new schema. It never writes partial rows.
- Capture needs Node 22.13 or later, with a built-in SQLite of 3.45 or newer
  to read Mastra Code's thread metadata.

For status messages and fixes, see
[troubleshooting](../TROUBLESHOOTING.md#mastra-code-records-nothing).

Design: [LLP 0586](../../llp/0586-mastracode-session-capture.design.md) and
[LLP 0587](../../llp/0587-mastracode-session-capture.plan.md).
