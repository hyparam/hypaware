# What HypAware records, and how to control it

HypAware records AI activity on your machine. This page is the honest
inventory: what is captured, where it goes, and every control you have over
it. If your team is rolling HypAware out, this is the page to read before
you enroll.

## What gets recorded

Each capture source you enable during `hyp init` records into the local
query cache under `~/.hyp` (`HYP_HOME`):

| Source          | What lands in the cache                                                       |
|-----------------|-------------------------------------------------------------------------------|
| `claude`        | Claude Code conversations: prompts, responses, tool calls, working directory  |
| `codex`         | Codex conversations, same shape                                               |
| `raw-anthropic` | Raw Anthropic API request / response traffic routed through the local gateway |
| `raw-openai`    | Raw OpenAI API traffic, same shape                                            |
| `otel`          | OpenTelemetry logs, traces, and metrics sent to the local OTLP listener       |

Recording is content-level: conversation rows include the actual message
text, not just metadata. Rows age out of the local cache after the
retention window you picked at init (default 30 days).

## Where it goes

- **Solo install**: nowhere. Everything stays in the local cache (plus
  local Parquet exports if you enabled them). There is no phone-home.
- **Team install** (after `hyp remote login` or `hyp join`): recorded rows
  are forwarded to your organization's central server, including
  conversation content. The controls below decide which rows that covers.

## The three usage classes

Every directory subtree resolves to one class. Classes are evaluated from
an exchange's working directory, walking up the ancestor chain
(gitignore-style), and when multiple markings apply the most restrictive
wins.

| Class        | Recorded locally | Forwarded to the team server |
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
  hyp ignore              # write a .hypignore at the repo root (or cwd)
  hyp ignore <path>       # ignore a specific subtree
  hyp unignore            # remove it, re-enabling recording
  ```

  An empty or comment-only `.hypignore` also means `ignore`.

- **A machine-local store** (`hyp policy`) records the class privately on
  this machine, never as a file in the repo. Use it when the marking itself
  is sensitive (a dotfile in a hidden directory is a breadcrumb pointing at
  exactly the thing you are hiding), or when the path is not a repo:

  ```sh
  hyp policy set <path> ignore        # never recorded, no dotfile
  hyp policy set <path> local-only    # recorded, never forwarded
  hyp policy set <path> sync          # explicitly synced (not asked again)
  hyp policy show [path]              # which class governs, and why
  hyp policy list                     # every machine-local entry
  hyp policy unset <path> [class]     # back to the implicit default
  ```

Two caveats apply to both surfaces:

- **Prospective only.** A marking gates future recording and forwarding.
  Rows captured before it existed stay in the cache; deleting them is the
  separate, explicit `hyp purge` step below.
- **Class resolution needs a working directory.** Only the Claude and
  Codex pathways supply one, so directory markings are a no-op for the
  `raw-anthropic` / `raw-openai` proxy and OTEL sources.

## Pausing a single session

To keep one conversation out of the record without marking any directory,
run the `hypaware-ignore` skill inside Claude Code or Codex ("don't record
this session"). It is in-memory, lasts for that session, and is reversible
with `hypaware-unignore`. Install the skills with `hyp skills install`.

## Deleting what was already recorded

`hyp purge` permanently deletes rows from this machine's local cache. It
never contacts a sink or the remote, and never deletes copies that were
already exported or forwarded:

```sh
hyp purge <path>          # rows whose cwd is at or under the path
hyp purge --session <id>  # one session's rows
hyp purge --ignored       # every row whose directory now resolves to ignore
hyp purge --all           # everything, wholesale
```

It prompts on a TTY; pass `--yes` for non-interactive use.

## Enrolling with a team: the first-sync review

Enrollment never ships history silently. When `hyp remote login` (or
`hyp join`) enrolls a machine, the first sync, which includes backfilled
history, is held until at least 11:59pm local time that day, and the exact
deadline is printed. Before it passes:

1. Open Claude Code or Codex and run the **`hypaware-privacy`** skill. It
   walks the captured directories with you, marks each one
   ignore / local-only / sync, and purges anything sensitive before the
   first byte leaves the machine.
2. Optionally run the **`hypaware-sensitive-scan`** skill, which scans the
   recorded rows for secrets, credentials, and PII and recommends markings
   (it redacts every value it finds; it never echoes a secret).

## Leaving

`hyp leave` disconnects the machine from its central server: forwarding and
config pull stop, org-driven client attaches are undone, and the forward
credential is removed. Local recordings, config, and the daemon stay; use
`hyp purge` and the uninstall steps in the [README](../README.md#uninstalling)
to remove those too.

## The daemon's own telemetry

HypAware's self-telemetry (under `~/.hyp/hypaware/dev-telemetry/`) is local
and secret-safe by design: it records component / operation / status
attributes, never credentials or raw prompt content.
