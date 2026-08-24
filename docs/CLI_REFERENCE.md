# HypAware CLI command reference

This reference documents the visible commands shipped with HypAware. It uses
the canonical `hyp` spelling. The `hypaware` binary accepts the same arguments.

For installation, upgrade, recovery, and task-oriented workflows, see
[Use the HypAware CLI](./CLI.md).

## Read command syntax

In syntax blocks, angle brackets mark required values and square brackets mark
optional values. Replace uppercase values in examples with values for your
environment. Don't type the brackets.

Most usage errors return exit code `2`. Operational failures usually return
exit code `1`. A command can define a more specific contract, which this page
notes where stable. Use `--help` on any visible command to read the help for
your installed version.

## Plugin-owned commands

Core commands are always registered. Plugin-owned commands are registered only
when their plugin is active in the effective configuration. They also appear in
top-level and group help only while active.

This reference identifies each plugin-owned family:

- `session ...`: `@hypaware/ai-gateway`.
- `client claude-account ...`: `@hypaware/claude-account`.
- `client claude-desktop ...`: `@hypaware/claude-desktop`.
- `graph ...` and `query graph neighbors`: `@hypaware/context-graph`.
- `query vector ...` and `vector status`: `@hypaware/vector-search`.
- `enrichment ...`: `@hypaware/context-graph-enrich`.

Hidden credential and client-hook machine contracts aren't user commands and
aren't documented here. Hidden Gas City routes are also excluded because their
process-memory changes don't persist yet.

## Set up and inspect HypAware

### `hyp setup`

```text
hyp setup [preset] [flags]
```

Runs the guided setup, applies a named plugin preset, or performs an unattended
configuration. It can write or replace the local configuration, install the
daemon, attach clients, install client assets, and import history. `--dry-run`
writes nothing. `--force` backs up and replaces an existing configuration.
Important options include repeatable `--source` and `--client`, `--export`,
`--retention-days`, `--from-file`, `--no-daemon`, and `--bin`.

```sh
hyp setup --source claude --client claude --export keep-local --yes
```

Success returns `0`. Invalid arguments or a refused overwrite return `2`;
installation or configuration failures return `1`.

### `hyp status`

```text
hyp status [--json]
```

Collects one read-only health snapshot without activating plugins. It reports
configuration, daemon, active plugins, sources, sinks, clients, cache, recent
errors, first-sync state, and repair commands. For Claude, it also reports OTEL
attach mode, configured and live listener endpoints, endpoint drift, recorder
activity, and capture health. Use `--json` for the stable machine form.

```sh
hyp status --json
```

### `hyp ask`

```text
hyp ask ["question"] [--list]
```

Lists suggested questions or starts the first attached executable AI client on
a selected question. The client takes over the terminal. `--list` launches
nothing. An empty cache, a declined selection, or list-only use succeeds. No
launchable client or a process-start failure returns `1`.

```sh
hyp ask "which sessions changed the authentication module"
```

## Query recorded data

```text
hyp query <subcommand> [args...]
```

Use `hyp query --help` to list the query subcommands available in the current
configuration:

```sh
hyp query --help
```

Typed query commands accept shared rendering controls such as `--format`,
`--output`, `--max-cell`, and `--max-bytes`. They also accept
`--refresh never|auto|always` for local cache refresh and `--remote [TARGET]`
for remote execution when the command is a remote-capable typed verb. You
can't request an explicit local refresh and remote execution together.

### `hyp query overview`

```text
hyp query overview [--json] [--sql] [--days <n>] [--include-local-only]
```

Prints a local summary of token use, models, daily activity, repositories, and
tools. It chooses a bounded date window unless you set `--days`. `--sql` prints
the underlying queries. `--include-local-only` can place private local content
in output, so use it only in a context that won't be recorded or shared.

```sh
hyp query overview --days 30
```

The command is read-only and local-only. It returns `1` if no AI traffic
dataset is registered.

### `hyp query sql`

```text
hyp query sql <sql> [--include-local-only] [--format <fmt>] [--output <file>] [--max-cell <n>] [--max-bytes <n>] [--remote <target>]
```

Runs one read-only `SELECT` statement against registered datasets. Local
queries refresh the cache automatically by default and hide local-only rows
from callers that can sync. A bare `--remote` selects the default target;
`--remote TARGET` selects a named target. Formats are `table`, `json`, `jsonl`,
and `markdown`.

```sh
hyp query sql "select count(*) as rows from ai_gateway_messages"
```

Invalid or non-read-only SQL returns a usage error. Query, remote, or output
failures return `1`.

### `hyp query grep`

