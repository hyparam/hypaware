[← All documentation](README.md)

---

# HypAware CLI command reference

This reference documents the visible commands shipped with HypAware. It uses
the canonical `hyp` spelling. The `hypaware` binary accepts the same arguments.

For task guides, start at the [documentation index](README.md). This reference
defines command syntax and behavior; the guides explain common workflows.

## Contents

- [Read command syntax](#read-command-syntax)
- [Plugin-owned commands](#plugin-owned-commands)
- [Set up and inspect HypAware](#set-up-and-inspect-hypaware)
- [Query recorded data](#query-recorded-data)
- [Generate and manage reports](#generate-and-manage-reports)
- [Send data now](#send-data-now)
- [Control the current session](#control-the-current-session)
- [Manage AI clients](#manage-ai-clients)
- [Import past client history](#import-past-client-history)
- [Collect GitHub activity](#collect-github-activity)
- [Control privacy](#control-privacy)
- [Connect to or leave HypAware Cloud](#connect-to-or-leave-hypaware-cloud)
- [Manage the daemon](#manage-the-daemon)
- [Validate configuration](#validate-configuration)
- [Manage the local cache](#manage-the-local-cache)
- [Maintain exports](#maintain-exports)
- [Manage plugins](#manage-plugins)
- [Manage remote query targets](#manage-remote-query-targets)
- [Serve MCP tools](#serve-mcp-tools)
- [Build and maintain the activity graph](#build-and-maintain-the-activity-graph)
- [Inspect vector indexes](#inspect-vector-indexes)
- [Enrich the activity graph](#enrich-the-activity-graph)
- [Update HypAware](#update-hypaware)
- [Control product telemetry](#control-product-telemetry)
- [Print version information](#print-version-information)
- [Develop plugins](#develop-plugins)
- [Use canonical command names](#use-canonical-command-names)

## Read command syntax

In syntax blocks, angle brackets mark required values and square brackets mark
optional values. Replace uppercase values in examples with values for your
environment. Don't type the brackets.

Most usage errors return exit code `2`. Operational failures usually return
exit code `1`. A command can define a more specific contract, which this page
notes where stable. Use `--help` on any visible command to read the help for
your installed version.

## Plugin-owned commands

Core commands and core group headings remain visible. Plugin-owned subcommands
appear in help and can run only when their plugin is active in the effective
configuration. A visible group heading does not mean every subcommand is enabled.
If an inactive plugin owns a command you enter, HypAware names the plugin and
prints a repair instruction.

The examples below assume their owning plugins are enabled in the effective
configuration. Listing a plugin in this reference doesn't enable it. Add it
to `plugins[]` in your configuration and configure any dependencies it requires.
Use `hyp config validate` to check the configuration and `hyp plugin list`
to inspect plugin status. A successful `--help` check only verifies the help
page; it doesn't prove the plugin can run.

This reference identifies each plugin-owned family:

- `session ...`: shared commands provided by `@hypaware/ai-gateway`,
  `@hypaware/opencode`, `@hypaware/pi`, or `@hypaware/cursor`.
- `query grep`: `@hypaware/grep`.
- `github ...`: `@hypaware/github`.
- `client claude-account ...`: `@hypaware/claude-account`.
- `client claude-desktop ...`: `@hypaware/claude-desktop`.
- `graph ...` and `query graph neighbors`: `@hypaware/context-graph`.
- `query vector ...` and `vector status`: `@hypaware/vector-search`.
- `enrichment ...`: `@hypaware/context-graph-enrich`.

Internal credential and client-hook commands are excluded from this user reference.

## Set up and inspect HypAware

### `hyp setup`

```text
hyp setup [preset] [flags]
```

Runs the guided setup, applies a named plugin preset, or performs an unattended
configuration. It can write or replace the local configuration, install the
daemon, attach clients, install client assets, and import history.
`--force` backs up and replaces an existing configuration.
Important options include repeatable `--source` and `--client`, `--export`,
`--retention-days`, `--from-file`, `--github`, `--no-backfill`, `--no-daemon`,
and `--bin`. `--github` enables GitHub collection (a separate opt-in that
`--yes` never implies) without signing in; run `hyp github login` afterward.
With `--from-file`, it adds GitHub to the supplied configuration and keeps its
other settings. `--no-backfill` skips the optional one-time history imports;
clients with scheduled recovery still import history. Neither flag applies to
a preset.

With no arguments and no output terminal, setup prints an agent guide on
stdout and exits `0` without configuring the machine. It lists detected
sources, recording disclosures, choices and commands, browser sign-in
handoffs, and verification. An agent asks the person before selecting sources
or enabling cloud sync, then runs explicit unattended flags. `hyp setup
--guide` prints the same guide even on a terminal; use this flag alone.
Cloud login from an agent shell needs `hyp remote login --no-browser` (print
the sign-in URL) or `--browser` (open it); without either flag piped stdin is
treated as a static token. After setup with `--github`, `hyp github login`
opens the authorization page (`--no-browser` prints the URL and device code
instead). The person completes each browser sign-in while the command waits.

`--dry-run` reports what would be written and writes no configuration,
including with `--from-file`. It still refuses an existing configuration
without `--force`, exactly where a real run would.

```sh
hyp setup --source claude --client claude --export keep-local --yes
```

Success returns `0`. Invalid flags return `2`. A refused overwrite, an unknown
preset, or a `--from-file` configuration that cannot be read or does not
validate returns `1`. A failed daemon install is normally not fatal: setup
returns `0` and prints a note to run `hyp daemon install`, so a zero exit does
not prove the background service was installed. Refusing to persist a service
against a non-durable CLI path, which an `npx` run without a global install
hits, returns `1` instead.

### `hyp status`

```text
hyp status [--verbose] [--json]
```

Collects one read-only health snapshot without activating plugins. By default it
prints a summary: daemon state, storage, each client's attach state and sharing
policy, first-sync state, and an Attention section whose `Next:` lines are the
commands to run. `--verbose` adds the inventory behind that summary:
configuration, active plugins, sources, sinks, cache, recent errors, proxy
trust, maintenance, recent clients, capture health, and the `repair:` lines
under each diagnostic. Configured and live listener endpoints and endpoint
drift are reported by `hyp client status`. Use `--json` for the stable machine
form; `--verbose` does not change it.

```sh
hyp status --json
```

### `hyp ask`

```text
hyp ask ["question"]
```

With no argument, asks which skill would be useful to add based on your history.
HypAware measures the last 30 days of recorded history, writes the evidence into
`<HYP_HOME>/ask` (one folder,
rewritten each time), and starts a recorded AI client in that folder to answer
with one skill. Recorded means attached, or configured with no attach marker
to write (Codex in its transcript mode); its CLI must also be on `PATH`. If
more than one such client could be started, it asks which. A run that cannot
prompt (input or output is not a terminal, or `HYP_NO_TUI=1`) prints the
question and launches nothing, gathering no evidence; unlike the with-question
path below, it takes no fallback client.

With a question, skips the gather and starts a client on that question in the
current directory, asking which client should answer when more than one could.
A run that cannot prompt (input or output is not a terminal, or `HYP_NO_TUI=1`)
takes the first client of the offered set rather than failing. The pick is also
time-bounded on a terminal: unanswered for 10 seconds, it takes that same
first client and says so on stdout (`No answer at the client prompt - starting
the first one.`). The first keypress lifts the deadline, so a pick someone is
answering is never cut short. The client does not receive the bare question:
it is framed with an instruction to look the answer up in the recorded
sessions with `hyp query` first, and the typed question follows verbatim.

The client takes over the terminal. An empty cache or a declined selection
succeeds. No gatherable evidence returns `1`. When no recorded client can be
started, `hyp ask` prints the same error with or without a question and returns
`1`; that check comes first, so it applies on an empty cache too. The error
says which half is missing: a client CLI that is on `PATH` but not recorded is
answered with the `hyp client attach` command to run, and no client CLI on
`PATH` at all is answered with the binaries it looked for, since an attach
would not give it anything to start. That second refusal also names any
recorded client it cannot start, since neither an install nor a `PATH` fix
would make one of those launchable either: only Claude Code and Codex declare
how to be started on a question, so a recorded Cursor, OpenClaw, OpenCode, Pi
or Claude Desktop is named there instead. In that second case, if a recorded
client has the `hypaware-query` skill installed (a Claude or Codex desktop app
with no CLI), `hyp ask` also prints the prompt to paste into the app: the typed
question framed for `hyp query`, or for the bare form a version of the skill
question that looks through the history itself, since no evidence is gathered
for an app it cannot start. The prompt is the only thing written to stdout, so
`hyp ask | pbcopy` copies it; the exit status is still `1`, because nothing was
started. A process-start failure returns `1` when a question was supplied; bare
`hyp ask` currently reports that failure but still exits `0`. Its exit status
therefore does not prove a client started.

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
With `--remote`, an operator can add `--org <label|*>` to read one org by
label or every org the account may read. It is rejected without `--remote`,
and the remote records each such read in that org's audit trail.

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
hyp query sql <sql> [--include-local-only] [--format <fmt>] [--output <file>] [--max-cell <n>] [--max-bytes <n>] [--remote <target> [--org <label|*>]]
```

Runs one read-only `SELECT` statement against registered datasets. Local
queries refresh the cache automatically by default and hide local-only rows
from callers that can sync. A bare `--remote` selects the default target;
`--remote TARGET` selects a named target. Formats are `table`, `json`, `jsonl`,
and `markdown`.

```sh
hyp query sql "select count(*) as rows from ai_gateway_messages"
```

A malformed flag or a missing statement returns a usage error. The statement
itself is parsed during the run, so invalid or non-read-only SQL returns `1`,
as do query and output failures. A `--remote` failure splits on
who refused: an unregistered target, no stored credential, or a stored login
the identity endpoint reports as revoked or expired returns `2`; a failure at
the remote itself returns `1`, whether a transport error, an error the remote
reports, a credential it rejects, or an `--org` refusal.

### `hyp query grep`

```text
hyp query grep <pattern> [--regex] [--session-id <id>] [--chain-id <id>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--limit <n>] [--include-local-only] [--format <fmt>] [--output <file>] [--max-cell <n>] [--max-bytes <n>] [--remote <target> [--org <label|*>]]
```

Provided by `@hypaware/grep`, which standard capture setups enable. An explicit
`enabled: false` entry keeps it disabled. An existing configuration gains the
plugin automatically on startup; the migration backs the local config up before
writing it. With a read-only config, search remains available for the current
process and a warning reports that persistence failed.

Searches recorded `ai_gateway_messages` text without SQL. The pattern is a
case-insensitive substring by default, or a regular expression with `--regex`.
Hits arrive newest first, one row per matched column, each carrying
`session_id`, `message_id`, and `part_id` locators you can pivot into
`hyp query sql`. The default limit is `50` and the ceiling is `1000`: a larger
value clamps to the ceiling, and a value the flag cannot use at all (`0`,
negative, fractional) is a usage error rather than a quiet 50.

Only these columns are searched: `content_text`, `tool_name`, `session_id`,
`conversation_id`, `agent_id`, `model`, `cwd`, `git_branch`, `git_remote`. Zero
hits is not evidence the text is absent from `system_text`, `tools`,
`tool_args`, `attributes`, or `raw_frame`; read those with `hyp query sql`.

Local search scans the cache directly without building or reading indexes.
Narrow the date range on large histories to reduce scan work. A remote target
keeps its own hypgrep indexes. Local-only rows are withheld with
a count on stderr, exactly as in SQL, and `--include-local-only` is the same
informed-consent override. `--remote TARGET` runs the same search remotely,
which enforces its own visibility: `--regex` is operator-only there, and
`--include-local-only` is rejected.

```sh
hyp query grep "connection refused" --from 2026-08-01 --format json
```

An unknown flag returns a usage error, and so does any `--from`/`--to` that
cannot select a day: one not shaped `YYYY-MM-DD`, or a `--from` later than the
`--to`. Both would otherwise prune every file and render an empty answer that
reads like "nothing is recorded". A pattern the search cannot use is a usage
error too: an invalid regular expression under `--regex`, or one longer than
1024 characters. Those day and pattern checks are local: `--remote` hands the
request to the remote, which applies its own argument rules and its own codes
(the flag-shape and `--limit` checks still run locally, before the request is
sent). Search or output failures return `1`.

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
hyp query graph neighbors <node> [--depth <depth>] [--type <type>] [--edge-type <edge_type...>] [--direction out|in|both] [--limit <limit>] [--include-local-only] [--format <fmt>] [--output <file>] [--max-cell <n>] [--max-bytes <n>] [--remote <target> [--org <label|*>]]
```

Resolves a node ID, natural key, or label, then walks the activity graph in
breadth-first order. Use `--type` to resolve an ambiguous seed, repeat
`--edge-type` to restrict relations, and use `--direction` to control edge
direction. The default depth is `1`, direction is `both`, and limit is `100`.
The parser also accepts `--json` for the command's structured result.

```sh
hyp query graph neighbors src/app.js --type File --depth 2 --direction in
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

Requires active `@hypaware/vector-search` and a configured embedder provider,
such as `@hypaware/embedder-openai`, plus at least one configured vector index.

Search syntax is:

```text
hyp query vector search <query> [--index <name>] [--dataset <name>] [--top-k <n>] [--no-refresh] [--format <fmt>] [--max-cell <n>] [--max-bytes <n>]
```

Embeds the query and searches configured local vector shards. Automatic
refresh can write index data and call the configured embedder. `--no-refresh`
uses the shards as they are. This command is local-only; it doesn't accept
remote execution.

```sh
hyp query vector search "daemon restart failure" --top-k 5 --format json
```

## Generate and manage reports

```text
hyp report <subcommand> [args...]
```

Use `hyp report --help` to list report operations:

```sh
hyp report --help
```

`generate` and `save` are local. The other report commands use a remote
target and resolve the default remote if `--remote` is omitted. `publish`,
`recommend`, `mark`, and `delete` require a write-capable credential.

### `hyp report generate`

```sh
hyp report generate
hyp report generate "Cover last week and focus on repeated debugging work"
```

Launches a recorded AI client with its installed `hypaware-report` skill in
the caller's current working directory. Recorded means what it does for
`hyp ask`: attached, or configured with no attach marker to write (Codex in
its transcript mode). Its CLI must also be on `PATH`, and the
`hypaware-report` skill must already be installed for it. Optional quoted
instructions set the period or focus; otherwise the skill uses the previous
calendar month. If more than one such client could be started, it asks which;
a run that cannot prompt (input or output is not a terminal, or `HYP_NO_TUI=1`)
takes the first client of the offered set rather than failing. That pick is
also time-bounded on a terminal: unanswered for 10 seconds, it takes that same
first client and says so on stdout (`No answer at the client prompt - starting
the first one.`), and the first keypress lifts the deadline. The client keeps
its normal permissions, and the session is recorded under the current
directory's own usage class: this is not session isolation, so excerpts it
reads out of `local-only` history are quoted into a transcript that syncs if
the directory you typed the command in does
([PRIVACY.md](PRIVACY.md#marking-directories)). No remote login is required,
and nothing is published unless requested.

The skill drafts `./hypaware-report-<from>-to-<to>/report.md` and linked
pages, using `-2`, `-3`, etc. if the folder already exists, unless you request
another destination, and once the report is reviewed runs
`hyp report save` on that folder, which moves it into `$HYP_HOME/reports`.
A declined pick starts nothing and succeeds; no recorded client carrying the
skill, or a process-start failure, returns `1`. The exit status covers the
launch only, never whether report generation completed. `hyp report list`
shows the saved report; `hyp report publish <name> ...` shares it.

### `hyp report save`

```text
hyp report save <dir> [--keep]
```

Moves a finished report folder into the store, `$HYP_HOME/reports/<name>/`
(`~/.hyp/reports` unless `HYP_HOME` is set), where `hyp report list` finds it
and `hyp report publish <name>` takes it by name. The skill ends with this
step so an agent never writes under your home directory itself.

The folder is held to the publish allow-list before anything moves: it must
hold `report.md` and otherwise only `usage.md`, `work.md`, `health.md`, and
`recommendation-<slug>.md` as regular files. A stray file (a working ledger,
`.DS_Store`) is named and the command exits `2` with nothing created. The
folder keeps its name, which must be a plain directory name with no hidden
prefix; a taken name gets `-2`, `-3`, etc. rather than overwriting. By default
the source folder is removed once its pages are copied: only those pages are
unlinked and the folder removed with a plain `rmdir`, so a file that appeared
since is left where it is and named. `--keep` copies and leaves the draft.

```sh
hyp report save ./hypaware-report-2026-08-01-to-2026-08-31
```

```text
saved hypaware-report-2026-08-01-to-2026-08-31 to /Users/me/.hyp/reports/hypaware-report-2026-08-01-to-2026-08-31
  list: hyp report list --local
  publish: hyp report publish hypaware-report-2026-08-01-to-2026-08-31 --kind usage-review --period 2026-08-01-to-2026-08-31
```

The period on the publish line is read off the folder name the generator
chose; a name in another shape leaves a `<period>` placeholder to fill in.

### `hyp report publish`

```text
hyp report publish <file-or-dir> --kind <kind> --period <period> [--title <title>] [--org <org>] [--remote <target>]
```

Uploads Markdown for the remote to render. The source is a path, or the name
of a saved report (`hyp report list --local`), which resolves to
`$HYP_HOME/reports/<name>` when no such path exists here. A single file must
be `.md` or `.markdown`, sent as `text/markdown`. A folder must contain `report.md` at
its root and may otherwise contain only `usage.md`, `work.md`, `health.md`,
and `recommendation-<slug>.md` (slug: lowercase `[a-z0-9][a-z0-9-]*`).
The legacy `change-<slug>.md` spelling is also accepted. HTML,
images, client assets, subdirectories, and symlinks are rejected before any
upload. The remote renders the HTML; there is no local render step in the
publish path. The remote identifies repeat uploads by content hash. `--org`
applies only to an operator credential that can name an organization.

```sh
hyp report publish hypaware-report-2026-08-01-to-2026-08-31 --kind usage-review --period 2026-08
```

### `hyp report recommend`

```text
hyp report recommend <file.md> [--title <title>] [--org <org>] [--remote <target>]
```

Publishes one recommendation page on its own, with no report around it, for
an analysis that yields a single recommendation. The file must be `.md` or
`.markdown` and is written like a `recommendation-<slug>.md` page inside a
report: the first `# ` heading is the title (`--title` overrides it) and the
bold paragraph under it is the thesis. A page with no heading and no `--title`
is refused before upload. The remote wraps the page in a report of kind
`recommendation` whose period is the publish date (UTC `YYYY-MM-DD`), mints
the `hyprec-` id, and renders it; the report appears in `hyp report list` like
any other and `hyp report get recommendation <period> <id>` serves the page.
Repeat uploads of the same content answer with the existing id (`already
published`). A remote that predates the standalone route returns `1` and says
so. Requires the publisher role, like `publish`.

```sh
hyp report recommend ./recommendation-no-python3.md
```

```text
published hyprec-0123456789abcdef (recommendation/2026-10-03/REPORT_ID)
  view: hyp report get hyprec-0123456789abcdef
```

### `hyp report list`

```text
hyp report list [--local] [--kind <kind>] [--period <period>] [--limit <n>] [--before <publishedAt>] [--recommendations] [--status <state,...>] [--org <org>] [--json] [--remote <target>]
```

Lists the newest reports visible to the selected organization, then this
machine's saved reports (`$HYP_HOME/reports`, as `hyp report save` leaves
them) in their own section, newest first by `report.md` mtime, at most 100
with the rest counted. A machine with nothing saved prints no section.
`--local` prints the saved section alone, with no remote read, and takes none
of the remote's selectors or filters. When nothing selects or filters the
remote and it cannot be read, the saved reports are still listed under a
one-line warning and the command exits `0`; `--remote`, any filter, or
`--json` keeps the failure and its exit code. `--json` prints the remote's
records alone, so `--limit` bounds the array and the last row's `publishedAt`
is the next `--before`; `--local --json` prints the saved reports, one row
each as `{ "source": "local", "name", "path", "modifiedAt" }`.

```text
saved reports (/Users/me/.hyp/reports):
  2026-09-02T10:00:00.000Z	local	hypaware-report-2026-08-01-to-2026-08-31
  publish one: hyp report publish <name> --kind <kind> --period <period>
```

An empty remote list
succeeds. Each report's recommendations follow its line, one per line, as the
minted id, its state in brackets, the `recommendation-<slug>` page the id
names, and the page's title, with its thesis on the line below. The state is
`open`, `in_progress`, `applied`, or `dismissed` as last recorded with
`hyp report mark`; a recommendation nobody has marked is `open`, which is also
what a remote that records no status lists. The page is the artifact path
`hyp report get` takes. A remote that does not read the page's opening at
publish, or a report published before it did, lists the id and page alone.
`--json` prints the records whole, `recommendations` included.

```text
  2026-08-24T09:00:00.000Z	usage-review/2026-W34	REPORT_ID	48213 bytes	Usage review
      hyprec-0123456789abcdef	[applied]	recommendation-batch-the-retries	Batch the retries
          Every retry is its own call, 506 times a month. One queue fixes it.
      hyprec-fedcba9876543210	[open]	recommendation-tenant-check
```

`--recommendations` lists the recommendations themselves, flat across
reports and newest report first, from the remote's recommendation index: id,
state, the parent report's publish time, the parent report as
`kind/period/id` (or `standalone` for one published with `hyp report
recommend`), and the title, with the thesis below. `--status <state,...>`
filters by state and implies `--recommendations`; an unknown state is refused
before any request, and an empty value (an unset shell variable) still selects
the flat form rather than falling back to the report listing. A remote that
predates the recommendation index returns `1` and says so. `--kind`,
`--period`, `--limit`, and `--before` filter on the parent report in either
form. With `--json`, the flat form prints the remote's recommendation rows
whole.

```text
  hyprec-0123456789abcdef	[in_progress]	2026-08-24T09:00:00.000Z	usage-review/2026-W34/REPORT_ID	Batch the retries
      Every retry is its own call, 506 times a month. One queue fixes it.
  hyprec-fedcba9876543210	[open]	2026-10-03T09:00:00.000Z	standalone	No python3 on the runner
```

```sh
hyp report list --kind usage-review --limit 10 --json
hyp report list --local --json
hyp report list --status open,in_progress
```

### `hyp report get`

```text
hyp report get <kind> <period> <id> [path] [--output <file>] [--org <org>] [--remote <target>]
hyp report get <rec-id> [--output <file>] [--org <org>] [--remote <target>]
```

Fetches a report's entry document or one artifact. Without `--output`, it
writes the exact bytes to standard output, including binary artifact bytes.
A `path` with no extension of its own is tried as given and then as
`.md` and `.html`, so the `recommendation-<slug>` stem `hyp report list`
prints fetches that page without spelling out how it was published.

```sh
hyp report get usage-review 2026-W34 REPORT_ID --output ./usage-review.html
```

Replace `REPORT_ID` with the ID from `hyp report list`.

Given a recommendation id instead (`hyprec-` and sixteen hex characters, the id
`hyp report list` prints under each report), it resolves the id to its report
and page and prints that page (Markdown, or HTML when the report was published
without it) with a `Citations from the report record` tail: the turns the page
cites as `evidence:N`, numbered to match, and the queries the report ran to
reach the recommendation, verbatim in `sql` blocks, and then a `Status`
section: the current state with its reason, links, who recorded it and when,
followed by the history one line per event, oldest first. A recommendation
nobody has marked reads `State: open (never marked)`. This is the read to make
from inside an AI client session when asked to fix a recommendation by id.

```sh
hyp report get hyprec-0123456789abcdef
```

```text
## Status

State: applied
Reason: Landed in hyparam/hypaware#912
Link: https://github.com/hyparam/hypaware/pull/912
By: email:dev@example.com (via cli)
At: 2026-10-03T18:21:07.000Z

History, oldest first:

- 2026-10-01T09:00:00.000Z  in_progress  by email:dev@example.com  via dashboard
- 2026-10-03T18:21:07.000Z  applied  by email:dev@example.com  via cli: Landed in hyparam/hypaware#912 https://github.com/hyparam/hypaware/pull/912
```

### `hyp report fix`

```text
hyp report fix [id] [--kind <kind>] [--period <period>] [--limit <n>] [--org <org>] [--remote <target>]
```

Starts a recorded AI client on one recommendation, in the current directory.
The id is the one `hyp report list` prints under each report. HypAware
resolves it to its report, checks the recommendation page still exists, and
starts the client with instructions to read it through
`hyp report get <rec-id>` and make the change in the current repository.
Nothing is written to disk. The client takes over the terminal and nothing is
pre-authorized: the client asks before running the read. The instructions end
by telling the client to record the outcome: `hyp report mark <rec-id> applied
--reason "<one line>" --link <PR url>` once the change is landed, or
`hyp report mark <rec-id> dismissed --reason "<why>"` if the recommendation
should not be done, with the run's `--org` and `--remote` carried along.

With no id on a terminal, it asks in two steps: first which report, newest
first, each with its publish date and how many recommendations it carries
(a report with none is not offered); then which of that report's
recommendations, labeled by the page's title and described by its thesis
when the remote lists them, else by the page name. Escape on the second
list
returns to the first. `--kind`, `--period` and `--limit` narrow which reports
are offered. Without a terminal, or with `HYP_NO_TUI=1`, the id is required
and omitting it there returns `2`. The client offer set is the recorded one
`hyp report generate` draws on, without the skill requirement: attached, or
configured with no attach marker to write, and with its CLI on `PATH`. If
more than one such client could be started, it asks which; a run given an id
that cannot prompt takes the first of that set. That pick is also time-bounded
on a terminal: unanswered for 10 seconds, it takes the first of that set and
says so on stdout (`No answer at the client prompt - starting the first
one.`), and the first keypress lifts the deadline. The deadline covers the
client pick only, not the report and recommendation listings above, which wait
for an answer. A declined pick succeeds, as does a listing that carries no
recommendations. A malformed id returns `2`. An unknown id, a recommendation
page the report no longer carries, no launchable client, or a process-start
failure returns `1`.

```sh
hyp report fix hyprec-0123456789abcdef
hyp report fix --kind usage-review
```

### `hyp report mark`

```text
hyp report mark <id> <open|in_progress|applied|dismissed> [--reason <text>] [--link <url>]... [--org <org>] [--remote <target>]
```

Records what became of a recommendation. The id is the one `hyp report list`
prints (the legacy `rec-` spelling is accepted). The state is the remote's
vocabulary: `open`, `in_progress`, `applied`, or `dismissed`; any state may
follow any other, so reopening is the same verb. `--reason` (one line, up to
2000 characters) is required for `dismissed` and optional otherwise; a
dismissal without one is refused with exit `2` before any request. `--link`
is repeatable and takes absolute `http(s)` URLs, the pull request that landed
the change most of all (up to 8; a value with a literal comma is split on it,
so percent-encode one). An empty `--link` is refused with exit `2` rather than
recorded as no link. The event is appended on the remote with `via: cli`;
nothing is kept locally. The receipt is the new state line with the reason
and links as recorded. An unknown id, or a remote that predates the status
route, returns `1` and names both readings. Requires the publisher role, like
`publish`.

```sh
hyp report mark hyprec-0123456789abcdef applied --reason "Landed in hyparam/hypaware#912" --link https://github.com/hyparam/hypaware/pull/912
hyp report mark hyprec-0123456789abcdef dismissed --reason "The retry loop was removed in 1.39"
```

```text
marked hyprec-0123456789abcdef [applied]	Batch the retries
  reason: Landed in hyparam/hypaware#912
  link: https://github.com/hyparam/hypaware/pull/912
```

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
hyp sync [instance] [--history <client>] [--yes] [--dry-run]
```

Prints a destination and exclusion plan, confirms it, then forces the selected
sink or every configured sink to export. `--dry-run` sends nothing. On a newly
enrolled machine, an interactive all-destination sync can release the
first-sync review hold early. A single-instance sync can't release that hold.

`--history <client>` is a separate mode: it previews and, after its own
confirmation, replays that client's locally retained history to the
destinations that support a replay, leaving the ordinary sink watermarks
untouched. The client must already be syncing (`hyp privacy client <client>
sync`), and a replay cannot release the first-sync review hold.

```sh
hyp sync --dry-run
```

Any sink failure returns `1`. While the first-sync review window is open, a run
that finds no configured destination returns `3`: nothing was sent, and the
window still stands. `--dry-run` and `--history` still return `0` there, as
they do with no window open: neither can end the window, so neither has an
early release to report. Avoid `--yes` until you have reviewed the plan.

## Control the current session

Available through the [recorder plugins](#plugin-owned-commands). Use
`hyp session --help` to inspect the shared controls:

```text
hyp session <subcommand> [args...]
```

```sh
hyp session --help
```

If you omit the session ID, HypAware derives it from a supported Claude Code or
Codex context. It refuses rather than guessing. An ignored session is saved
under `<HYP_HOME>/hypaware/session-ignores/` and stays ignored across recorder
and daemon restarts until you unignore it. The Cursor recorder is the
exception: it advertises the control route but still holds its set in memory,
so a restart clears Cursor's exclusions. A fork has a new session ID and needs
its own ignore. Supported routes include the gateway, Claude telemetry,
OpenCode, Pi, and Cursor. OpenClaw and Hermes do not support session opt-out;
use [directory controls](PRIVACY.md#marking-directories) for them.

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

Saves the exact session ID as ignored and adds it to every available
recorder's drop set. This stops future capture only. It doesn't delete existing rows. The Claude
telemetry listener deletes ignored-session bodies from its transient spool.

A confirmed ignore prints the exact command to delete what the session already
recorded, `hyp privacy purge --session <id>`, plus its `--local-only` form.
The default form also deletes the session's rows from configured remotes. With `--json`, the same hint is a `purge` object:
`earlier_rows` (`retained`), `command`, `command_deletes_remote` (`true`), and
`local_only_command`.

```sh
hyp session ignore
```

### `hyp session unignore`

```text
hyp session unignore [session-id] [--json]
```

Removes the saved ignore and the exact session ID from the live recorder sets.
Folder policy can still prevent recording.

```sh
hyp session unignore
```

## Manage AI clients

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
hyp client attach [client] [--dry-run] [--json]
```

Short form: `hyp attach`, which the guides use.

Starts recording this client. Writes only HypAware-managed client settings and
installs registered skills and subagents, and turns recording back on for a
client you detached. Repeating the command is a no-op. Claude Desktop has no
settings to write, so attaching it only turns its recording back on. Claude Code uses its OTEL settings
and requires version 2.1.193 or later. Gateway-backed clients require an active
gateway configuration. OpenCode installs a HypAware-owned plugin in its shared
CLI/Desktop config home and requires no gateway. `--dry-run` writes nothing.

```sh
hyp client attach claude --dry-run
```

Codex attach covers both Codex CLI and Codex Desktop because they share
`~/.codex/config.toml` and `~/.codex/sessions`.

OpenCode attach likewise covers CLI and Desktop because they share the same
XDG config home and session store.

### `hyp client detach`

```text
hyp client detach [client] [--dry-run] [--purge] [--json]
```

Short form: `hyp detach`, which the guides use.

Stops recording this client. Detach switches the client off in the local
config (`"recording": false` on its plugin entry), so the daemon's scheduled
transcript import and every other capture lane stop picking up its new
sessions, with no daemon restart. It then replays the on-disk undo marker and
removes only managed settings. Recorded history is kept; use
[`hyp privacy purge`](#hyp-privacy-purge) to delete it. `hyp status` shows a
detached client as "Not recording", with no warning. Run
`hyp client attach <client>` to record it again. If your organization's
central config requires the client, detach refuses and changes nothing.
Claude telemetry detach removes the managed OTEL settings and sweeps the
raw-body spool. For a legacy or other proxy attach, `--purge` also
removes the local interception CA and its keychain trust. `--dry-run` writes
nothing. The command doesn't ask for confirmation.

**Warning:** Use `--purge` only when you intend to remove the interception CA
and its keychain trust. You need to approve keychain changes again if you later
reattach through a proxy.

```sh
hyp client detach codex --dry-run
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
hyp client skills install [--client <name>] [--attached]
```

Replaces registered skill and subagent copies for one client, or for all
eligible clients when you omit `--client`. It requires a home directory and is
safe to repeat. `--attached` restricts installation to clients whose settings
currently contain a HypAware attach marker. With no attached clients it installs
nothing. Package updates use this mode so detached and never-attached clients
do not get skills installed.

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
credential at Anthropic or remove organization-key configuration.

```sh
hyp client claude-account logout
```

#### `hyp client claude-account status`

```text
hyp client claude-account status
```

Reports the credential mode and whether a usable credential is present. A
missing, unreadable, or unresolved credential returns `1`. A stored
subscription credential that is past its expiry still returns `0`: the command
prints the expiry timestamp without comparing it, and the next resolve attempts
a renewal from the stored refresh token, which fails if that refresh token has
also been revoked or expired.

```sh
hyp client claude-account status
```

### Claude Desktop commands

Plugin: `@hypaware/claude-desktop`.

Claude Desktop capture is supported on macOS and uses local transcripts by
default. Select Claude Desktop in `hyp setup`; the daemon reruns the Claude history provider every
five minutes. This needs no Claude account credential and makes no changes to
the Desktop app.

Selecting Claude Desktop also enables Claude Code capture: the capture set
below includes `@hypaware/claude`, the shared transcript reader, so a
Desktop-only selection imports existing Claude Code CLI history from
`~/.claude/projects` under `client_name = 'claude'` and may attach Claude
Code by updating `~/.claude/settings.json`. Set `attach.on_join: false` on
the `@hypaware/claude` entry to withhold the attach; `backfill.on_join:
false` (below) withholds the history import.

The resulting config has this capture set:

```json
{
  "plugins": [
    { "name": "@hypaware/ai-gateway", "config": { "upstreams": [] } },
    { "name": "@hypaware/claude" },
    { "name": "@hypaware/claude-desktop" }
  ]
}
```

Tune the timer in the Claude plugin config if needed:

```json
{ "name": "@hypaware/claude", "config": {
  "backfill": { "sweep_cron": "*/10 * * * *" }
} }
```

The same block's `window_days`, if set, bounds this scheduled rerun as well
as the join-time import: see "Scheduled recovery sweeps and
`backfill.window_days`" below.

To turn the schedule off, set the same block's `on_join` to false. That is the
opt-out from automatic history import; it withholds both the scheduled rerun
and the join-time import; `sweep_cron` chooses a cadence
and has no "never" value.

```json
{ "name": "@hypaware/claude", "config": {
  "backfill": { "on_join": false }
} }
```

The subcommands below operate the older managed third-party-inference route.
They are optional experiments, not prerequisites for transcript capture. They
require `@hypaware/claude-account`; without that capability they return a
repair message while the scheduled transcript imports continue normally.

```text
hyp client claude-desktop <subcommand> [args...]
```

#### `hyp client claude-desktop install`

```text
hyp client claude-desktop install [--yes] [--print-commands]
```

Optionally runs the attended macOS live-route setup: explains the changes, signs in if needed,
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
ID. A missing helper returns `1`, and so does a generated helper whose baked
interpreter or CLI path has rotted away, which prints `STALE` and names the
re-run. This command doesn't verify the installed property list.

```sh
hyp client claude-desktop status
```

#### `hyp client claude-desktop verify`

```text
hyp client claude-desktop verify
```

Checks that the managed property list is present and current, that the
credential wrapper it names is present and still runnable, and that stale
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

## Import past client history

Use backfill to import local history, list providers, or preview a scan:

```text
hyp backfill [provider...] [flags]
hyp backfill list [--json]
```

```sh
hyp backfill --help
```

`hyp client history providers` remains a compatibility alias of `hyp backfill list`.
Preview a scan with `hyp backfill <provider> --dry-run`.

### `hyp backfill`

```text
hyp backfill [provider...] [--since <iso>] [--until <iso>] [--retention-days <n>] [--dry-run] [--json]
```

Scans selected providers, materializes records into live datasets, appends
rows, and flushes the cache. Provider failures don't stop sibling providers.
`--dry-run` runs the same full scan and projection and writes no row, so it
reports what an import would take at nearly the cost of one: only
materialization, the row write, and the cache flush are skipped.

Choose providers shown by `hyp backfill list`. The example below requires
both Claude and Codex capture to be enabled.

```sh
hyp backfill claude codex --since 2026-08-01T00:00:00Z --dry-run
```

### `hyp backfill list`

```text
hyp backfill list [--json]
```

Lists every registered backfill provider, not only providers selected as
configuration defaults.

```sh
hyp backfill list --json
```

### Scheduled recovery sweeps and `backfill.window_days`

Some adapters import history on a schedule to recover sessions missed by live
capture:

| Plugin | Default interval | Does `backfill.on_join: false` stop scheduled recovery? |
| --- | --- | --- |
| `@hypaware/codex` (transcript mode) | One minute | No (it is Codex's only capture lane) |
| `@hypaware/pi` | Five minutes | Yes |
| `@hypaware/claude` (also Claude Desktop) | Five minutes | Yes |
| `@hypaware/cursor` | Five minutes | Yes |
| `@hypaware/openclaw` | Five minutes | No |

`hyp client detach <client>` stops every client's scheduled recovery, whatever
`on_join` says; `hyp client attach <client>` resumes it.

A positive `backfill.window_days` bounds both the join-time import and scheduled
recovery. Older sessions remain on disk but are not imported. Widening the
window makes older history eligible on the next run.

```json
{ "name": "@hypaware/openclaw", "config": {
  "backfill": { "window_days": 30 }
} }
```

Without an explicit window, recovery uses `query.cache.retention.default_days`,
or 90 days if that setting is absent. A retention value of `0` means no age
limit. See [retention configuration](CONFIGURATION.md#set-local-retention).

`sweep_cron` changes the recovery cadence. OpenClaw schedules recovery even when
`backfill.on_join` is false; bound it with `window_days`, or run
`hyp client detach openclaw` to stop its capture.

## Collect GitHub activity

Plugin: `@hypaware/github`. Capture writes structural repository activity to
`github_events` and projects it into the activity graph. See
[clients and history](CLIENTS.md#collect-github-activity) for the workflow.

### `hyp github login`

```text
hyp github login [--no-browser]
```

Signs in with a GitHub device code. `--no-browser` prints the code and URL without
opening a browser. GitHub's `repo` scope includes private repositories and write
permissions; HypAware only reads. A configured environment token continues to
override the saved OAuth credential. Canceling returns `130`; login failure
returns `1`.

### `hyp github logout`

```text
hyp github logout
```

Removes locally saved OAuth tokens. It does not remove an environment override
or credentials available through `gh`.

### `hyp github status`

```text
hyp github status
```

Checks the effective credential with GitHub and reports its source and account.
Authentication failure returns `1`.

### `hyp github backfill`

```text
hyp github backfill [owner/repo ...]
```

Imports history for eligible named repositories or, without names, the configured
selection. Naming a repository allows a one-time import without recorded session
evidence, but repository exclusions still apply. Bounded work can continue on
later capture runs. Capture or graph-projection failures return `1`.

### `hyp github sync`

```text
hyp github sync
```

Runs one poll immediately, including graph projection. It does not perform the
full historical import. Capture or projection failures return `1`.

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
delete rows. An `ignore` marking prints a line naming
`hyp privacy purge --ignored`, which deletes what was already recorded in
every ignored folder.

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
hyp privacy ignore [path]
```

Writes a shareable `.hypignore` file in an existing directory at the explicit
path. With no path, uses
the repository root, or the current directory when outside a repository.
Use `hyp privacy set <path> sync|local-only|ignore` for machine-local markings
and `hyp privacy show [path]` to report without writing. The receipt names
`hyp privacy purge --ignored` to delete what was already recorded in ignored
folders.

```sh
hyp privacy ignore ./customer-data
```

### `hyp privacy unignore`

```text
hyp privacy unignore [path]
```

Removes the nearest governing `.hypignore`. Use `hyp privacy unset <path>`
to remove machine-local markings. It does not remove cached rows.

```sh
hyp privacy unignore ./customer-data
```

### `hyp privacy client`

```text
hyp privacy client [<name>] [sync|local-only] [--json]
```

Lists or changes per-client export policy. `local-only` withholds future rows
from remote sync. Returning to `sync` affects future rows only: the policy
flip itself syncs nothing that was withheld. To sync that retained history,
run the separate, separately confirmed `hyp sync --history <client>`. A client
required by central configuration can't opt out.

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
hyp privacy purge <path> | --session <id> [--remote <target> | --local-only] | --ignored | --all [--yes] [--json]
```

**Warning:** This operation permanently deletes matching rows from this
machine's local cache. Select exactly one target. Every form also sweeps the
Claude raw-body spool so pending bodies can't recreate deleted rows. A terminal
prompts for confirmation; a non-interactive call requires `--yes`.

A `--session` purge also deletes that session's rows from every configured or
signed-in remote and every enrolled server, and excludes the session from
future recording. `--remote <target>` limits the remote scope to one server;
`--local-only` skips servers. The two flags are mutually exclusive and apply
only with `--session`. Remote deletion uses your login credential and requires
the session owner or an organization admin. Physical files remain until
compaction, and copies in published reports aren't covered.

The `<path>`, `--ignored`, and `--all` targets purge locally only. They never
contact a sink or HypAware Cloud and can't retract exported copies.

```sh
hyp privacy purge --session SESSION_ID
hyp privacy purge --session SESSION_ID --local-only
```

Replace `SESSION_ID` with the reviewed session ID. Avoid `--yes` during manual
work. A remote failure returns a nonzero exit status; repeat the command to
finish an incomplete purge.

## Connect to or leave HypAware Cloud

### `hyp join`

```text
hyp join <url> [token] [--token-file <path>] [--bin <path>] [--no-daemon] [--force]
```

Validates the URL syntax and requires a nonempty token, writes a
permission-restricted central seed layer, and installs or restarts the daemon.
It does not authenticate with the server. Authentication and the full organization
configuration arrive when the daemon connects. Local configuration and history remain.
`--no-daemon` writes only the seed. Start `hyp daemon run` under your own
supervisor that relaunches it on exit code `75` (see [`hyp daemon run`](#hyp-daemon-run)), or install the service separately where a service manager exists. `--force` allows the existing CLI path if global
installation fails.

```sh
hyp join https://api.hypaware.ai --token-file ./enrollment-token
```

Prefer `--token-file` or standard input. A positional token can appear in shell
history and process listings.

### `hyp leave`

```text
hyp leave
```

Removes the central layer, identity, and sync credential, restarts the
daemon, and reverses organization-driven client attaches. It keeps the local
configuration, daemon service, recordings, and remote query sign-ins. Use
`hyp remote remove <name>` to remove a query target and its stored sign-in
separately. Partial failure
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
hyp daemon install [--config <path>] [--bin <path>] [--force] [--dry-run [--json]]
```

Installs the persistent launchd or systemd user service. When invoked from an
ephemeral `npx` path, it installs a durable global package before it writes the
service. `--force` allows the existing CLI path if that global installation
fails; removing that directory later can break capture. `--dry-run` renders
the exact service definition without changing the machine; add `--json` for
structured plan output.

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
hyp daemon run [--config <path>]
```

Runs the daemon in the current terminal until it receives a stop signal.
`daemon start` starts the installed service.

When the daemon applies a new organization configuration or a plugin change,
it exits with code `75` to be relaunched on the new code. An installed service
relaunches automatically. In the foreground, nothing does, so whatever starts
`hyp daemon run` has to run it again on `75`. This loop does that and exits with
the daemon's own status otherwise, so a supervisor still sees a failed start:

```sh
rc=75
while [ "$rc" -eq 75 ]; do hyp daemon run && rc=0 || rc=$?; done
exit "$rc"
```

The first daemon start after `hyp join` or `hyp remote login --no-daemon`
usually takes this path, because that is when the organization configuration
arrives.

```sh
hyp daemon run
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
hyp daemon restart [--processing]
```

Restarts an installed service. If no service is installed, it stops a
foreground daemon and tells you how to relaunch or install it.

`--processing` replaces only the supervised processing daemon (recording,
sinks, backfill and maintenance) and leaves the gateway listener, its sockets
and its in-flight streams alone. It asks the running gateway to bounce its
child and returns as soon as the request is written; the gateway allows the
child four seconds to stop before killing it. With no gateway supervising a
processing daemon it prints that and returns `1`.

```sh
hyp daemon restart
hyp daemon restart --processing
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
hyp config validate [file]
```

Loads the effective configuration or an explicit file and cross-validates
plugin, dataset, source, and sink contracts. It is read-only. Validation
failures return `1` with detailed pointers.

```sh
hyp config validate ./hypaware-config.json
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
hyp sink maintain --dry-run
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

Prints version, source, and lock details for one installed plugin, including
its update state when a check has run. An install under a name this package
bundles also gets a `shadowed:` line: boot selects the bundled copy, so that
install never runs, and the line names the `hyp plugin remove` that clears it.
Answers for a bundled plugin too: those have no install record, so it prints
the version and root directory from the manifest instead. A name that is
neither installed nor bundled exits 1.

```sh
hyp plugin info @example/hypaware-plugin-widget
hyp plugin info @hypaware/claude
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
configuration. It doesn't authenticate. Give the server's base URL; HypAware
appends `/v1/mcp` itself, and a URL that already ends in `/v1/mcp` is used as
given.

```sh
hyp remote add team https://hyp.example.com
```

### `hyp remote login`

```text
hyp remote login [name] [--token-file <path>] [--org <org>] [--host <label>] [--browser] [--no-browser] [--no-forward] [--no-daemon] [--force]
```

Signs in through a browser by default, or reads a static token from
`--token-file` or standard input. It stores the credential with mode `0600`.
Omit `name` to sign in to the default target. Unless you set `--no-forward`,
login can enroll this machine, set up sync, and install the daemon.

- `--org <org>` selects an organization.
- `--browser` forces browser sign-in when stdin is piped, unless an explicit
  `--token-file` is supplied.
- `--no-browser` prints the sign-in URL instead of opening a browser.
- `--host <label>` overrides the host label this machine syncs under, which defaults to the
  hostname.
- `--no-forward` signs in for queries only, with no organization enrollment.
- `--no-daemon` sets up sync without installing the service.
- `--force` allows the existing CLI path if global installation fails.

```sh
hyp remote login
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

For the complete join, capture, and flush workflow, see
[CI and headless deployment](TEAM_SETUP.md#ci-and-headless-deployment).

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

Removes the named target and its locally stored token. It doesn't leave
HypAware Cloud enrollment; use `hyp leave` for that.

```sh
hyp remote remove team
```

## Serve MCP tools

### `hyp mcp serve`

```text
hyp mcp serve [--remote <target> [--org <label|*>]]
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
hyp graph project [--source <dataset>] [--refresh] [--dry-run]
```

Reads registered projection contracts and writes the derived `node` and `edge`
datasets. It is idempotent, and existing nodes and edges keep their properties
unless you pass `--refresh`, which replaces matching rows with what the
recordings show now. `--source` limits projection to one source dataset, and
`--dry-run` writes nothing. An empty successful result means that no
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

Requires active `@hypaware/context-graph-enrich`, `@hypaware/context-graph`,
and `@hypaware/vector-search`, plus configured embedder and completion
providers. Bundled providers include `@hypaware/embedder-openai` and
`@hypaware/completion-anthropic` or `@hypaware/completion-openai`.
Adding only the enrichment plugin is not sufficient.

The `hyp enrichment` group lists its operations:

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

Analyzes settled sessions once and writes proposed knowledge for review.

```sh
hyp enrichment propose
```

### `hyp enrichment curate`

```text
hyp enrichment curate
```

Reviews pending proposals once. It can call the configured completion provider
and record which proposals were accepted or rejected, along with accepted knowledge.

```sh
hyp enrichment curate
```

### `hyp enrichment backfill`

```text
hyp enrichment backfill [--propose-only|--curate-only] [--since <YYYY-MM-DD>] [--dry-run]
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

## Update HypAware

### `hyp update`

```text
hyp update
```

Checks the npm registry and installs a newer HypAware release into a global
installation, then restarts the installed daemon. It also repairs a daemon
still running an older version than the package on disk. Foreground daemons
need a separate relaunch; source checkouts and npx-cache copies do not
self-update. Failures return `1` with a reason and repair guidance.

See [updating and recovery](CLI.md#update-hypaware).

## Control product telemetry

### `hyp telemetry`

```text
hyp telemetry [status|preview|off|enable local|enable organization]
```

Product telemetry is automatic for enrolled organizations and defaults off on
standalone installations. `status` reports consent, destination, and queue
state; `preview` prints the next serialized batch or `null`. `enable local`
retains an allowlisted preview queue without delivery. `enable organization`
requires an eligible HypAware Cloud enrollment. `off` removes pending copies
and stops collection, but cannot retract records already accepted remotely.

See [product telemetry](PRIVACY.md#product-telemetry) for daemon restart requirements,
what is collected, and delivery limits.

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

## Use canonical command names

Use the canonical names below in new scripts and documentation. Other spellings
remain compatibility aliases and use the same runners:

| Compatibility spelling | Canonical spelling |
| --- | --- |
| `hyp init` | `hyp setup` |
| `hyp unattach` | `hyp detach` |
| `hyp client history providers` | `hyp backfill list` |
| `hyp skills install` | `hyp client skills install` |
| `hyp policy ...`, `hyp ignore`, `hyp unignore`, `hyp purge` | `hyp privacy ...` |
| `hyp query status`, `hyp query refresh`, `hyp query maintain` | `hyp cache status`, `hyp cache refresh`, `hyp cache maintain` |
| `hyp graph neighbors` | `hyp query graph neighbors` |
| `hyp vector search` | `hyp query vector search` |
| `hyp plugin new`, `hyp plugin doctor` | `hyp dev plugin new`, `hyp dev plugin doctor` |
| `hyp mcp` | `hyp mcp serve` |
| `hyp enrich ...` | `hyp enrichment ...` |

`hyp attach` and `hyp detach` are the preferred short forms of `hyp client attach`
and `hyp client detach`; both spellings run the same command.

Plugin-owned aliases are available only when the owning plugin is active.
