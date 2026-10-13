# Capture in Claude Code cloud sessions

`setup.sh` makes a Claude Code cloud environment record its sessions with
HypAware. Claude Code cloud sessions run in a fresh Linux VM per session, with
no systemd or launchd, so `hyp daemon install` cannot work there. Instead:

- the environment's **setup script** (runs once per environment cache, as root,
  before Claude Code starts) installs a pinned `hypaware` and runs
  `hyp setup --client claude --no-daemon`;
- a **SessionStart hook** it registers in `~/.claude/settings.json` joins a
  central server the first time it runs, when `HYP_CENTRAL_URL` and
  `HYP_JOIN_TOKEN` are set (the join is done here because a session sees the
  environment's variables, and a join in the setup script did not take
  effect), then starts `hyp daemon run` in every session, including resumed
  ones. A second start
  exits on its own while a daemon is alive. A VM rebuilt after idling keeps
  the old daemon's pid file but restarts pid numbering, so the hook first
  removes that file unless its pid is still a hyp daemon; otherwise an
  unrelated process holding the old pid would block the start. The daemon
  exits 75 to ask for a relaunch (new central config, a self-update), so the
  hook runs it in a loop that relaunches on 75 and stops on any other exit.

Both capture lanes work in a real cloud session: live OTEL telemetry
(`claude_telemetry_events`) and the transcript sweep (`ai_gateway_messages`,
every 5 minutes by default).

## Set up an environment

Environments are created in the UI only: the environment selector at
[claude.ai/code](https://claude.ai/code) or in the Desktop app's prompt box.
The CLI cannot create one; `/remote-env` only picks which existing one
`claude --cloud` uses.

1. Add an environment.
2. **Network access:**
   - local-only capture: **Trusted** (the default; it reaches npm);
   - with a central server: **Custom**, with the central host allowed and the
     default package-manager list kept.
3. **Environment variables** (central only):
   ```
   HYP_CENTRAL_URL=https://api.hypaware.ai
   HYP_JOIN_TOKEN=<token>
   ```
   `HYP_CENTRAL_URL` is the server's base URL (a self-hosted server's own
   base URL, never a `/v1/mcp` URL). Mint the token on your own machine,
   signed in with `hyp remote login`, with
   `hyp remote mint --label claude-cloud`; it prints once. Anyone who can use
   the environment can read these values, so give cloud sessions their own
   token. See [CI and headless deployment](../../docs/TEAM_SETUP.md#ci-and-headless-deployment).
4. **Setup script:** paste the contents of `setup.sh`.
5. Start a session in the environment. The first start runs the setup script;
   later starts reuse the cached result.

On Team and Enterprise plans an Owner can do this once for everyone: create a
shared environment on the **Cloud environments** admin page and make it the
organization's default environment at
[admin-settings/claude-code](https://claude.ai/admin-settings/claude-code).

To change the HypAware version, edit `HYP_VERSION` in the pasted script; a
changed setup script rebuilds the environment cache.

## Check it works

In a session, after doing some work, ask Claude to run:

```sh
pgrep -fa "daemon run" | grep -v pgrep          # exactly one daemon
tail -3 ~/.hyp/cloud-daemon.log
tail -2 ~/.hyp/hypaware/plugins/@hypaware/claude/session-context.jsonl
hyp query sql "select event_name, count(*) n from claude_telemetry_events group by event_name"
hyp query sql "select session_id, role, count(*) n from ai_gateway_messages group by session_id, role"
```

| Result | Meaning |
| --- | --- |
| no `hyp`, or no daemon log | the setup script failed; the session still starts, without capture |
| daemon log, but no `session-context.jsonl` | Claude Code did not run the hooks in `~/.claude/settings.json`; OTEL events are withheld until a session's working directory is known, so only the transcript sweep records |
| `session-context.jsonl` and telemetry rows | both lanes work |

The first seconds of OTEL events can be lost: Claude Code starts exporting
before the hook has the daemon listening. The transcript sweep still records
the conversation.