```text
hyp query grep <pattern> [--regex] [--session-id <id>] [--chain-id <id>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--limit <n>] [--include-local-only] [--format <fmt>] [--output <file>] [--max-cell <n>] [--max-bytes <n>] [--remote <target>]
```

Searches recorded `ai_gateway_messages` text without SQL. The pattern is a
case-insensitive substring by default, or a regular expression with `--regex`.
Hits arrive newest first, one row per matched column, each carrying
`session_id`, `message_id`, and `part_id` locators you can pivot into
`hyp query sql`. The default limit is `50` and the ceiling is `1000`; a larger
value clamps to the ceiling, and an unusable value falls back to the default.

Only these columns are searched: `content_text`, `tool_name`, `session_id`,
`conversation_id`, `agent_id`, `model`, `cwd`, `git_branch`, `git_remote`. Zero
hits is not evidence the text is absent from `system_text`, `tools`,
`tool_args`, `attributes`, or `raw_frame`; read those with `hyp query sql`.

Compacted data files are served through hypgrep sidecar indexes and the rest
are scanned, so coverage affects speed and never correctness.
`hyp cache status` prints the index coverage. Local-only rows are withheld with
a count on stderr, exactly as in SQL, and `--include-local-only` is the same
informed-consent override. `--remote TARGET` runs the same search on a server,
which enforces its own visibility: `--regex` is operator-only there, and
`--include-local-only` is rejected.

```sh
hyp query grep "connection refused" --from 2026-08-01 --format json
```

An unknown flag returns a usage error. A malformed `--from` or `--to`, an
invalid regular expression, and search or output failures all return `1`.

### `hyp query schema`

```text
hyp query schema <dataset>
```

Prints the registered columns for one local dataset. It doesn't activate a
remote target.

```sh
hyp query schema ai_gateway_messages
```

### `hyp query graph neighbors`

Plugin: `@hypaware/context-graph`.

```text
hyp query graph neighbors <node> [--depth <depth>] [--type <type>] [--edge-type <edge_type...>] [--direction out|in|both] [--limit <limit>] [--include-local-only] [--format <fmt>] [--output <file>] [--max-cell <n>] [--max-bytes <n>] [--remote <target>]
```

Resolves a node ID, natural key, or label, then walks the activity graph in
breadth-first order. Use `--type` to resolve an ambiguous seed, repeat
`--edge-type` to restrict relations, and use `--direction` to control edge
direction. The default depth is `1`, direction is `both`, and limit is `100`.
The parser also accepts `--json` for the command's structured result.

```sh
hyp query graph neighbors src/core/cli/dispatch.js --type File --depth 2 --direction in
```

This command is read-only and supports remote execution. An unresolved or
ambiguous seed returns `1`; invalid arguments return `2`. If the graph is
empty, build it with `hyp graph project`.

### `hyp query vector search`

Plugin: `@hypaware/vector-search`. The visible `hyp query vector` group lists
its search subcommand:

```text
hyp query vector <subcommand> [args...]
```

```sh
hyp query vector --help
```

Search syntax is:

```text
hyp query vector search <query> [--index <name>] [--dataset <name>] [--top-k <n>] [--no-refresh] [--format <fmt>]
```

Embeds the query and searches configured local vector shards. Automatic
refresh can write index data and call the configured embedder. `--no-refresh`
uses the shards as they are. This command is local-only; it doesn't accept
remote execution.

```sh
hyp query vector search "daemon restart failure" --top-k 5 --format json
```

## Render and manage reports

```text
hyp report <subcommand> [args...]
```

Use `hyp report --help` to list report operations:

```sh
hyp report --help
```

`render` is local. The other report commands use a remote server and resolve
the default remote if `--remote` is omitted. Publishing and deletion require a
write-capable credential.

### `hyp report render`

```text
hyp report render [<dir>] [--no-refresh-assets]
```

Builds a static HTML site from a local reports tree. The directory defaults to
`~/hypaware-reports`. It replaces the derived `html/` directory, preserves
source Markdown and `assets/theme.css`, and refuses an empty source tree.
`--no-refresh-assets` also preserves the other copied assets.

```sh
hyp report render ~/hypaware-reports
```

### `hyp report publish`

```text
hyp report publish <file-or-dir> --kind <kind> --period <period> [--title <title>] [--org <org>] [--remote <target>]
```

Uploads one HTML or Markdown file, or a directory bundle whose root contains
`report.html` or `report.md`. The server identifies repeat uploads by content
hash. `--org` applies only to an operator credential that can name an
organization.

```sh
hyp report publish ./html/usage-review --kind usage-review --period 2026-W34
```

