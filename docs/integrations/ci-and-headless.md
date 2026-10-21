# CI and headless deployment

**Status:** Supported. Records whichever supported agent the job runs.

Capture AI client sessions on a host with no browser and no interactive user:
a CI runner, a container, or a long-lived server. Enrollment happens with a
token minted ahead of time on your own host, so the headless host never
signs in.

Two things make headless different from an interactive install:

- **No browser sign-in.** Enrollment uses a pre-minted token with
  `hyp join` instead of `hyp remote login`.
- **No service manager.** Container runners usually lack launchd and
  systemd, so the daemon runs as a foreground process that your CI shell
  or supervisor backgrounds, via `hyp join --no-daemon` plus
  `hyp daemon run`.

Every run that joins with one token lands under **one shared host** in
HypAware Cloud, so a pipeline's runs stay grouped together. A token-based join
syncs immediately: there is no first-sync review hold, because whoever
minted the token chose enrollment deliberately. See
[what HypAware records and how to control it](../PRIVACY.md).

## One-time: mint a token

On your own host, where you are signed in (`hyp remote login`):

```sh
hyp remote mint
```

This prints the token **once**; store it in your CI secret store immediately
(the examples below call it `HYP_CI_TOKEN`). Only the token goes to standard
output, so `hyp remote mint > ci.token` captures exactly the secret. Options:

- `--label <label>` names the host the token is bound to, for example the
  pipeline name.
- `--expires-days <n>` overrides the 365-day default expiry.

The token never rotates. When it nears expiry, mint a new one and swap the CI
secret. Minting binds a **new host record** at mint time (the id is printed on
standard error next to the token), so runs before and after the swap group
under different hosts, and the old record stays in place in HypAware Cloud.
The id is shown as gateway in the current CLI output; this is the host record.

## Each run: join, capture, flush

Three steps, all in the run's shell. The join URL is the HypAware Cloud base
URL (not a `/v1/mcp` query URL). These examples use the hosted Cloud endpoint;
use your server's base URL for a self-hosted deployment. Pipe the token to avoid
putting it in the command's arguments, and keep shell tracing disabled around
secret handling:

```sh
# setup
printf '%s' "$HYP_CI_TOKEN" | hyp join https://api.hypaware.ai --no-daemon
# Exit 75 is a restart request (the org config just arrived): run it again.
# Any other exit ends the loop with the daemon's own status.
( rc=75; while [ "$rc" -eq 75 ]; do hyp daemon run && rc=0 || rc=$?; done; exit "$rc" ) &

# Check that the daemon and required integration are ready before running the agent.
hyp status

# ... run the job's agent steps ...

# teardown: flush what the schedule has not exported yet
hyp sync --yes
```

The organization configuration must enable the integration your job uses. Join
writes enrollment settings; the daemon then fetches configuration and starts
capture. Before the agent step, use `hyp status` and `hyp client status <client>`
to check readiness and apply any required client settings. Starting the process
with `&` alone does not prove capture is ready. Status is a diagnostic snapshot,
not a command that waits for readiness; adapt the job to check its required
integration before starting the agent.

LangGraph applications also need their callback configured on the remote host.
Follow the [remote LangGraph recipe](langgraph.md#remote-hosts-and-hypaware-cloud)
for setup, journal placement and a server-side SQL check after upload.

> **Note:** The teardown step matters. Sinks export on a schedule, and the most valuable
> rows land when the agent session ends, seconds before the runner dies, so no
> schedule can be trusted to drain the tail. Always run `hyp sync --yes` as the
> final step, including on failed jobs.

## GitHub Actions example

```yaml
jobs:
  agent:
    runs-on: ubuntu-latest
    env:
      HYP_CI_TOKEN: ${{ secrets.HYP_CI_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Start HypAware capture
        run: |
          npm install -g hypaware
          printf '%s' "$HYP_CI_TOKEN" | hyp join https://api.hypaware.ai --no-daemon
          ( rc=75; while [ "$rc" -eq 75 ]; do hyp daemon run && rc=0 || rc=$?; done; exit "$rc" ) &
          hyp status
          # Verify the required integration is ready before the next step.
      - name: Run the agent
        run: |
          # the job's agent steps, e.g.
          # claude -p "review the diff"
      - name: Flush captured rows
        if: always()
        run: hyp sync --yes
```

> **Tip:** `if: always()` runs the flush even when the agent step fails, which is often
> the run you most want recorded. HypAware requires **Node 22.12 or newer**.

## Long-lived headless hosts

A server or VM that outlives one job uses the same join, but lets the daemon
install as a real service where one is available:

```sh
printf '%s' "$HYP_CI_TOKEN" | hyp join https://api.hypaware.ai
```

Without `--no-daemon`, join installs and starts the daemon under launchd or
systemd. Both are per-user services, not system ones: on Linux it is a systemd
**user** unit, so a headless host needs `loginctl enable-linger <user>` for it
to start at boot and to survive the last session logging out, and on macOS it
is a LaunchAgent, which needs a logged-in user session. In a container image or a host without a
service manager, keep `--no-daemon` and run `hyp daemon run` as
the entrypoint or under your own supervisor, and relaunch it when it exits
with code 75. No teardown flush is needed on a
host that keeps running; the scheduled exports drain it. Flush with
`hyp sync --yes` before deliberately retiring the host.

### Headless troubleshooting

- `hyp status` on the runner reports whether recording is active, and what is
  shared with your team versus kept on the host.
- `hyp remote mint` failing with HTTP 404 can mean the server does not support
  token minting or the target points at the wrong server. Mint uses the target's
  origin, so check the scheme and hostname as well as server support.
- A missing token at a terminal, or an empty pipe that reaches EOF, produces an
  error. A pipe left open can leave join waiting for input.
- Join validates the URL and nonempty token locally; it does not authenticate
  with the server. A syntactically valid query-target URL (`.../v1/mcp`) or an
  expired token can therefore fail later when the daemon connects.

Command details live in
[the CLI reference](../CLI_REFERENCE.md#hyp-remote-mint).
