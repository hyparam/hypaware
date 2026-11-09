# Cursor

**Status:** Supported. **Setup id:** `cursor`. **Backfill:** Yes.

HypAware records the Cursor editor and the Cursor CLI. Cursor hooks tell
HypAware when a session changes, and HypAware then reads the session from
Cursor's own local store, read-only. A recovery sweep every five minutes picks
up anything the hooks missed.

## What is recorded

Prompts, responses, tool calls, and the file contents and command output
Cursor's tools see, with each session's working directory. While the hooks are
attached, each turn's token usage (input, output, cache read, and cache write)
is recorded from Cursor's stop hook, when Cursor reports it. Imported history
has no token usage, because Cursor's store does not keep it. Cost is not
recorded.

## Set it up

`hyp setup` offers Cursor when it finds `~/.cursor/hooks.json`. To add it later:

```sh
hyp attach cursor --dry-run
hyp attach cursor
hyp client status cursor
```

Attach adds HypAware's hooks to `~/.cursor/hooks.json`, keeps your other hooks,
and installs HypAware's skills in `~/.cursor/skills`.

## Import existing history

```sh
hyp backfill cursor --dry-run
hyp backfill cursor
```

## Cursor Cloud agents (beta)

The Cloud collector runs inside a Cursor-managed Linux VM. It records the
current agent and one explicitly connected repository. Local editor/CLI setup
does not enable it. It needs a Cursor API key in the `CURSOR_API_KEY` Runtime
Secret; keep the key out of prompts, repository files and Build secrets. Use a
short-lived test key first. Cursor currently offers an Admin-scoped key, so it
can access more than the single agent HypAware reads.

Install HypAware in the environment's Build script, pinning the released version
you want to run. Do not enroll or connect during the Build. In the Start script,
from the repository root, configure a fresh VM and connect it:

```sh
hyp setup --source cursor --export keep-local --no-backfill --no-daemon
hyp cursor-cloud connect
hyp cursor-cloud start
```

To sync to your HypAware organization, also store a CI enrollment token as the
`HYP_CI_TOKEN` Runtime Secret. After setup and before starting, enroll with:

```sh
printf '%s' "$HYP_CI_TOKEN" | hyp join https://api.hypaware.ai --no-daemon
```

The enrollment token is passed over stdin. The detached collector does not
inherit it. `start` finishes so Cursor can run the agent, and the ordinary
foreground daemon handles staged configuration restarts. There is no tmux or
systemd requirement. Setup/connection must precede starting the daemon; stop an
existing collector before changing modes. Repository hooks are runtime changes:
keep them out of your commits and never snapshot an enrolled VM into a Build.

The documented conversation API supplies completed user and assistant text,
including the first turn that Cloud hooks can omit. Recovery checks every thirty
seconds and waits for matching text in two completed snapshots, usually thirty
to sixty seconds after the agent finishes. Hooks supply tool inputs and
outputs, explicit failures and file edits. Edit rows are observations containing
the supplied old/new strings. Repeated commands keep distinct native tool IDs.
Rows use `client_name = cursor` and `entrypoint = cloud`.

Only the connected workspace and non-excluded sessions are admitted. Edits and
file observations also enforce canonical path containment and stricter file
policy. Ordinary command output retains workspace policy; HypAware does not
infer which arbitrary files a shell command might have read. API recovery is
bounded to 2 MiB and 256 messages per snapshot, with an eight-second deadline;
larger conversations report incomplete capture. API failure retries without
blocking tool hooks. Original API message timestamps and usage are unavailable.
Tool output may be summarized or truncated by Cursor. Child text is captured
only when its own hooks supply it, without inferred parent relationships.
Tool and edit hooks use the bounded local listener without a separate disk
queue. Unconfirmed callbacks warn and allow the agent to continue. Callbacks
missed while the collector is stopped or restarting cannot be recovered;
main-agent text can be recovered through the API after restart.

Check health and delivery, then stop or disconnect:

```sh
hyp cursor-cloud status
hyp status --json
hyp sync --yes
hyp cursor-cloud disconnect
hyp daemon stop
```

Disconnect immediately revokes new capture, removes only owned repository
hooks, and preserves captured data. Sync before disconnect/stop and verify the
remote receipt before discarding the VM. Abrupt VM destruction can lose pending
local data. The legacy v0 conversation API and preview metadata interface may
change; this beta does not promise arbitrary historical backfill or complete
tool-output fidelity.