### `hyp report list`

```text
hyp report list [--kind <kind>] [--period <period>] [--limit <n>] [--before <publishedAt>] [--org <org>] [--json] [--remote <target>]
```

Lists the newest reports visible to the selected organization. An empty list
succeeds.

```sh
hyp report list --kind usage-review --limit 10 --json
```

### `hyp report get`

```text
hyp report get <kind> <period> <id> [path] [--output <file>] [--org <org>] [--remote <target>]
```

Fetches a report's entry document or one artifact. Without `--output`, it
writes the exact bytes to standard output, including binary artifact bytes.

```sh
hyp report get usage-review 2026-W34 REPORT_ID --output ./usage-review.html
```

Replace `REPORT_ID` with the ID from `hyp report list`.

### `hyp report delete`

```text
hyp report delete <kind> <period> <id> [--yes] [--org <org>] [--remote <target>]
```

**Warning:** This operation permanently deletes the report and its artifacts
for every member of the organization. It prompts on a terminal. A
non-interactive call without `--yes` refuses with exit code `2`.

```sh
hyp report delete usage-review 2026-W34 REPORT_ID
```

Replace `REPORT_ID` with the reviewed report ID. Avoid `--yes` during manual
work so you can confirm the target.

## Send data now

### `hyp sync`

```text
hyp sync [instance] [--yes] [--dry-run]
```

Prints a destination and exclusion plan, confirms it, then forces the selected
sink or every configured sink to export. `--dry-run` sends nothing. On a newly
enrolled machine, an interactive all-destination sync can release the
first-sync review hold early. A single-instance sync can't release that hold.

```sh
hyp sync --dry-run
```

Any sink failure returns `1`. Avoid `--yes` until you have reviewed the plan.

## Control the current session

Plugin: `@hypaware/ai-gateway`. Use `hyp session --help` when the plugin is
active:

```text
hyp session <subcommand> [args...]
```

```sh
hyp session --help
```

If you omit the session ID, HypAware derives it from a supported Claude Code or
Codex context. It refuses rather than guessing. The in-memory state disappears
when the daemon restarts, and a fork has a new session ID.

### `hyp session status`

```text
hyp session status [session-id] [--json]
```

Checks every live recorder that advertises the shared session-control route.
Exit `0` means every recorder confirms that the session is ignored. Exit `1`
means at least one recorder confirms that it is recording. Exit `3` means the
result is unknown; assume the session is being recorded.

```sh
hyp session status
```

Folder policy remains independent. Use `hyp privacy show` to inspect it.

### `hyp session ignore`

```text
hyp session ignore [session-id] [--json]
```

Adds the exact session ID to every available recorder's in-memory drop set.
This stops future capture only. It doesn't delete existing rows. The Claude
telemetry listener deletes ignored-session bodies from its transient spool.

```sh
hyp session ignore
```

### `hyp session unignore`

```text
hyp session unignore [session-id] [--json]
```

Removes the exact session ID from the live recorder sets. Folder policy can
still prevent recording.

```sh
hyp session unignore
```

## Manage AI clients and history

```text
hyp client <subcommand> [args...]
```

Use `hyp client --help` to list core and active-plugin client operations:

```sh
hyp client --help
```

### `hyp client status`

```text
hyp client status [client] [--json]
```

Projects the client portion of the overall status snapshot. It reports whether
each client is configured, attached, attachable, recently active, and healthy.
For Claude, it includes OTEL endpoint drift and recorder health.

```sh
hyp client status claude --json
```

### `hyp client attach`

```text
hyp client attach [client] [--client <name>] [--dry-run] [--json]
```

Writes only HypAware-managed client settings and installs registered skills and
subagents. Repeating the command is a no-op. Claude Code uses its OTEL settings
and requires version 2.1.193 or later. Gateway-backed clients require an active
gateway configuration. `--dry-run` writes nothing.

```sh
hyp client attach claude --dry-run
```

Codex attach covers both Codex CLI and Codex Desktop because they share
`~/.codex/config.toml` and `~/.codex/sessions`.

### `hyp client detach`

```text
hyp client detach [client] [--client <name>] [--dry-run] [--purge] [--json]
```

Replays the on-disk undo marker and removes only managed settings. It keeps
recordings. Claude telemetry detach removes the managed OTEL settings and
sweeps the raw-body spool. For a legacy or other proxy attach, `--purge` also
removes the local interception CA and its keychain trust. `--dry-run` writes
nothing. The command doesn't ask for confirmation.

**Warning:** Use `--purge` only when you intend to remove the interception CA
and its keychain trust. You need to approve keychain changes again if you later
reattach through a proxy.

