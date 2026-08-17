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
| `codex`         | Codex conversations, same shape, from both the Codex CLI and Codex Desktop    |
| `raw-anthropic` | Raw Anthropic API request / response traffic routed through the local gateway |
| `raw-openai`    | Raw OpenAI API traffic, same shape                                            |
| `otel`          | OpenTelemetry logs, traces, and metrics sent to the local OTLP listener       |

Recording is content-level: conversation rows include the actual message
text, not just metadata. Rows age out of the local cache after the
retention window init set (90 days on a team install, 120 on a
local-only one; `hyp init --retention-days <N>` overrides).

### If you turned on proxy mode

Proxy mode (see the README) routes all of Claude Code's HTTPS through the
local gateway rather than only its model calls, so it is worth being
precise about what that does and does not change.

**What it does not change: what is recorded.** Only `/v1/messages`
traffic is recorded, exactly as in the table above. Claude Code also calls
its own host for things like update checks, OAuth account settings and the
MCP registry; those are forwarded untouched and nothing about them is
stored. No request or response body is even read for them.

**What it does change: what passes through.** Every host Claude Code
connects to now goes through the gateway. Only `api.anthropic.com` is
decrypted, because that is the only host a capture source names. Everything
else, including package registries and any telemetry the client sends
elsewhere, is tunnelled through without being decrypted: the gateway sees
the hostname and the number of bytes, and nothing inside.

**The certificate.** Decrypting one host requires a certificate authority,
which is generated on your machine, stored in `~/.hyp/hypaware/tls`
readable only by you, and name-constrained so it cannot vouch for any host
outside the provider set HypAware's client adapters intercept (today
`api.anthropic.com`, `api.openai.com`, `chatgpt.com`). All IP addresses are
excluded.

**Where it is trusted.** On macOS, attach installs the CA into your **login
keychain** as a user-domain trusted root, because Claude Code's Remote
Control transport trusts only the keychain and nothing else. This does
change your account's certificate trust settings, which is why macOS itself
raises the password dialog: an application running as you that consults the
login keychain will accept certificates this CA signs, for those hosts.
Declining the dialog is supported and capture keeps working without it, with
only Remote Control's inbound channel lost. The change never needs admin
rights, and the machine-wide system keychain and other user accounts are
never modified. On other platforms the CA is trusted only by Claude Code,
through that client's own settings.

**What else macOS attach leaves behind.** The keychain root only takes
effect if `NODE_USE_SYSTEM_CA=1` is in the environment before Claude Code
starts, so attach also runs `launchctl setenv NODE_USE_SYSTEM_CA 1` and
installs a LaunchAgent at
`~/Library/LaunchAgents/com.hyperparam.hypaware.node-system-ca.plist` that
re-runs that one command at each login. What it runs is `/bin/launchctl`
itself, once, which sets the variable and exits: there is no resident
process, no HypAware code in it, and nothing is sent anywhere. It is still a
login item on your machine, and a session-wide variable that other Node
programs will also read. `hyp detach
claude` unsets the variable and removes the agent, as do
`hyp detach claude --purge` and `hyp daemon uninstall`.

**Its lifetime.** `hyp status` shows the fingerprint, every host the CA is
permitted to vouch for, whether the keychain still trusts it, and whether
the launchd variable is live. `hyp detach claude` deliberately keeps the CA
and the trust in place, so re-attaching later does not ask for your password
again; `hyp detach claude --purge` and `hyp daemon uninstall` remove the CA
and its keychain trust.

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

On a machine connected to a server, folders you have not marked sync
without asking. You can instead be asked, once per new folder, how to
handle it, at the moment you open a session there:

```sh
hyp policy folders ask    # ask once per new folder
hyp policy folders sync   # back to syncing without asking (the default)
hyp policy folders        # report which is in force
```

This gates the question only. In either setting, folders you already
marked keep their class, `.hypignore` files are unaffected, and nothing
already local-only or ignored starts syncing. The setting is machine-local
and reversible, `hyp init` asks for it in its own step, and `hyp status`
names it on an enrolled machine.

Two caveats apply to both surfaces:

- **Prospective only.** A marking gates future recording and forwarding.
  Rows captured before it existed stay in the cache; deleting them is the
  separate, explicit `hyp purge` step below.
- **Class resolution needs a working directory.** Only the Claude and
  Codex pathways supply one, so directory markings are a no-op for the
  `raw-anthropic` / `raw-openai` proxy and OTEL sources.

## Pausing a single session

To keep one conversation out of the record without marking any directory,
run `hyp session ignore` from inside that Claude Code or Codex session. It
resolves the session id itself and refuses rather than guessing when it
cannot. Reverse it with `hyp session unignore`; `hyp session status` reports
which state the session is in right now.

The opt-out is in-memory and lasts for that session only. Two things drop it
while you may still believe it holds: a gateway restart, and a fork
(`claude --fork-session`, `codex fork`), which mints a new session id the
opt-out no longer covers. A plain resume reuses the id.

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

open Claude Code or Codex and run the **`hypaware-privacy`** skill. It walks
the captured directories with you, samples them for credentials, personal
material, and anything else you would not want on a shared server, marks each
directory ignore / local-only / sync, and purges anything sensitive before the
first byte leaves the machine. It redacts every value it reports back to you;
it never echoes a secret.

The first sync is the moment this matters most, but it is not a precondition:
run `hypaware-privacy` whenever you want to know what has been captured here,
enrolled or not. It reviews this machine's local cache; it cannot inspect rows
already forwarded to a server.

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
