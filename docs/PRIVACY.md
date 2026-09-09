# What HypAware records, and how to control it

HypAware records AI activity on your machine. This page is the honest
inventory: what is captured, where it goes, and every control you have over
it. If your team is rolling HypAware out, this is the page to read before
you enroll.

## What gets recorded

Each capture source you enable during `hyp setup` records into the local
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
local-only one; `hyp setup --retention-days <N>` overrides).

### The raw-body spool

With Claude Code attached, Claude Code writes each raw request and response
body into `~/.hyp/spool/claude-bodies`, a directory HypAware creates
owner-only (`0700`). It is a transit area, not storage: HypAware reads a file
only for the few fields its event stream leaves out (the system prompt, the
tool list, message ordering, untruncated tool arguments) and deletes the file
as soon as it has them. The same content is already in Claude Code's own
transcripts under `~/.claude/projects`.

Three things keep it from becoming a second record:

- A session you ignored, by `.hypignore`, by a machine-local marking, or with
  `hyp session ignore`, has its bodies **deleted unread**, not skipped.
- The directory has a size cap (512 MB by default, `spool_max_bytes` in the
  `@hypaware/claude` config). Past it the oldest files go first, so a stopped
  daemon costs detail, never disk.
- `hyp purge` empties it, whatever else you asked that purge to delete, and
  `hyp client detach claude` empties it on the way out.

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

**Where it is trusted.** Trust stays file-scoped to the proxied client's own
settings: nothing HypAware runs installs the CA into an OS trust store,
including your login keychain, and anything wider is your own decision.
Earlier releases attached Claude Code by proxy and did install it into your
**login keychain** as a user-domain trusted root, because that client's
Remote Control transport trusted only the keychain and nothing else. That
changed your account's certificate trust settings, which is why macOS itself
raised the password dialog: an application running as you that consults the
login keychain will accept certificates this CA signs, for those hosts.
Declining the dialog was supported and capture kept working without it, with
only Remote Control's inbound channel lost. The change never needed admin
rights, and the machine-wide system keychain and other user accounts were
never modified. If you ran one of those releases, that trust setting is
still on your account until you remove it.

**What else an earlier macOS attach left behind.** The keychain root only
took effect if `NODE_USE_SYSTEM_CA=1` was in the environment before Claude
Code started, so that attach also ran `launchctl setenv NODE_USE_SYSTEM_CA 1`
and installed a LaunchAgent at
`~/Library/LaunchAgents/com.hyperparam.hypaware.node-system-ca.plist` that
re-runs that one command at each login. What it runs is `/bin/launchctl`
itself, once, which sets the variable and exits: there is no resident
process, no HypAware code in it, and nothing is sent anywhere. No attach
writes either one today. On a machine that ran one of those releases it is
still a login item, and still a session-wide variable that other Node
programs will also read.

**Its lifetime.** `hyp status` shows the fingerprint, every host the CA is
permitted to vouch for, whether the keychain still trusts it, and whether
the launchd variable is live. `hyp client detach claude --purge` and `hyp daemon
uninstall` remove the CA, its keychain trust, the launchd variable, and the
login agent. A plain `hyp client detach claude` leaves the CA and any trust an
earlier release was granted in place, because a detach is not a statement
about the certificate and no attach re-creates the grant; it clears the
launchd variable and its agent only while that client's attach marker still
records a proxy attach.

## Where it goes

- **Solo install**: nowhere. Everything stays in the local cache (plus
  local Parquet exports if you enabled them). There is no phone-home.
- **Team install** (after `hyp remote login` or `hyp join`): recorded rows
  are forwarded to your organization's central server, including
  conversation content. The controls below decide which rows that covers.

The deployment's operators can read forwarded data across every org on the
server, and each such read is recorded in that org's audit trail.

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
  hyp privacy set <path> local-only    # recorded, never forwarded
  hyp privacy set <path> sync          # explicitly synced (not asked again)
  hyp privacy show [path]              # which class governs, and why
  hyp privacy list                     # every machine-local entry
  hyp privacy unset <path> [class]     # back to the implicit default
  ```

On a machine connected to a server, folders you have not marked sync
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

Two caveats apply to both surfaces:

- **Prospective only.** A marking gates future recording and forwarding.
  Rows captured before it existed stay in the cache; deleting them is the
  separate, explicit `hyp privacy purge` step below.
- **Class resolution needs a working directory.** Only the Claude and
  Codex pathways supply one, so directory markings are a no-op for the
  `raw-anthropic` / `raw-openai` proxy and OTEL sources.

## Pausing a single session

To keep one conversation out of the record without marking any directory,
run `hyp session ignore` from inside that Claude Code or Codex session. It
resolves the session id itself and refuses rather than guessing when it
cannot, and it posts the opt-out to every local recorder hosting the control
route: the gateway, and the Claude telemetry listener when one is running.
On the listener, a dropped session's spooled raw bodies are deleted, not
merely skipped. Reverse it with `hyp session unignore`; `hyp session status`
reports which state the session is in right now.

The opt-out is in-memory and lasts for that session only. Two things drop it
while you may still believe it holds: a daemon restart (which drops both
recorders' sets), and a fork (`claude --fork-session`, `codex fork`), which
mints a new session id the opt-out no longer covers. A plain resume reuses
the id.

## Deleting what was already recorded

`hyp privacy purge` permanently deletes rows from this machine's local cache. It
never contacts a sink or the remote, and never deletes copies that were
already exported or forwarded:

```sh
hyp privacy purge <path>          # rows whose cwd is at or under the path
hyp privacy purge --session <id>  # one session's rows
hyp privacy purge --ignored       # every row whose directory now resolves to ignore
hyp privacy purge --all           # everything, wholesale
```

It prompts on a TTY; pass `--yes` for non-interactive use.

Every form of it also empties the raw-body spool described above, including
the targeted ones: a spooled body has not been read yet, so nothing about it
says which directory or session it belongs to, and leaving it would let the
next batch write back rows you just deleted.

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
`hyp privacy purge` and the uninstall steps in the [README](../README.md#uninstalling)
to remove those too.

## The daemon's own telemetry

HypAware's self-telemetry (under `~/.hyp/hypaware/dev-telemetry/`) is local
and secret-safe by design: it records component / operation / status
attributes, never credentials or raw prompt content.