```sh
hyp client detach codex --dry-run
```

### Client history commands

Use the history group to inspect providers before you import:

```text
hyp client history <subcommand> [args...]
```

```sh
hyp client history --help
```

#### `hyp client history import`

```text
hyp client history import [provider...] [--since <iso>] [--until <iso>] [--retention-days <n>] [--dry-run] [--json]
```

Scans selected providers, materializes records into live datasets, appends
rows, and flushes the cache. Provider failures don't stop sibling providers.
`--dry-run` scans without writing.

```sh
hyp client history import claude codex --since 2026-08-01T00:00:00Z --dry-run
```

#### `hyp client history plan`

```text
hyp client history plan [provider...] [--retention-days <n>] [--json]
```

Calls provider planning hooks without importing rows. The command is
read-only. A provider planning failure can appear in output even when the
overall command returns `0`, so inspect every provider row.

```sh
hyp client history plan claude --json
```

#### `hyp client history providers`

```text
hyp client history providers [--json]
```

Lists every registered backfill provider, not only providers selected as
configuration defaults.

```sh
hyp client history providers --json
```

### Client skill commands

The visible `hyp client skills` group contains the install command:

```text
hyp client skills <subcommand> [args...]
```

```sh
hyp client skills --help
```

#### `hyp client skills install`

```text
hyp client skills install [--client <name>]
```

Replaces registered skill and subagent copies for one client, or for all
eligible clients when you omit `--client`. It requires a home directory and is
safe to repeat.

```sh
hyp client skills install --client codex
```

### Claude account commands

Plugin: `@hypaware/claude-account`. These commands are available only when the
plugin is active and configured for the intended credential mode.

```text
hyp client claude-account <subcommand>
```

#### `hyp client claude-account login`

```text
hyp client claude-account login
```

Starts an interactive Claude subscription OAuth flow. It opens a browser with
a loopback callback and offers pasted-code fallback. It stores a refreshable
credential in permission-restricted plugin state. Organization-key mode
refuses because it doesn't need subscription sign-in.

```sh
hyp client claude-account login
```

#### `hyp client claude-account logout`

```text
hyp client claude-account logout
```

Removes the locally stored subscription credential. It doesn't revoke the
credential at the server or remove organization-key configuration.

```sh
hyp client claude-account logout
```

#### `hyp client claude-account status`

```text
hyp client claude-account status
```

Reports the credential mode and whether a usable credential is present. A
missing, expired, unreadable, or unresolved credential returns `1`.

```sh
hyp client claude-account status
```

### Claude Desktop commands

Plugin: `@hypaware/claude-desktop`. These commands require macOS where noted,
an active local gateway capability, and the Claude account credential
capability.

`hyp init` does not offer Claude Desktop (LLP 0297): its setup is a browser
sign-in plus a `sudo` write to a root-owned system file, which is not
something a first-run checklist should ask for. The plugin is not activated by
default either, so these commands register only once the config names it - on
a config that does not, `hyp` reports which plugin owns the command and how to
add it. The whole set Desktop capture needs is:

```json
{
  "plugins": [
    { "name": "@hypaware/ai-gateway", "config": { "upstreams": [
      { "name": "anthropic", "base_url": "https://api.anthropic.com",
        "path_prefix": "/v1/messages", "provider": "anthropic" }
    ] } },
    { "name": "@hypaware/claude-account", "config": { "mode": "subscription" } },
    { "name": "@hypaware/claude-desktop" }
  ]
}
```

`@hypaware/claude-account` is not optional: it provides the
`hypaware.anthropic-credential` capability `@hypaware/claude-desktop`
requires, and without it the adapter fails activation and its commands never
register. Merge those entries into the `plugins[]` already in
`~/.hyp/hypaware-config.json`, restart the daemon, then run:

```sh
hyp client claude-desktop install
hyp client claude-desktop verify
```

```text
hyp client claude-desktop <subcommand> [args...]
```

#### `hyp client claude-desktop install`

```text
hyp client claude-desktop install [--yes] [--print-commands]
```

Runs the attended macOS setup: explains the changes, signs in if needed,
writes the credential helper, backs up and clears stale dialog residue, writes
the root-owned managed-preferences property list through `sudo`, and asks you
to restart Claude Desktop. It is resumable and idempotent.
`--print-commands` changes nothing. `--yes` accepts the explained local changes
but doesn't bypass browser or `sudo` authentication.

```sh
hyp client claude-desktop install --print-commands
```

#### `hyp client claude-desktop status`

```text
hyp client claude-desktop status
```

