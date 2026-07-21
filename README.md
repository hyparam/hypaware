# HypAware

Modular logs and telemetry collector. Plugin-kernel architecture.

HypAware captures conversations and traffic from local AI clients (Claude
Code, Codex), raw Anthropic / OpenAI API traffic, and OpenTelemetry
logs / traces / metrics into a local query cache and optional Parquet
exports.

There are two ways to run it:

- **Solo, fully local.** No central server, no account. Everything stays in
  a local query cache on your machine. Start with [`npx hypaware`](#quickstart-solo-fully-local).
- **With your team.** Each machine signs into your organization on the
  central server with one command, [`hyp remote login`](#set-up-for-your-team-hyp-remote-login),
  and forwards its recordings there so usage, spend, and activity can be
  queried and reported across the whole team.

> Part of **[HypStack](https://hypstack.ai/)**, an open-source stack for AI observability.

**Contents:**
[Requirements](#requirements) ·
[Quickstart](#quickstart-solo-fully-local) ·
[Team setup](#set-up-for-your-team-hyp-remote-login) ·
[Files](#files-and-directories) ·
[Querying](#querying-captured-data) ·
[Activity graph](#building-and-querying-the-activity-graph) ·
[Clients](#attaching-and-detaching-ai-clients) ·
[Privacy controls](#controlling-what-is-recorded-and-forwarded) ·
[Daemon](#daemon-lifecycle) ·
[Troubleshooting](#troubleshooting) ·
[Uninstalling](#uninstalling) ·
[Project documents](#project-documents)

## Requirements

- Node.js >= 22.12
- macOS (launchd) or Linux (systemd `--user`) for the persistent daemon

## Quickstart (solo, fully local)

```sh
npx hypaware
```

When run through `npx`, the walkthrough also installs a durable global copy
of the CLI (`npm install -g hypaware`) so the daemon and the `hyp` command
outlive the `npx` cache. Every command below is available as both `hyp` and
`hypaware`.

On a TTY this launches the interactive walkthrough:

1. Pick the **sources** to capture. Any subset of:
   - Claude Code conversations (`claude`)
   - Codex conversations (`codex`)
   - Raw Anthropic API traffic (`raw-anthropic`)
   - Raw OpenAI API traffic (`raw-openai`)
   - OTEL logs / traces / metrics (`otel`)
2. Pick an **export** strategy: keep the local query cache only, write
   Parquet files under `<HYP_HOME>/exports`, or configure later.
3. Pick a **retention window** (default `30` days).
4. HypAware composes a minimal config with only the bundled plugins it
   needs, writes it to `<HYP_HOME>/hypaware-config.json`, installs the
   persistent daemon (launchd on macOS, systemd `--user` on Linux),
   attaches the selected clients, and starts capturing.
5. The walkthrough finishes by printing the config path, daemon status,
   per-client attach results, and a first `hyp query` command to run.

For unattended installs (CI, scripted bootstraps, dotfiles) use the
non-interactive flags:

```sh
hyp init --yes \
  --source claude --source otel \
  --client claude \
  --export local-parquet \
  --retention-days 30
```

Other init flags:

| Flag                       | Meaning                                                 |
|----------------------------|---------------------------------------------------------|
| `--yes` / `-y`             | Accept defaults; do not prompt                          |
| `--no-daemon`              | Skip daemon install and restart                         |
| `--dry-run`                | Render the config + planned actions, write nothing      |
| `--client claude\|codex`   | Attach a client (repeatable)                            |
| `--source <id>`            | Add a capture source (repeatable)                       |
| `--export <choice>`        | `keep-local`, `local-parquet`, or `configure-later`     |
| `--retention-days <N>`     | Override the default 30-day retention window            |
| `--from-file <config.json>`| Skip the picker and load a known-good config            |
| `--bin <path>`             | Override the binary path the daemon installer uses      |

## Set up for your team (`hyp remote login`)

If your organization is set up on the central server, enrolling a machine is
one command:

```sh
npx hypaware remote login
```

This opens a browser sign-in. Your organization is resolved from your work
email domain, and the machine enrolls itself: it provisions the forwarding
sink, stores a per-machine credential (mode `0600`, never in shell history),
installs the persistent daemon, and starts capturing and forwarding. No
bootstrap token, no URL to copy, no hand-edited config.

The same sign-in also unlocks remote queries, so you can ask questions
across the whole team's recordings, not just this machine's:

```sh
hyp query sql "select count(*) from ai_gateway_messages" --remote
```

**Privacy review before anything ships.** Nothing is forwarded immediately.
The first sync (which includes backfilled history) waits until at least
11:59pm local time on the day you enroll, and the login prints the exact
deadline. Before then, open Claude or Codex and run the `hypaware-privacy`
skill to review what will ship, mark directories ignore / local-only / sync,
and purge anything sensitive.

Useful login flags: `--no-forward` signs in for remote queries only (no
enrollment), `--no-browser` prints the sign-in URL instead of opening one,
`--token-file <path>` / stdin supply a static token, and `--host <label>`
overrides the host label the server shows for this machine.

> **Want this for your team?** We host organizations on the central server.
> [Get in touch](https://hypstack.ai/) and we will set one up for your email
> domain; after that, everyone on the team onboards with the single
> `hyp remote login` above.

For the full rollout story (fleet tokens, managed config, Claude Desktop
capture, verifying machines) see the
[team setup guide](./docs/TEAM_SETUP.md); for what enrollment means for
each person's data, see
[what HypAware records and how to control it](./docs/PRIVACY.md).

### Unattended enrollment (`hyp join`)

For scripted rollouts (MDM, dotfiles, CI images) where no browser is
available, `hyp join` enrolls a host with a fleet policy token instead of an
interactive sign-in:

```sh
hyp join <url> [token]
hyp join <url> --token-file <path>     # read the token from a file (recommended for MDM)
echo "<token>" | hyp join <url>        # or from stdin
hyp join <url> <token> --no-daemon     # write the seed only, skip daemon install
```

It writes a central-enrollment config (mode `0600`) to a dedicated layer under
`config-control/`, never to your local `hypaware-config.json`, so joining
augments an existing install rather than replacing it, then installs and starts
the daemon (unless `--no-daemon` is passed).

The policy token is a multi-use fleet-wide credential. Prefer `--token-file`
or stdin over a positional argument, which would otherwise land in shell
history and process listings. Other flags: `--bin <path>` overrides the binary
the daemon installer records, and `--no-daemon` writes the seed without
installing or restarting the daemon.

## Files and directories

| Path                                           | Contents                                                 |
|------------------------------------------------|----------------------------------------------------------|
| `<HYP_HOME>/hypaware-config.json`              | Active config (rewritten by `hyp init`)                   |
| `<HYP_HOME>/hypaware/`                         | Kernel state root                                         |
| `<HYP_HOME>/hypaware/plugins/<name>/`          | Per-plugin state                                          |
| `<HYP_HOME>/hypaware/cache/`                   | Local query cache (Iceberg-backed)                        |
| `<HYP_HOME>/hypaware/sinks/<name>/outbox/`     | Failed export rows awaiting retry                         |
| `<HYP_HOME>/hypaware/dev-telemetry/`           | Daemon self-telemetry (logs, traces, metrics)             |
| `<HYP_HOME>/hypaware/logs/daemon.{out,err}.log`| Daemon stdout / stderr (launchd / systemd)                |
| `<HYP_HOME>/exports/`                          | Local Parquet exports (when the local-fs sink is enabled) |

`HYP_HOME` defaults to `~/.hyp`. Override it by exporting `HYP_HOME=...`
before invoking the CLI or the daemon.

## Querying captured data

```sh
hyp query sql "select count(*) from ai_gateway_messages"
hyp query sql "select count(*) from traces"
hyp query sql "select count(*) from logs"
```

Use `hyp query schema <dataset>` to see the columns available on each
dataset, and `hyp query status` to inspect cache freshness per dataset.

## Building and querying the activity graph

Alongside the row datasets, HypAware can project captured activity into a
node/edge **activity graph**: which sessions ran in which app, against which
model, using which tools, touching which files. The projection is
deterministic (exact-key matching, no models), and the `context-graph` plugins
are active by default.

Projection is a manual, cheap-to-rerun step. Build or refresh the graph from
what has been captured, then walk it from a seed node:

```sh
hyp graph project                       # project captured data into the node/edge graph
hyp graph compact                       # merge duplicate rows (optional housekeeping)
hyp graph neighbors <node> --depth 2    # walk out from a seed node
```

`hyp graph neighbors` takes a `node_id`, natural key, or label as the seed,
plus `--depth`, `--direction out|in|both`, `--type <node_type>`, `--edge-type
<type>` (repeatable), and `--limit`. The graph is also plain data: the `node`
and `edge` datasets are queryable through `hyp query sql` like any other
dataset.

Claude Code and Codex additionally get a `hypaware-graph` skill (and a
`graph_neighbors` tool) so an assistant can project and walk the graph on your
behalf.

## Attaching and detaching AI clients

Attach a single client (idempotent: running twice is a no-op):

```sh
hyp attach claude
hyp attach codex
# Equivalent flag form:
hyp attach --client claude
hyp attach --client codex
```

Detach (removes only HypAware-managed settings):

```sh
hyp detach claude
hyp detach codex
# Equivalent aliases:
hyp detach --client claude
hyp detach --client codex
hyp unattach claude
hyp unattach codex
```

Both commands support `--dry-run` and `--json` for inspection and
scripting. Claude writes only HypAware-related keys to
`~/.claude/settings.json`; Codex writes a `hypaware` provider entry to
`~/.codex/config.toml`. Unrelated keys in either file are preserved.

## Controlling what is recorded and forwarded

Every directory subtree resolves to a usage class, evaluated gitignore-style
from an exchange's working directory: `sync` (recorded, forwarded to the
team server if enrolled; the default), `local-only` (recorded, never
forwarded), or `ignore` (never recorded; the live LLM call is untouched,
only persistence is suppressed). When multiple markings apply, the most
restrictive wins.

There are two ways to mark a subtree:

```sh
hyp ignore [path]                     # write a committable .hypignore dotfile (travels with the repo)
hyp unignore [path]                   # remove it, re-enabling recording

hyp policy set <path> ignore          # same effect, stored machine-local (no dotfile in the repo)
hyp policy set <path> local-only      # recorded but never forwarded
hyp policy set <path> sync            # explicitly synced, not asked again
hyp policy show [path]                # which class governs, and from which source
hyp policy list                       # every machine-local entry
hyp policy unset <path> [class]       # back to the implicit default
```

Markings are prospective only: rows captured before a marking existed stay
in the cache. Delete those with the separate destructive step:

```sh
hyp purge <path> | --session <id> | --ignored | --all   # delete already-cached rows (prompts; --yes to skip)
```

To pause recording for just the current Claude or Codex session (in-memory,
reversible) use the `hypaware-ignore` and `hypaware-unignore` skills.

The full model, including what enrollment forwards and the first-sync
privacy review, is in
[what HypAware records and how to control it](./docs/PRIVACY.md). One
caveat worth repeating: directory markings need a working directory, which
only the Claude and Codex pathways supply, so they are a no-op for the
`raw-anthropic` / `raw-openai` proxy and OTEL sources.

## Daemon lifecycle

```sh
hyp daemon install      # launchd LaunchAgent (macOS) or systemd --user unit (Linux)
hyp daemon start        # ensure the service is started
hyp daemon status       # health snapshot
hyp daemon restart      # bounce after a config change
hyp daemon stop         # signal the running daemon to shut down
hyp daemon uninstall    # remove the service file (config + recordings are kept)
```

`hyp daemon install --dry-run --json` prints the rendered plist or unit
content and target paths without touching the filesystem, useful for
verifying what `hyp init` will install.

## Troubleshooting

`hyp status` is the entry point for any "is HypAware working?" question.
It prints the active config path, daemon install/run state, active
plugins, source and sink rows, per-client attach state, retention
window, cache size, and a recent-error count. Pass `--json` for the
stable machine-readable shape that smokes and support tools rely on:

```sh
hyp status
hyp status --json
```

When something is wrong, `hyp status` surfaces a `diagnostics:` section
with one row per finding. Each row carries a `kind` (a stable
machine-readable identifier) and one or more `repair:` lines you can
run directly. The common Phase 8 conditions:

| kind                                  | meaning                                                                            | repair                                                                  |
|---------------------------------------|------------------------------------------------------------------------------------|-------------------------------------------------------------------------|
| `config_missing`                      | no `~/.hyp/hypaware-config.json` was found                                         | `hyp init` or `hyp init --from-file <config.json>`                       |
| `config_invalid`                      | the loaded config failed schema / cross-plugin validation                          | `hyp init --from-file <config.json>`                                     |
| `client_without_gateway`              | a client plugin (Claude / Codex) is enabled but `@hypaware/ai-gateway` is not      | re-run `hyp init`, then `hyp attach --client <name>`                     |
| `gateway_missing_anthropic_upstream`  | `@hypaware/claude` enabled but no Anthropic upstream is registered on the gateway  | re-run `hyp init` and pick the Anthropic upstream                        |
| `gateway_missing_openai_upstream`     | `@hypaware/codex` enabled but no OpenAI upstream is registered                     | re-run `hyp init` and pick the OpenAI upstream                           |
| `sink_missing_encoder`                | a local-fs sink is configured but no encoder plugin is enabled                     | re-run `hyp init` and pick "local Parquet export"                        |
| `client_attach_missing`               | a client plugin is enabled but its settings file shows no HypAware marker          | `hyp attach --client claude` or `hyp attach --client codex`              |
| `daemon_binary_missing`               | the daemon installer references a binary that no longer exists on disk             | `hyp daemon install`                                                     |
| `daemon_loaded_no_pid`                | the daemon service file is installed but launchd / systemd is not loading it       | `hyp daemon restart`                                                     |
| `recent_errors`                       | the local telemetry directory has recent error log entries                         | inspect `~/.hyp/hypaware/dev-telemetry`, then `hyp daemon restart`       |

Useful follow-on commands when a diagnostic fires:

- `hyp daemon restart`: bounce the persistent daemon
- `hyp daemon install`: re-install the launchd / systemd unit
- `hyp attach --client claude` / `hyp attach --client codex`: wire a
  selected client into the local gateway
- `hyp init --from-file <path>`: rebuild the config from a known-good
  file without re-running the interactive picker

## Uninstalling

To remove HypAware from a machine completely:

```sh
hyp leave                     # only if enrolled with a team server: stop forwarding, drop the credential
hyp detach claude             # restore each attached client's own settings
hyp detach codex
hyp daemon uninstall          # remove the launchd / systemd service file
npm uninstall -g hypaware     # remove the CLI
rm -rf ~/.hyp                 # delete all local recordings, config, and state
```

The first four steps are non-destructive and reversible; deleting `~/.hyp`
permanently removes every local recording. Note that copies already
forwarded to a team server or exported to Parquet are not affected; see
[docs/PRIVACY.md](./docs/PRIVACY.md).

## Project documents

User-facing guides live under [`docs/`](./docs/):

- [`docs/TEAM_SETUP.md`](./docs/TEAM_SETUP.md): rolling HypAware out across a team
- [`docs/PRIVACY.md`](./docs/PRIVACY.md): what HypAware records and how to control it
- [`docs/PLUGIN_AUTHORING.md`](./docs/PLUGIN_AUTHORING.md): how to write a plugin (`hyp plugin new` / `hyp plugin doctor`)

Contributor material (repository layout, release checklist, test model)
lives in [`AGENTS.md`](./AGENTS.md).

Design rationale lives in numbered **LLP documents** under [`llp/`](./llp/)
(Linked Literate Programming). Start here:

- [`llp/0000-hypaware.explainer.md`](./llp/0000-hypaware.explainer.md): root overview and subsystem map
- [`llp/0002-v1-scope.decision.md`](./llp/0002-v1-scope.decision.md): what actually shipped in V1
- [`llp/0001-adopting-llp.plan.md`](./llp/0001-adopting-llp.plan.md): how this docs system was set up

The former monolithic docs (`hypaware-design.md`, `finish-v1.md`,
`hypaware-implementation-plan.md`) were decomposed into the LLP corpus and are
preserved under [`llp/tombstones/`](./llp/tombstones/). Public plugin
interfaces are declared in
[`hypaware-plugin-kernel-types.d.ts`](./hypaware-plugin-kernel-types.d.ts).
