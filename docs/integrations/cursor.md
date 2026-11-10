# Cursor

**Status:** Editor/CLI supported; Cloud beta. **Setup id:** `cursor`.
**Backfill:** Local history; connected-agent text recovery in Cloud.

HypAware records the Cursor editor and the Cursor CLI. Cursor hooks tell
HypAware when a session changes, and HypAware then reads the session from
Cursor's own local store, read-only. A recovery sweep every five minutes picks
up anything the hooks missed. [Cloud agents](#cursor-cloud-agents-beta) use a
separate opt-in collector inside their managed VM.

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

### Prepare the environment and credentials

In [Cursor's Cloud Agents dashboard](https://cursor.com/dashboard/cloud-agents),
open **Environments** and select or create an environment for one repository.
Create a short-lived key in [Cursor API Keys](https://cursor.com/dashboard/api).

For HypAware Cloud sync, mint an enrollment token on a computer where you are
already signed in with `hyp remote login`:

```sh
hyp remote mint --label cursor-cloud --expires-days 30
```

The token is printed once. In the Cursor environment's **Secrets** settings,
add the following as **Runtime Secrets**:

| Name | Value |
| --- | --- |
| `CURSOR_API_KEY` | The key from Cursor API Keys |
| `HYP_CI_TOKEN` | The token printed by `hyp remote mint`; omit to keep recordings on the VM only (they are lost when it is discarded) |

Do not put either value in an agent prompt. Replace expiring secrets before
starting further runs. See [CI enrollment](ci-and-headless.md#one-time-mint-a-token)
for token lifetime and host grouping.

### Configure Install and Start

Install HypAware in the saved environment's Install script, pinning the released
version you want to run. Saved environment commands take precedence over a
repository's `environment.json`; update the saved Install and Start scripts.
Do not enroll or connect during the Build. Append this to the Install script,
replacing `RELEASE_VERSION` with a released version containing the
`cursor-cloud` commands:

```sh
npm install --global hypaware@RELEASE_VERSION
```

Preserve the environment's command that enters the repository directory, so
both scripts run from its root.

For a fresh VM, run this complete Start script from the repository root. It
keeps recordings local when no enrollment token is supplied:

```sh
set -eu
export HYP_HOME="${HYP_HOME:-$HOME/.hyp}"
: "${CURSOR_API_KEY:?Set the Cursor API key as a Runtime Secret}"
hyp setup --source cursor --export keep-local --no-backfill --no-daemon --yes
if [ -n "${HYP_CI_TOKEN:-}" ]; then
  printf '%s' "$HYP_CI_TOKEN" | hyp join https://api.hypaware.ai --no-daemon
fi
hyp cursor-cloud connect
hyp cursor-cloud start
```

Run later health, sync and stop commands as the same user with the same absolute
`HYP_HOME`. An export in the Start script does not change later agent shells.
Do not enable shell tracing around credentials.

The enrollment token is passed over stdin. The detached collector does not
inherit it. `start` finishes so Cursor can run the agent, and the ordinary
foreground daemon handles staged configuration restarts. There is no tmux or
systemd requirement. Setup/connection must precede starting the daemon; stop an
existing collector before changing modes. Repository hooks are runtime changes:
keep them out of your commits and never snapshot an enrolled VM into a Build.

Save the environment and trigger a new Build. Once that Build succeeds, start
a fresh Cloud agent from it. Later agents using the environment run the Start
script automatically and connect their own current agent and repository.

### Verify capture and stop

Complete a small task with a distinctive prompt, response and file edit. After
the turn finishes, allow about a minute for text recovery, run `hyp sync --yes`,
and find the conversation in HypAware Cloud. API retries can make this take
longer. Keep the VM alive until the remote receipt is verified.

The documented conversation API supplies completed user and assistant text,
including the first turn that Cloud hooks can omit. Recovery checks every thirty
seconds and waits for matching text in two completed snapshots, usually thirty
to sixty seconds after the agent finishes. Hooks supply tool inputs and
outputs, explicit failures and file edits. Edit rows are observations containing
the supplied old/new strings. Repeated commands keep distinct native tool IDs.
Rows use `client_name = cursor` and `entrypoint = cloud`.

Privacy controls work as they do for the editor. A .hypignore that excludes
the repository root stops `connect`, and stops capture if it appears later.
`hyp session ignore` on the agent stops its capture, including its child
agents. Edits and file reads outside the repository, or in a local-only folder
of a repository that syncs, are not recorded at all. Rows from a local-only
repository stay on the VM and never sync, so they are lost when the VM is
discarded. Ordinary command output retains workspace policy; HypAware does not
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

Before testing tool/edit capture, wait for startup to complete. The default
listener's readiness check is `curl -fsS http://127.0.0.1:4321/`; it must report
`name: hypaware/cursor`, `mode: cloud` and `status: ready`. This confirms the
listener is accepting callbacks. `hyp cursor-cloud status` shows the saved grant;
`hyp status --json` shows live Cursor source health, including degraded recovery.
An API timeout retries automatically; allow additional completed snapshots
before expecting recovered text. A successful upload alone does not prove
capture: verify the distinctive prompt/response and edit in the remote receipt.

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