Reports the resolved endpoint, credential mode, helper path, models, and bundle
ID. A missing helper returns `1`. This command doesn't verify the installed
property list.

```sh
hyp client claude-desktop status
```

#### `hyp client claude-desktop verify`

```text
hyp client claude-desktop verify
```

Checks that the managed property list is present and current and that stale
dialog residue is cleared. Those automatic checks determine the exit code. It
also prints a manual in-app capture check, which doesn't affect the exit code.

```sh
hyp client claude-desktop verify
```

#### `hyp client claude-desktop profile`

```text
hyp client claude-desktop profile [--plist] [--out <path>]
```

Renders a secret-free managed third-party-inference profile as JSON, or as a
managed-preferences property-list dictionary with `--plist`. `--out` writes the
result to a file. Install the helper first.

```sh
hyp client claude-desktop profile --plist --out ./claude-desktop.plist
```

#### `hyp client claude-desktop install-helper`

```text
hyp client claude-desktop install-helper [--path <path>]
```

Writes the executable, no-argument credential wrapper that the Desktop profile
references. The default location is in plugin state and outside protected
desktop directories.

```sh
hyp client claude-desktop install-helper
```

## Control privacy

```text
hyp privacy <subcommand> [args...]
```

Use `hyp privacy --help` to list privacy operations:

```sh
hyp privacy --help
```

Directory classes are `sync`, `local-only`, and `ignore`. A policy marking is
prospective; it doesn't delete rows already in the cache. Use purge only when
you intend to delete existing local data.

### `hyp privacy show`

```text
hyp privacy show [path] [--json]
```

Resolves the governing class and source for a path, which defaults to the
current directory. It also reports a best-effort residual cache count.

```sh
hyp privacy show . --json
```

### `hyp privacy set`

```text
hyp privacy set <path> sync|local-only|ignore
```

Upserts an exact machine-local path marking. It doesn't write a dotfile or
delete rows.

```sh
hyp privacy set ./private-research local-only
```

### `hyp privacy unset`

```text
hyp privacy unset <path> [sync|local-only|ignore]
```

Removes machine-local entries governing the path. Add a class to remove only
entries of that class. The operation is idempotent and doesn't delete rows.

```sh
hyp privacy unset ./private-research local-only
```

### `hyp privacy list`

```text
hyp privacy list [--json]
```

Lists machine-local path and client policy plus the new-folder prompt
preference. It can't globally enumerate `.hypignore` files; use
`hyp privacy show PATH` for a specific path.

```sh
hyp privacy list --json
```

### `hyp privacy ignore`

```text
hyp privacy ignore [path] [--check] [--json] [--local-only | --private | --sync]
```

Without a class flag, writes a shareable `.hypignore` file at the explicit path
or repository root. `--private`, `--local-only`, and `--sync` write the
equivalent machine-local marking instead. `--check` reports without writing.
The flags are mutually exclusive.

```sh
hyp privacy ignore ./customer-data --check
```

### `hyp privacy unignore`

```text
hyp privacy unignore [path] [--local-only | --private | --sync]
```

Without a class flag, removes the nearest governing `.hypignore`. A class flag
removes the matching machine-local entry. It doesn't remove cached rows.

```sh
hyp privacy unignore ./customer-data
```

### `hyp privacy client`

```text
hyp privacy client [<name>] [sync|local-only] [--json]
```

Lists or changes per-client export policy. `local-only` withholds future rows
from remote sync. Returning to `sync` affects future rows only; rows withheld
while local-only aren't uploaded later. A client required by central
configuration can't opt out.

```sh
hyp privacy client codex local-only
```

### `hyp privacy folders`

```text
hyp privacy folders [ask|sync] [--json]
```

Reports or changes whether unclassified folders sync by default or prompt once
for classification. Existing markings and `.hypignore` files don't change.

```sh
hyp privacy folders ask
```

### `hyp privacy purge`

```text
hyp privacy purge <path> | --session <id> | --ignored | --all [--yes] [--json]
```

**Warning:** This operation permanently deletes matching rows from this
machine's local cache. Select exactly one target. It never contacts a sink or
remote server and can't retract exported copies. Every form also sweeps the
Claude raw-body spool so pending bodies can't recreate deleted rows. A terminal
prompts for confirmation; a non-interactive call requires `--yes`.

```sh
hyp privacy purge --session SESSION_ID
```

Replace `SESSION_ID` with the reviewed session ID. Avoid `--yes` during manual
work.

## Connect to or leave a central server

### `hyp join`

```text
hyp join <url> [token] [--token-file <path>] [--bin <path>] [--no-daemon]
```

