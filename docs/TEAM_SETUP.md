[← All documentation](README.md)

---

# Connect to HypAware Cloud and your team

Get an organization in HypAware Cloud, then set up each machine to join it.

## Contents

- [Get an organization](#get-an-organization)
- [Connect a machine](#connect-a-machine)
- [Follow the prompts](#follow-the-prompts)
- [Review before the first upload](#review-before-the-first-upload)
- [Verify the setup](#verify-the-setup)
- [Send recordings now](#send-recordings-now)
- [Manage remote access](#manage-remote-access)
- [Disconnect a machine](#disconnect-a-machine)
- [CI and headless deployment](#ci-and-headless-deployment)
- [One-time: mint a token](#one-time-mint-a-token)
- [Each run: join, capture, flush](#each-run-join-capture-flush)
- [GitHub Actions example](#github-actions-example)
- [Long-lived headless machines](#long-lived-headless-machines)

## Get an organization

You can sign in to HypAware Cloud and sync your own machines without setting
up a team.

For a team, [contact us](https://hypaware.ai/contact?utm_medium=docs) to set up
an organization for your email domain. Teammates join automatically when they
sign in with a verified email address from that domain.

## Connect a machine

[Install HypAware](CLI.md#install-hypaware), then select **Sync to the cloud**
in `hyp setup`. If you already configured local capture, either run `hyp setup`
and switch to Cloud collection, or run `hyp remote login` to enroll without
repeating the client choices.

## Follow the prompts

The setup guides you through the remaining steps and reports what it is
doing at each one:

1. **Sign in.** A browser window opens for sign-in with your work email.
   This completes enrollment: your organization is identified from your
   email address, so there are no codes or keys to enter.
2. **Set up recording.** **Record and sync everything** accepts the default
   client and folder choices. Setup names the clients, explains what will be
   recorded and shared, and continues. **Customize** lets you change those
   choices on the screens below. Later prompts can still ask about importing
   history, uploading now, GitHub sign-in, or trying a skill.

### If you choose Customize

Two main screens let you choose clients and folder handling. Enter accepts the
selected answer. Depending on the client choices, setup can also ask for consent
to import existing history.

1. **Choose what to collect and sync.** A checklist of AI clients. Clients your
   team manages are selected and locked. On a first run, detected clients are
   preselected; reconfiguration starts from your saved choices. A checked client
   is recorded here *and* shared with HypAware Cloud. Completing setup clears any
   standing `hyp privacy client <name> local-only` for the clients on it;
   canceling before setup commits preserves those settings.
   `hyp privacy client` changes them afterward.
2. **Choose how new folders are handled.** Whether recording in a project
   you have not worked in before syncs without asking, or asks you the
   first time. This is a standing preference; `hyp privacy folders`
   changes it later.

### After the questions

Both answers arrive here, so this applies whichever one you gave.

Setup installs the components, imports eligible history, and offers to upload
recordings. Review the first-sync behavior below before accepting that prompt.

## Review before the first upload

Setup asks `Upload now? [Y/n]`. Choose **n** to review your recordings first.
Pressing Enter chooses Yes and uploads them immediately.

On your first browser sign-in, HypAware normally pauses uploads until 11:59pm
local time. If fewer than four hours remain, it waits until 11:59pm the next day.
Check `hyp status` to confirm that uploads are paused and see the deadline.

Before that deadline, ask Claude Code or Codex to run the `hypaware-privacy`
skill. It helps you review recordings and choose which folders to keep private.
See [privacy review](./PRIVACY.md#review-before-the-first-cloud-sync).

When you are ready, run `hyp sync` to upload. Otherwise, uploads start when the
pause expires.

This review period applies to first-time browser sign-in. Signing in again or
using `hyp join` with a token does not pause uploads. For unattended installs,
set privacy controls before connecting; see [headless setup](#ci-and-headless-deployment).

## Verify the setup

```sh
hyp status
```

This reports whether recording is active, what is shared with your team
versus kept on your machine, and any pending first-sync deadline. To disconnect
from Cloud while retaining local capture, use [disconnect a machine](#disconnect-a-machine).

## Send recordings now

Sync runs on a schedule. To inspect the destinations and exclusions before
sending eligible recordings now:

```sh
hyp sync --dry-run
hyp sync
```

`hyp sync` asks for confirmation. Local-only and ignored data remain excluded.
An all-destination confirmed sync can release the first-sync review hold early.
For replaying previously withheld history, see the
[sync reference](CLI_REFERENCE.md#hyp-sync).

<!-- @ref LLP 0471#manual-work: manual progress belongs to one awaited destination at a time -->
The command sends to selected destinations one at a time and waits for each
result. Cloud upload progress counts acknowledged rows; `Finishing` can still
mean HypAware is saving export progress locally. Read each destination's final
result before ending the process. A partial result can leave work to retry;
the exit code alone does not prove every destination finished.

<!-- @ref LLP 0471#daemon-work: scheduled destinations and daemon health work progress independently -->
Scheduled exports run independently by destination. A slow Cloud upload does
not make the local file export wait for it, or hold up recording recovery
sweeps and status updates. Repeated schedule fires for a busy destination
request one follow-up run rather than building a queue of exports.

For timeouts, unresolved warnings and retained error history, see
[export troubleshooting](TROUBLESHOOTING.md#an-export-or-team-sync-is-missing).

## Manage remote access

```sh
hyp remote list
hyp remote login <target> --no-forward
```

`--no-forward` grants query access without enrolling this machine for sync.
Use `hyp remote add` to configure
another target; see the [remote reference](CLI_REFERENCE.md#manage-remote-query-targets)
for its URL and credential options. For remote searches and SQL, see
[queries](QUERYING.md#query-a-remote-target).

## Disconnect a machine

```sh
hyp leave
```

This stops Cloud sync and configuration pull, reverses organization-managed
client attaches, and removes the sync credential. Local configuration,
recordings, the background service, and remote query sign-ins remain. Use
`hyp remote remove <name>` separately to remove a query target and its stored
sign-in. For deletion, see
[privacy](PRIVACY.md#deleting-what-was-already-recorded); for uninstall, see
[setup](CLI.md#uninstall).

## CI and headless deployment

Capture AI client sessions on a machine with no browser and no interactive user:
a CI runner, a container, or a long-lived server. Enrollment happens with a
token minted ahead of time on your own machine, so the headless machine never
signs in.

Two things make headless different from a laptop install:

- **No browser sign-in.** Enrollment uses a pre-minted token with
  `hyp join` instead of `hyp remote login`.
- **No service manager.** Container runners usually lack launchd and
  systemd, so the daemon runs as a foreground process that your CI shell
  or supervisor backgrounds, via `hyp join --no-daemon` plus
  `hyp daemon run`.

Every run that joins with one token lands under **one shared gateway** in
HypAware Cloud, so a pipeline's runs stay grouped together. A token-based join
syncs immediately: there is no first-sync review hold, because whoever
minted the token chose enrollment deliberately. See
[what HypAware records and how to control it](./PRIVACY.md).

## One-time: mint a token

On your own machine, where you are signed in (`hyp remote login`):

```sh
hyp remote mint
```

This prints the token **once**; store it in your CI secret store immediately
(the examples below call it `HYP_CI_TOKEN`). Only the token goes to standard
output, so `hyp remote mint > ci.token` captures exactly the secret. Options:

- `--label <label>` names the gateway the token is bound to, for example the
  pipeline name.
- `--expires-days <n>` overrides the 365-day default expiry.

The token never rotates. When it nears expiry, mint a new one and swap the CI
secret. Minting binds a **new gateway row** at mint time (the id is printed on
standard error next to the token), so runs before and after the swap group
under different gateways, and the old row stays in place in HypAware Cloud.

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

The teardown step matters. Sinks export on a schedule, and the most valuable
rows land when the agent session ends, seconds before the runner dies, so no
schedule can be trusted to drain the tail. Always run `hyp sync --yes` as the
final step, including on failed jobs.

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

`if: always()` runs the flush even when the agent step fails, which is often
the run you most want recorded. HypAware requires **Node 22.12 or newer**.

## Long-lived headless machines

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
machine that keeps running; the scheduled exports drain it. Flush with
`hyp sync --yes` before deliberately retiring the machine.

### Headless troubleshooting

- `hyp status` on the runner reports whether recording is active, and what is
  shared with your team versus kept on the machine.
- `hyp remote mint` failing with HTTP 404 can mean the server does not support
  token minting or the target points at the wrong server. Mint uses the target's
  origin, so check the scheme and hostname as well as server support.
- A missing token at a terminal, or an empty pipe that reaches EOF, produces an
  error. A pipe left open can leave join waiting for input.
- Join validates the URL and nonempty token locally; it does not authenticate
  with the server. A syntactically valid query-target URL (`.../v1/mcp`) or an
  expired token can therefore fail later when the daemon connects.

Command details live in
[the CLI reference](./CLI_REFERENCE.md#hyp-remote-mint).
