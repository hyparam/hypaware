[← All documentation](README.md)

---

# What HypAware records, and how to control it

HypAware records AI activity on your machine. This page explains what is
captured, where it goes, and how to control it. If your team is rolling
HypAware out, read this page before you enroll.

## Contents

- [What gets recorded](#what-gets-recorded)
- [Where it goes](#where-it-goes)
- [The three usage classes](#the-three-usage-classes)
- [Marking directories](#marking-directories)
- [Control a whole client's sharing](#control-a-whole-clients-sharing)
- [Pausing a single session](#pausing-a-single-session)
- [Deleting what was already recorded](#deleting-what-was-already-recorded)
- [Review before the first Cloud sync](#review-before-the-first-cloud-sync)
- [The daemon's own telemetry](#the-daemons-own-telemetry)
- [Product telemetry](#product-telemetry)

## What gets recorded

Each capture source you enable during `hyp setup` records into the local
query cache under `~/.hyp` (`HYP_HOME`):

| Source | What lands in the cache |
| --- | --- |
| `claude` | Claude Code prompts, responses, tool calls and results, system prompts, tool definitions, and working directory where available |
| `claude-desktop` | Claude Desktop conversations imported from local transcripts on macOS |
| `codex` | Codex CLI and Desktop conversations imported from their shared local session files |
| `cursor` | Cursor editor and CLI conversations, including file contents and command output seen by its tools |
| `opencode` | OpenCode CLI and Desktop conversations from its managed plugin and history exports |
| `pi` | Pi conversations from its managed extension and local session files |
| `openclaw` | OpenClaw conversations from gateway traffic and local transcripts |
| `hermes` | Hermes Agent conversations read from its local state database |
| `raw-anthropic`, `raw-openai` | API requests and responses routed through the local gateway |
| `otel` | OpenTelemetry logs, traces, and metrics sent to the local OTLP listener |
| `github` | Structural repository activity such as issue, pull request, commit, file, review, and comment metadata; content remains on GitHub |

Conversation capture includes message content, not just metadata. Depending on
what the client exposes, records can also include system prompts, tool arguments
and results, working directories, and Git metadata. The available fields differ
by client and capture method.

Rows age out according to [local retention settings](CONFIGURATION.md#set-local-retention).
Retention does not delete original client transcripts or copies already exported.

### The raw-body spool

With Claude Code attached, Claude Code writes each raw request and response
body into `~/.hyp/spool/claude-bodies`, a directory HypAware creates
owner-only (`0700`). It is a transit area, not storage: HypAware reads a file
only for the few fields its event stream leaves out (the system prompt, the
tool list, message ordering, untruncated tool arguments) and deletes the file
as soon as it has them. The same content is already in Claude Code's own
transcripts under `~/.claude/projects`.

Spool cleanup works as follows:

- A session you ignored, by `.hypignore`, by a machine-local marking, or with
  `hyp session ignore`, has its bodies **deleted unread**, not skipped.
- The default cap is 512 MB, configured as `telemetry.spool_max_bytes` in
  the `@hypaware/claude` plugin's config. The listener and Claude hooks enforce
  it by deleting the oldest files first. It is periodic cleanup, not a filesystem
  quota: files can accumulate between checks, and cleanup requires one of those
  processes to run. Deleted bodies cannot supply missing capture detail.
- `hyp privacy purge` empties it, whatever else you asked that purge to delete, and
  `hyp detach claude` empties it on the way out.

### Proxy mode and certificate cleanup

Claude Code uses OTEL capture by default. An explicitly configured proxy routes
HTTPS through the local gateway. The gateway decrypts hosts named by the
configured capture adapters; other hosts are tunneled without decryption.
Only supported provider API requests are recorded.

The proxy's local certificate authority (CA) is stored under
`~/.hyp/hypaware/tls`. It is restricted to supported provider hosts and excludes
IP addresses. Current attach operations use client-scoped trust. An installation
that previously used Claude proxy capture may still have a CA trusted in the
macOS login keychain, a `NODE_USE_SYSTEM_CA` launchd environment variable, and
`~/Library/LaunchAgents/com.hyperparam.hypaware.node-system-ca.plist`. Those
settings affect other programs using that account's trust or environment.

Inspect these artifacts with `hyp status --verbose`. `hyp detach claude --purge`
and `hyp daemon uninstall` remove the CA, its keychain trust, the launchd
variable, and the login agent. Plain `hyp detach claude` leaves the CA and
keychain trust; it clears the variable and agent only when the attach marker
still identifies a proxy attach.

## Where it goes

- **Local only**: recordings stay in the local cache, plus any local exports
  you configured.
- **HypAware Cloud** (after choosing Sync to the cloud in setup,
  `hyp remote login`, or `hyp join`): recorded rows are synced to
  HypAware Cloud, including conversation content. The controls below
  decide which rows that covers.

Local recording does not mean HypAware makes no network requests. Supervised
global installations check npm for [automatic updates](CLI.md#update-hypaware)
by default; those checks do not send recordings. Separately configured remote
destinations and diagnostic exporters can also send data.

HypAware Cloud operators can read synced data across every org, and each
such read is recorded in that org's audit trail.

Enrollment also enables [product telemetry](#product-telemetry) for the
organization unless you saved a preference. It is separate from session recordings.

## The three usage classes

Every directory subtree resolves to one class. Starting at the session's
working directory, HypAware uses the nearest ancestor `.hypignore` file and
the most-specific matching machine-local marking. It then takes the most
restrictive result across those sources: `ignore`, then `local-only`, then
`sync`. This is not a merge of every ancestor file.

| Class        | Recorded locally | Synced to HypAware Cloud    |
|--------------|------------------|------------------------------|
| `sync`       | yes              | yes (the default)            |
| `local-only` | yes              | never                        |
| `ignore`     | never            | never                        |

`local-only` rows stay fully queryable on your own machine; they are
withheld at the export seam, so no sink or remote query can see them.

## Marking directories

There are two authoring surfaces for the same classes:

- **A committable `.hypignore` dotfile** marks a subtree `ignore` and
  travels with the repo, so it covers every clone:

  ```sh
  hyp privacy ignore              # write a .hypignore at the repo root (or cwd)
  hyp privacy ignore <path>       # ignore a specific subtree
  hyp privacy unignore            # remove it, re-enabling recording
  ```

  An empty or comment-only `.hypignore` also means `ignore`.

- **A machine-local store** (`hyp privacy`) records the class privately on
  this machine, never as a file in the repo. Use it when the marking itself
  is sensitive (a dotfile in a hidden directory is a breadcrumb pointing at
  exactly the thing you are hiding), or when the path is not a repo:

  ```sh
  hyp privacy set <path> ignore        # never recorded, no dotfile
  hyp privacy set <path> local-only    # recorded, never synced
  hyp privacy set <path> sync          # explicitly synced (not asked again)
  hyp privacy show [path]              # which class governs, and why
  hyp privacy list                     # every machine-local entry
  hyp privacy unset <path> [class]     # back to the implicit default
  ```

On a machine connected to HypAware Cloud, folders you have not marked sync
without asking. You can instead be asked, once per new folder, how to
handle it, at the moment you open a session there:

```sh
hyp privacy folders ask    # ask once per new folder
hyp privacy folders sync   # back to syncing without asking (the default)
hyp privacy folders        # report which is in force
```

This gates the question only. In either setting, folders you already
marked keep their class, `.hypignore` files are unaffected, and nothing
already local-only or ignored starts syncing. The setting is machine-local
and reversible, `hyp setup` asks for it in its own step, and `hyp status`
names it on an enrolled machine.

Three caveats apply to both surfaces:

- **Prospective only.** A marking gates future recording and syncing.
  Rows captured before it existed stay in the cache; deleting them is the
  separate, explicit `hyp privacy purge` step below.
- **Class resolution needs a working directory.** The client sources
  (Claude Code, Claude Desktop, Codex, Cursor, OpenCode, Pi, OpenClaw) supply
  one. Hermes supplies the real one for an interactive session it recorded a
  cwd for, and scopes a messaging-channel session (Telegram, Discord, Slack,
  WhatsApp, Signal, email) under a derived `~/.hermes/channels/<source>` path
  instead; an interactive Hermes session with no recorded cwd has no scope to
  match and is recorded unconditionally. The `raw-anthropic` / `raw-openai`
  proxy and OTEL sources never supply one, so directory markings are a no-op
  for them.
- **A session is classed by its own directory, not by what it reads.**
  Local SQL and search normally hide local-only rows from a caller that can
  sync. If you explicitly include them with `--include-local-only` or copy
  private content into another session, that session follows its own directory's
  class. A report-generating conversation in a `sync` folder can therefore sync
  the private excerpts it quotes. `hyp report generate` uses the directory you
  type it in and does not change its class. Choose that directory deliberately,
  or run `hyp session ignore` inside the supported session it starts.

## Control a whole client's sharing

Keep a locally configured client's recordings on this machine:

```sh
hyp privacy client codex local-only
hyp privacy client codex sync
```

Organization-managed clients cannot be changed with this local control. Use
[directory markings](#marking-directories) for project-level exclusions.
Returning a client to `sync` affects future exports; previously withheld history
requires a separate, confirmed `hyp sync --history codex`. Completing team setup
can clear client-level local-only choices; review the [setup prompts](TEAM_SETUP.md#follow-the-prompts).

## Pausing a single session

Run `hyp session ignore` inside a Claude Code or Codex session to resolve its
ID automatically. If it cannot establish the ID, the command refuses to guess.
For another supported recorder, pass an explicitly verified session ID as
shown in the [session reference](CLI_REFERENCE.md#control-the-current-session).

The command sends the exclusion to local recorder control routes for the gateway,
Claude telemetry, OpenCode, Pi, and Cursor when they are running. The Claude
listener deletes ignored sessions' spooled bodies unread. Use
`hyp session unignore` to resume and `hyp session status` to check the result.

Gateway, Claude, OpenCode, and Pi exclusions are saved under
`<HYP_HOME>/hypaware/session-ignores/` and survive restarts. **Cursor exclusions
are currently in memory only and must be reapplied after a recorder restart.**
OpenClaw and Hermes do not support this session control; use directory markings
or disable their capture integrations.

Claude (including Desktop transcripts), Codex, OpenCode, and Pi backfill honor
saved exclusions, including manual imports in a separate process. Saving must
succeed before a persistent recorder reports success. If its exclusion store is
unreadable or corrupt, capture and transcript imports pause while AI requests
still forward. Commands and source status report the error. Repair the saved
state and restart HypAware before relying on capture again.

A resumed session keeps its ID. A fork creates a new ID and needs its own
exclusion. For attached Claude Desktop Code sessions, the managed SessionStart
hook supplies the ID to later Bash commands. Hosts without hooks or
`CLAUDE_ENV_FILE` require an explicitly verified ID; a matching directory or
recent transcript is insufficient.

Ignoring does not delete earlier records, original client transcripts, or
exported copies. Unignoring makes the entire transcript eligible for import,
including turns written while ignored. Use `hyp privacy purge --session <id>`
to delete previously captured rows.

## Deleting what was already recorded

`hyp privacy purge` permanently deletes rows from this machine's local cache:

```sh
hyp privacy purge <path>          # rows whose cwd is at or under the path
hyp privacy purge --session <id>  # one session's rows, here and on your servers
hyp privacy purge --ignored       # every row whose directory now resolves to ignore
hyp privacy purge --all           # everything, wholesale
```

It prompts on a TTY; pass `--yes` for non-interactive use.

A session purge is the only form that reaches beyond this machine. It also
deletes that session's rows from every configured or signed-in remote and
every enrolled server, and keeps the session from being recorded again. The
confirmation prompt names the servers it will contact:

```sh
hyp privacy purge --session <id> --remote <target>  # this machine and one server
hyp privacy purge --session <id> --local-only       # this machine only
```

Deleting on a server uses your login, and needs you to be the session's owner
or an organization admin. If a server cannot be reached or refuses, the
command exits nonzero; run it again to finish. Copies quoted into a published
report are not removed, and the underlying files are reclaimed by later
maintenance, not at the moment of the purge.

The path, `--ignored`, and `--all` forms are local only: they never contact a
sink or a server, and never delete copies already exported or synced.

Every form of it also empties the raw-body spool described above, including
the targeted ones: a spooled body has not been read yet, so nothing about it
says which directory or session it belongs to, and leaving it would let the
next batch write back rows you just deleted.

## Review before the first Cloud sync

Before sharing recordings, review captured directories with the
`hypaware-privacy` skill in Claude Code or Codex. It checks this machine's local
cache, samples recordings, and proposes directory markings and deletions for
your confirmation. A review cannot guarantee it will find every secret, and it
does not automatically redact all recorded content. You can run it at any time,
even without Cloud enrollment.

For the enrollment hold, deadline, and unattended behavior, see
[the first-sync review](TEAM_SETUP.md#review-before-the-first-upload).

For disconnecting a machine while retaining its local recordings, see
[Cloud and teams](TEAM_SETUP.md#disconnect-a-machine).

## The daemon's own telemetry

HypAware's operational diagnostics are separate from product telemetry:

- With `HYP_DEV_TELEMETRY=1`, logs, spans, and metrics are written locally under
  `~/.hyp/hypaware/dev-telemetry/`.
- Without that setting, an inherited `OTEL_EXPORTER_OTLP_ENDPOINT` sends those
  diagnostics to the configured endpoint.
- With neither setting, those diagnostic providers do not record or export data.

These diagnostics use component, operation, and status attributes. They are
designed to exclude credentials and raw prompt content. Service output logs are
separate; see [data paths](CONFIGURATION.md#know-where-data-lives).

## Product telemetry

Product telemetry reports how HypAware itself is running. It is enabled for an
enrolled organization unless you saved an `off` or `local` preference. An
already-enrolled machine starts reporting on its next CLI run or daemon start
after an upgrade, without a new prompt. Standalone installations default to off.
Check the effective state and destination:

```sh
hyp telemetry status
```

Organization telemetry goes to the HypAware server this machine is enrolled
with, using its existing enrollment. There is no separate telemetry service.

### Control and preview

```sh
hyp telemetry off
hyp telemetry enable local
hyp telemetry preview
hyp telemetry enable organization
```

`off` saves your preference, including across re-enrollment, and removes queued
batches. It cannot recall batches the server already accepted. If saving fails,
the command exits nonzero and reports that telemetry remains enabled.

`local` keeps a preview queue without sending it. `organization` enables sending
and requires one eligible enrolled central sink with an HTTPS destination.
Changing the mode clears older pending batches. `preview` prints the exact next
batch, or `null` if none is queued.

Restart a running daemon after enabling collection. It notices disabling and
enrollment changes within 30 seconds. `hyp status` also reports telemetry state.

### What is collected

| Data | Examples |
| --- | --- |
| Command outcomes | A command name from a fixed list, success or failure, duration, and selected setup steps; custom commands appear as `other` |
| Installation and process details | HypAware version, OS, architecture, Node major version, configured integrations, and generated installation/process identifiers |
| Daemon health | Lifecycle events, memory and CPU summaries, and counts of rows captured, written, and exported |

Conversations, prompts, responses, argument values, SQL, file paths, credentials,
and free-text error messages are excluded. Coverage is partial: a killed process
may never report a completion, and missing measurements do not mean zero activity.

### Storage and delivery

The queue holds at most 160 batches of 32 KiB each, up to 5 MiB. It lives under
`~/.hyp/hypaware/product-telemetry/`. New records are dropped when it is full.
Batches expire after seven days when a collector or sender runs; an inactive
installation cannot clean up on a timer. A sudden power loss may lose queued data.

The daemon attempts one batch every 30 seconds. Without a daemon, a CLI command
may send an earlier batch while it runs. Command exit does not wait for delivery,
so a final batch may remain queued until HypAware runs again.

Network failures retry with backoff. A 401 first triggers a credential refresh;
continued 401 or a 403 pauses delivery for an hour. A server without compatible
telemetry support also pauses delivery. Permanent payload rejections
(400, 409, 413, 415, or 422) discard the rejected batch. The receiving server must
have product reporting enabled.