Validates the server and enrollment token, writes a permission-restricted
central seed layer, and installs or restarts the daemon. The full organization
configuration arrives later. Local configuration and history remain.
`--no-daemon` writes only the seed and leaves service installation as an
explicit next step.

```sh
hyp join https://hyp.example.com --token-file ./enrollment-token
```

Prefer `--token-file` or standard input. A positional token can appear in shell
history and process listings.

### `hyp leave`

```text
hyp leave
```

Removes the central layer, identity, and forwarding credential, restarts the
daemon, and reverses organization-driven client attaches. It keeps the local
configuration, daemon service, query history, and recordings. Partial failure
returns `1` and prints repair commands.

```sh
hyp leave
```

## Manage the daemon

```text
hyp daemon <subcommand> [args...]
```

Use `hyp daemon --help` to list service operations:

```sh
hyp daemon --help
```

Daemon commands don't activate plugins.

### `hyp daemon install`

```text
hyp daemon install [--config <path>] [--bin <path>] [--dry-run [--json]]
```

Installs the persistent launchd or systemd user service. When invoked from an
ephemeral `npx` path, it installs a durable global package before it writes the
service. `--dry-run` renders the exact service definition without changing the
machine; add `--json` for structured plan output.

```sh
hyp daemon install --dry-run --json
```

### `hyp daemon uninstall`

```text
hyp daemon uninstall
```

**Warning:** This command stops persistent capture and detaches clients. Check
`hyp status` before you uninstall the daemon so you know which clients it
changes.

Removes the persistent service, then detaches every attached client so no
client points at a dead gateway. It keeps configuration, recordings, and logs.
The command doesn't ask for confirmation. If service removal succeeds but a
detach fails, the command returns `1` and prints the detach command needed to
finish.

```sh
hyp daemon uninstall
```

### `hyp daemon run`

```text
hyp daemon run --foreground [--config <path>]
```

Runs the daemon in the current terminal until it receives a stop signal.
`--foreground` is required.

```sh
hyp daemon run --foreground
```

### `hyp daemon start`

```text
hyp daemon start
```

Starts the installed service. It returns `1` if no service is installed or the
service manager can't start it.

```sh
hyp daemon start
```

### `hyp daemon status`

```text
hyp daemon status [--json]
```

Reads the daemon status and process ID files without activating plugins. A
missing status file prints `not started` and returns `0`. Malformed status or
read failures return `1`.

```sh
hyp daemon status --json
```

### `hyp daemon stop`

```text
hyp daemon stop
```

Signals the running daemon and waits up to five seconds. An already stopped
daemon succeeds. A timeout returns `1`.

```sh
hyp daemon stop
```

### `hyp daemon restart`

```text
hyp daemon restart
```

Restarts an installed service. If no service is installed, it stops a
foreground daemon and tells you how to relaunch or install it.

```sh
hyp daemon restart
```

## Validate configuration

```text
hyp config <subcommand> [args...]
```

Use `hyp config --help` to list configuration operations:

```sh
hyp config --help
```

### `hyp config validate`

```text
hyp config validate [--path <file>]
```

Loads the effective configuration or an explicit file and cross-validates
plugin, dataset, source, and sink contracts. It is read-only. Validation
failures return `1` with detailed pointers.

```sh
hyp config validate --path ./hypaware-config.json
```

## Manage the local cache

```text
hyp cache <subcommand> [args...]
```

Use `hyp cache --help` to list cache operations:

```sh
hyp cache --help
```

### `hyp cache status`

```text
hyp cache status
```

Prints dataset registration and cache freshness. It is read-only.

```sh
hyp cache status
```

### `hyp cache refresh`

```text
hyp cache refresh [dataset]
```

Forces refresh for one dataset or every registered dataset. It writes refreshed
partitions to the local cache.

```sh
hyp cache refresh ai_gateway_messages
```

### `hyp cache maintain`

```text
hyp cache maintain [dataset] [--dry-run] [--force] [--compact-only] [--expire-only]
```

Runs legacy migration, snapshot expiration, compaction, and settlement work for
one dataset or all datasets. `--dry-run` writes nothing. `--compact-only` and
`--expire-only` limit the operation. Maintenance continues past partition
failures and returns `1` if any partition failed.

```sh
hyp cache maintain ai_gateway_messages --dry-run
```

## Maintain exports

```text
hyp sink <subcommand> [args...]
```

Use `hyp sink --help` to list sink operations:

```sh
hyp sink --help
```

### `hyp sink maintain`

```text
hyp sink maintain [instance] [--compact] [--dry-run]
```

Expires table-format export snapshots for one sink instance or all eligible
instances. Only `--compact` rewrites data files. `--dry-run` writes nothing.

