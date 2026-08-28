# Use the HypAware CLI

Use the HypAware command-line interface (CLI) to set up capture, inspect your
installation, explore recorded data, and control what leaves your machine.
This guide uses `hyp`, the short binary name. You can use `hypaware` instead;
both names run the same binary.

For the syntax and behavior of every command, see the
[HypAware CLI command reference](./CLI_REFERENCE.md).

## Requirements

Before you install HypAware, make sure that your machine meets these
requirements:

- Node.js 22.12 or later.
- macOS with launchd, or Linux with a systemd user service, if you want the
  persistent daemon.
- An interactive terminal for the guided setup.

## Install HypAware for the first time

To start the guided setup, use `npx`:

```sh
npx hypaware
```

The setup asks what you want to record and where you want to save it. It then
writes the configuration, installs a durable global CLI, installs the daemon,
attaches the clients you selected, and imports supported client history.

If a valid configuration already exists, `hyp setup` shows the current setup
and lets you reconfigure it, open full status, or quit. Quit is the default, so
pressing Enter doesn't change a working installation.

For an unattended local installation, specify every important choice:

```sh
hyp setup --yes \
    --source claude \
    --source otel \
    --client claude \
    --export local-parquet \
    --retention-days 90
```

Use `--dry-run` first if you want to inspect the configuration and planned
actions. If a configuration already exists, add `--force` to replace it.
HypAware backs up the existing configuration before replacement.

## Follow the command journey

Start with the command that matches your task:

- Getting started: use `hyp setup` to configure HypAware and `hyp status` to
  check the result.
- Explore and share: use `hyp ask`, `hyp query`, and `hyp report` to work with
  recorded data.
- Control capture and movement: use `hyp client`, `hyp privacy`, `hyp session`,
  `hyp join`, `hyp leave`, and `hyp sync`.
- Operate the installation: use `hyp daemon`, `hyp config`, `hyp cache`,
  `hyp sink`, `hyp plugin`, `hyp remote`, `hyp mcp`, `hyp graph`,
  `hyp vector`, `hyp enrichment`, `hyp version`, and `hyp dev`.

Use `hyp --help` to see the commands available for your current configuration.
Use group help to discover the next level:

```sh
hyp client --help
hyp privacy --help
hyp query --help
```

### Plugin command availability

Some commands belong to plugins. A plugin-owned command appears in help and
can run only when that plugin is active in the effective configuration. For
example, `hyp query graph neighbors` belongs to `@hypaware/context-graph`, and
`hyp query vector search` belongs to `@hypaware/vector-search`.

If an inactive plugin owns the command you enter, HypAware names the plugin and
prints a repair instruction. Top-level help reads plugin manifests without
starting plugin listeners or sources.

## Check capture and Claude telemetry

Use overall status as the first troubleshooting step:

```sh
hyp status
```

Use the stable JSON form in scripts:

```sh
hyp status --json
```

For a client-focused view, use:

```sh
hyp client status
hyp client status claude
```

Claude Code capture uses Claude's OpenTelemetry (OTEL) export instead of a
proxy. `hyp client attach claude` writes a reversible `env` block in
`~/.claude/settings.json`. New Claude Code processes send telemetry events to
the daemon's loopback listener and write transient raw API bodies to
`~/.hyp/spool/claude-bodies`. The listener projects those bodies and deletes
them. The spool is owner-only and bounded.

This attach mode doesn't change `ANTHROPIC_BASE_URL`, install a certificate
authority (CA), or require a terminal restart. Claude Code 2.1.193 or later is
required. Version 2.1.214 or later provides the complete tool-decision detail.
If the installed version is too old, attach refuses to change the existing
client settings and tells you to update Claude Code.

Status reports the configured telemetry endpoint, live listener endpoint,
endpoint drift, recent telemetry activity, transcript activity, and capture
health. If the endpoints differ, reattach Claude and restart the daemon:

```sh
hyp client attach claude
hyp daemon restart
hyp client status claude
```

If telemetry is quiet while Claude transcripts are active, check the following
items in order:

1. Confirm that Claude Code meets the minimum version.
2. Confirm that `hyp client status claude` reports the client as attached.
3. Restart the daemon with `hyp daemon restart`.
4. Start a new Claude Code process so it reads the managed `env` block.
5. Run `hyp status` again and follow any `repair:` lines.

Session controls contact every live recorder that advertises the session
control route, including the gateway and the Claude telemetry listener. A
successful `hyp session status` therefore reflects all available recorders.
The ignored-session set is in memory: restarting the daemon clears it, and a
forked client session has a new session ID.

## Reconfigure an installation

For an ordinary interactive reconfiguration, run:

```sh
hyp setup
```

Select **Reconfigure** in the menu. HypAware preserves a centrally managed
configuration layer and changes only the choices this machine owns.

For a repeatable reconfiguration from a reviewed file, validate the file and
then replace the current local configuration:

