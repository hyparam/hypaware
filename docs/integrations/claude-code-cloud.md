# Claude Code Cloud

**Status:** Tested setup recipe for HypAware 1.42.0, October 13-15, 2026.
**Setup id:** `claude`.

Run HypAware beside Claude Code in an Anthropic-managed cloud session. The
setup script installs and attaches HypAware before Claude launches, then adds
hooks that start capture on every session and upload after the last reply.
Both live OpenTelemetry capture and transcript recovery worked in the original
cloud test. Your computer does not need to remain awake.

This is the recipe from the
[original cloud session](https://claude.ai/code/session_01KJKTgd1nks6nusu8diekmV),
preserved at [commit cdb476d2](https://github.com/hyparam/hypaware/tree/cdb476d2b4faa074f737b86040173d9c9f8ce8ac/scripts/cloud).
It pins the version that was tested; newer HypAware releases have not been
retested here. Broader integration work remains tracked in
[HYP-115](https://linear.app/hyperparam/issue/HYP-115/add-support-for-cloud-claude-agents).

## Set up an environment

1. At [claude.ai/code](https://claude.ai/code), open the environment selector
   under the new-session message box and add or edit an environment. You can
   also use the Desktop app's cloud environment selector. `/remote-env` in
   the CLI selects an existing environment.
2. For local-only recording, keep **Trusted** network access so npm is
   reachable. The loader also needs `hypaware.ai`; add it to
   **Custom** network access if your allowlist does not include it. For
   HypAware Cloud, also allow `api.hypaware.ai`. Keep the default
   package-manager domains.
3. For HypAware Cloud, mint a dedicated token on your signed-in computer:

   ```sh
   hyp remote mint --label claude-cloud
   ```

   Add it to the cloud environment's **Environment variables** field:

   ```text
   HYP_JOIN_TOKEN=<token>
   ```

   The token prints once. Anyone who can use the environment can read it;
   keep it out of repository files, prompts, and the setup script. Without
   this variable, the recipe records locally. Reusing the token groups runs
   under one shared HypAware host. See [headless enrollment](ci-and-headless.md).
4. Paste the complete script below into the environment's **Setup script**.
5. Start a new session using the environment. The first start builds the
   environment cache; later sessions reuse the installed files and run the
   session hooks again.

Node 22.12 or newer is required. The pinned version needs Claude Code 2.1.193
or newer for telemetry, and 2.1.214 for full tool-decision detail.

## Setup script

Paste this four-line setup script. It downloads the helper from HypAware,
then runs it only if the download succeeds:

```sh
#!/bin/bash
curl -fsSL https://hypaware.ai/claude-cloud.sh -o /tmp/hypaware-cloud-setup.sh &&
  bash /tmp/hypaware-cloud-setup.sh
exit 0
```

The [full helper](https://hypaware.ai/claude-cloud.sh)
contains the installation and both hooks. The loader preserves its behavior,
including letting the cloud session start if capture setup fails. Keep
`hypaware.ai` allowed alongside npm and, when syncing,
`api.hypaware.ai`.

## How startup and upload work

The setup phase installs HypAware and writes its managed telemetry settings
into `~/.claude/settings.json` before Claude starts. It also registers the
SessionStart and Stop hooks in that file, preserving other hook entries.
Anthropic caches files rather than running processes, so the SessionStart
hook starts the daemon each time a session starts or resumes.

Enrollment belongs in SessionStart: in the original cloud test, the session
could read the environment's token but enrollment attempted during setup had
not taken effect. The hook joins once, when the seed configuration is absent.
It also removes a stale PID file when its process is no longer a daemon.
The daemon refuses a second start while one is alive, and the surrounding loop
relaunches it only on exit code 75.

The Stop hook imports the transcript and runs `hyp sync --yes` 60 seconds
after the last reply. A newer reply resets that deadline, with one waiting
uploader held by `flock`. In the original test, two replies ten seconds apart
produced one upload 60 seconds after the second. This was needed because the
idle VM paused after about five minutes, before the configured hourly export.
Treat those pause and export timings as observations from that test.

The setup script exits successfully even if installation fails, so a failed
capture setup does not prevent the cloud session from starting. Check capture
explicitly after creating or changing the environment.

## Check recording and upload

After doing some work in the cloud session, ask Claude to run:

```sh
pgrep -fa "daemon run" | grep -v pgrep
tail -3 ~/.hyp/cloud-daemon.log
tail -2 ~/.hyp/hypaware/plugins/@hypaware/claude/session-context.jsonl
hyp query sql "select event_name, count(*) n from claude_telemetry_events group by event_name"
hyp query sql "select session_id, role, count(*) n from ai_gateway_messages group by session_id, role"
```

Check that one actual daemon is running. The relaunch shell may also appear
in the process listing. `session-context.jsonl` plus telemetry rows verifies
the live lane; conversation rows verify transcript capture. To verify delivery,
wait at least 60 seconds after the last reply, check for `upload after reply`
in `cloud-daemon.log`, and query that session on your HypAware server. A log
line alone proves an upload was attempted, not that the server accepted it.

If `hyp` or the daemon log is missing, installation or hook setup failed. If
the daemon log exists but `session-context.jsonl` is missing, the session
context hook did not run: telemetry is withheld until the working directory is
known, so transcript recovery is the remaining capture route.

## Tested behavior and limits

The original work recorded successful live telemetry and transcript capture in
a real cloud session. The October 14 script revision also recorded fresh-install
checks for repeated hook registration, one-time enrollment without a token in
the log, an existing daemon, stale PID recovery, and exit-75 relaunch. The
October 15 revision recorded the 60-second upload timing check.

The first seconds of telemetry can be lost while the SessionStart hook gets
the listener running; transcript recovery captures the conversation afterward.
Abrupt VM loss can still lose records that have not uploaded. The recipe does
not establish complete field parity, every launch mode, or recovery of history
that a replacement VM no longer has.

The tested script writes its daemon log continuously, so long sessions need
log-size monitoring. Its stale-PID check is the original Linux workaround;
concurrent starts and denied `/proc` reads have not been established as safe
by these historical checks. The current daemon's identity handling is tracked
in [issue 2583](https://github.com/hyparam/hypaware/issues/2583).

The hosted helper pins `hypaware@1.42.0`. Package upgrades require updating
and retesting the helper before publishing it. Editing the setup script
rebuilds the environment cache; it does not immediately reconfigure a running
session.
See [Anthropic's environment guide](https://code.claude.com/docs/en/cloud-environments)
for current environment controls and caching behavior.

For local Claude Code and Remote Control, see [Claude Code](claude-code.md).
For jobs whose lifecycle you control, see [CI and headless deployment](ci-and-headless.md).