```sh
hyp sink maintain local-parquet --dry-run
```

## Manage plugins

```text
hyp plugin <subcommand> [args...]
```

Use `hyp plugin --help` to list plugin operations:

```sh
hyp plugin --help
```

### `hyp plugin install`

```text
hyp plugin install <source> [--ref <ref>] [--path <subdir>] [--yes]
```

Installs a plugin from a recognized name, Git source, or local directory and
updates the plugin lock. For remote code, HypAware fetches and validates the
manifest, then shows the source, resolved revision, permissions, and warnings
before confirmation. Non-interactive remote installation requires `--yes`.
Pin a commit with `--ref` when the source has no fragment. `--path` is reserved
but isn't currently supported for Git subdirectories.

```sh
hyp plugin install github:example/hypaware-plugin-widget --ref COMMIT_SHA
```

Replace `COMMIT_SHA` with a reviewed commit. Installing code authorizes it to
run during plugin activation, so don't approve an unreviewed source.

### `hyp plugin list`

```text
hyp plugin list [--json]
```

Lists active bundled plugins and installed plugins with source and state.

```sh
hyp plugin list --json
```

### `hyp plugin info`

```text
hyp plugin info <plugin>
```

Prints manifest, source, lock, version, permissions, and update details for one
installed plugin.

```sh
hyp plugin info @example/hypaware-plugin-widget
```

### `hyp plugin outdated`

```text
hyp plugin outdated [--json]
```

Lists installed plugins whose cached update metadata reports a newer revision.
It doesn't install an update.

```sh
hyp plugin outdated --json
```

### `hyp plugin update`

```text
hyp plugin update [plugin] [--yes]
```

With a plugin name, fetches, validates, confirms, and installs that plugin's
new revision. It applies the same remote-code trust gate as install. Without a
plugin name, it refreshes update metadata and doesn't install code.

```sh
hyp plugin update @example/hypaware-plugin-widget
```

### `hyp plugin remove`

```text
hyp plugin remove <plugin>
```

Removes installed plugin code and its lock entry. It doesn't edit the active
configuration, so validate or reconfigure afterward if the configuration still
names the plugin.

```sh
hyp plugin remove @example/hypaware-plugin-widget
```

## Manage remote query targets

```text
hyp remote <subcommand> [args...]
```

Use `hyp remote --help` to list remote operations:

```sh
hyp remote --help
```

### `hyp remote add`

```text
hyp remote add <name> <url>
```

Registers a named Model Context Protocol (MCP) query target in local
configuration. It doesn't authenticate.

```sh
hyp remote add team https://hyp.example.com/mcp
```

### `hyp remote login`

```text
hyp remote login <name> [--token-file <path>] [--no-forward] [--no-daemon]
```

Signs in through a browser by default, or reads a static token from
`--token-file` or standard input. It stores the credential with mode `0600`.
The parser also accepts `--org`, `--no-browser`, and `--host`. Unless you set
`--no-forward`, login can enroll this machine, provision forwarding, and
install the daemon. `--no-daemon` provisions without installing the service.

```sh
hyp remote login team --no-forward
```

### `hyp remote mint`

```text
hyp remote mint [name] [--label <label>] [--expires-days <n>]
```

Mints a long-lived CI enrollment token from your logged-in session and prints
it once, for pasting into CI secrets. It requires a session stored by
`hyp remote login`. Omit `name` to mint against the default target.
`--label` names the gateway the token is bound to, and `--expires-days`
overrides the 365-day default. Every CI run that joins with the token shares
that one gateway, and the token itself never rotates.

```sh
hyp remote mint team --label repo-ci --expires-days 90
```

The token is written to standard output on its own; the summary line, the
warning, and the recipe go to standard error, so `hyp remote mint > ci.token`
stores exactly the secret.

Use the printed token as the CI recipe's bootstrap credential. The recipe names
the server base, which is what `hyp join` expects, even when the target was
registered with a `/v1/mcp` suffix, and feeds the token on standard input
rather than as a positional argument, which would expose a long-lived shared
secret to `ps` and to `set -x` traces on the runner:

```sh
# setup
printf '%s' "$HYP_CI_TOKEN" | hyp join https://hyp.example.com --no-daemon
hyp daemon run --foreground &
# ... the job's steps ...
# teardown: flush what the schedule has not exported yet
hyp sync --yes
```

### `hyp remote list`

```text
hyp remote list [--json]
```

Lists target URLs and credential status. It never prints credential values.

```sh
hyp remote list --json
```

### `hyp remote remove`

```text
hyp remote remove <name>
```