```sh
hyp config validate --path ./hypaware-config.json
hyp setup --from-file ./hypaware-config.json --force
hyp status
```

## Upgrade within a compatible major version

HypAware doesn't currently provide a `setup update` command. For a compatible
1.x upgrade, update the global package, reinstall the service definition, and
check the installation:

```sh
npm install -g hypaware@1
hyp version
hyp config validate
hyp daemon install
hyp status
```

`hyp daemon install` refreshes the launchd or systemd user-service definition
so it points at the durable global binary. The command preserves your
configuration and recordings.

## Upgrade across a breaking version

HypAware doesn't currently automate breaking-version acceptance or rollback.
Before you install a new major version, read its release notes and save a copy
of `~/.hyp` at a new backup path. Then install the exact reviewed version and
validate before you resume ordinary use:

```sh
npm install -g hypaware@NEXT_MAJOR_VERSION
hyp version
hyp config validate
hyp daemon install
hyp status
```

Replace `NEXT_MAJOR_VERSION` with the version that you reviewed. Don't assume
that `--yes` accepts a breaking migration; no such acceptance contract exists
today. If validation fails, stop and restore the saved state with the recovery
procedure for that release.

## Reinstall or recover the current version

If the CLI binary or service definition is missing but your state is intact,
reinstall the package and service:

```sh
npm install -g hypaware@1
hyp config validate
hyp daemon install
hyp client status
hyp status
```

If you have a known-good configuration file, restore it through the supported
setup path:

```sh
hyp config validate --path ./known-good-config.json
hyp setup --from-file ./known-good-config.json --force
hyp daemon install
hyp status
```

Use `hyp client attach CLIENT` for any configured client that status reports as
detached. Replace `CLIENT` with a listed client name, such as `claude` or
`codex`.

## Review operations that change or delete data

Read the plan or warning before you approve any of these operations:

- `hyp sync` sends captured data to configured destinations. It prints the
  destination and exclusion plan, then asks for confirmation. Use
  `hyp sync --dry-run` to send nothing.
- `hyp privacy purge` permanently deletes matching rows from this machine's
  local cache and sweeps the Claude raw-body spool. It doesn't delete copies
  that were already exported or sent to a server.
- `hyp report delete` permanently deletes a report and its artifacts for the
  entire organization on the selected remote server.
- `hyp plugin install` and an updating `hyp plugin update PLUGIN` can fetch and
  execute remote plugin code. HypAware shows the source, resolved revision,
  manifest, requested permissions, and warnings before it asks you to trust
  the code. A non-interactive remote install or update refuses to continue
  without `--yes`. Review the source and pin a revision before you approve it.
- `hyp daemon uninstall` removes the persistent service and detaches clients
  so they don't point at a stopped gateway. It keeps the configuration,
  recordings, and logs.
- `hyp client detach CLIENT` stops future capture and keeps recordings. For a
  legacy proxy attach, `--purge` also removes the HypAware interception CA and
  its keychain trust. Claude telemetry detach removes the managed telemetry
  settings and sweeps its raw-body spool.
- `hyp remote login` stores a permission-restricted credential. Prefer browser
  sign-in, `--token-file`, or standard input. Don't place a token directly in
  shell history.

For the full privacy model, see
[Control what HypAware records](./PRIVACY.md).

## Use canonical command names

Use the task-oriented names in new scripts and documentation. Older spellings
remain compatibility aliases and use the same runners:

| Compatibility spelling | Canonical spelling |
| --- | --- |
| `hyp init` | `hyp setup` |
| `hyp attach`, `hyp detach`, `hyp unattach` | `hyp client attach`, `hyp client detach` |
| `hyp backfill`, `hyp backfill plan`, `hyp backfill list` | `hyp client history import`, `hyp client history plan`, `hyp client history providers` |
| `hyp skills install` | `hyp client skills install` |
| `hyp policy ...`, `hyp ignore`, `hyp unignore`, `hyp purge` | `hyp privacy ...` |
| `hyp query status`, `hyp query refresh`, `hyp query maintain` | `hyp cache status`, `hyp cache refresh`, `hyp cache maintain` |
| `hyp graph neighbors` | `hyp query graph neighbors` |
| `hyp vector search` | `hyp query vector search` |
| `hyp plugin new`, `hyp plugin doctor` | `hyp dev plugin new`, `hyp dev plugin doctor` |
| `hyp mcp` | `hyp mcp serve` |
| `hyp enrich ...` | `hyp enrichment ...` |

Plugin-owned aliases are available only when the owning plugin is active.

## Planned commands that aren't available

The following lifecycle commands describe planned behavior only. They are not
registered and don't work in the current CLI:

```text
hyp setup update
hyp setup repair
hyp setup rollback
```

Use the current upgrade and recovery procedures in this guide instead.

The `source gascity` routes are also unavailable. HypAware doesn't publish
those canonical routes until Gas City attachment changes persist across
process restarts.