Removes the named target and its locally stored token. It doesn't leave central
enrollment; use `hyp leave` for that.

```sh
hyp remote remove team
```

## Serve MCP tools

### `hyp mcp serve`

```text
hyp mcp serve [--remote <target>]
```

Serves active typed verbs over standard input and output, or proxies a named
remote target. Standard output is protocol-only. Human diagnostics go to
standard error. The current release refuses an HTTP serving mode.

```sh
hyp mcp serve --remote team
```

## Build and maintain the activity graph

Plugin: `@hypaware/context-graph`. Use graph help to list the active commands:

```text
hyp graph <subcommand> [args...]
```

```sh
hyp graph --help
```

### `hyp graph project`

```text
hyp graph project [--source <dataset>] [--dry-run]
```

Reads registered projection contracts and writes the derived `node` and `edge`
datasets. It is idempotent. `--source` limits projection to one source dataset,
and `--dry-run` writes nothing. An empty successful result means that no
eligible recordings exist.

```sh
hyp graph project --dry-run
```

### `hyp graph compact`

```text
hyp graph compact [--dry-run]
```

Merges duplicate graph rows and rewrites affected partitions in sorted order.
Queries don't require compaction, but large graphs can read faster afterward.

```sh
hyp graph compact --dry-run
```

## Inspect vector indexes

Plugin: `@hypaware/vector-search`.

### `hyp vector status`

```text
hyp vector status [--json]
```

Reports local vector-index configuration, shard coverage, and staleness. It is
read-only and requires active vector-search and embedder capabilities.

```sh
hyp vector status --json
```

## Enrich the activity graph

Plugin: `@hypaware/context-graph-enrich`. The visible `hyp enrichment` group
lists its operations:

```text
hyp enrichment <propose|curate|backfill|status>
```

```sh
hyp enrichment --help
```

Enrichment can call configured completion providers and write proposal,
resolution, committed-knowledge, and derived graph data.

### `hyp enrichment propose`

```text
hyp enrichment propose
```

Runs one T1 proposal tick over settled sessions and writes new prospect rows.

```sh
hyp enrichment propose
```

### `hyp enrichment curate`

```text
hyp enrichment curate
```

Runs one synchronous T2 curation tick over pending prospects. It can call the
configured completion provider and write resolution and committed rows.

```sh
hyp enrichment curate
```

### `hyp enrichment backfill`

```text
hyp enrichment backfill [--propose-only|--curate-only]
```

Processes historical sessions. The parser also accepts `--since YYYY-MM-DD`
to scope curation and `--dry-run` to avoid submitting curation batches.
`--propose-only` and `--curate-only` are mutually exclusive. Proposal work can
write prospect rows before a later dry-run curation phase, so use
`--curate-only --dry-run` when you require a completely read-only check of the
curation pool.

```sh
hyp enrichment backfill --curate-only --since 2026-08-01 --dry-run
```

### `hyp enrichment status`

```text
hyp enrichment status
```

Prints proposal and curation watermarks plus prospect, resolution, and
committed-knowledge counts. It is read-only.

```sh
hyp enrichment status
```

## Print version information

### `hyp version`

```text
hyp version
```

Prints the HypAware version, Node.js version, platform, architecture, and
effective `HYP_HOME`. It doesn't activate plugins.

```sh
hyp version
```

## Develop plugins

```text
hyp dev <subcommand> [args...]
```

Use `hyp dev --help` and `hyp dev plugin --help` to list developer commands:

```sh
hyp dev --help
hyp dev plugin --help
```

### `hyp dev plugin new`

```text
hyp dev plugin new <name> [--kind source|sink|dataset] [--dir <path>]
```

Creates a source, sink, or dataset plugin scaffold. It refuses to overwrite an
existing target.

```sh
hyp dev plugin new @example/hypaware-plugin-widget --kind source --dir ./plugins
```

### `hyp dev plugin doctor`

```text
hyp dev plugin doctor [dir] [--json]
```

Aggregates static manifest and entrypoint checks, then imports and activates
the plugin in an isolated state directory. This is a dry-run for state paths,
not a security sandbox. Run it only on code you trust. Warnings can return `0`;
errors return `1`.

```sh
hyp dev plugin doctor ./plugins/hypaware-plugin-widget --json
```

### Internal: `hyp dev smoke`

```text
hyp dev smoke <flow-name>
```

This hidden developer command runs one hermetic smoke flow under a fresh
temporary `HYP_HOME` and propagates the child exit code. It doesn't prove the
installed daemon or a real client. Use it only when developing HypAware.

```sh
hyp dev smoke status_diagnostics
```
