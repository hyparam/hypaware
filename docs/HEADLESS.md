# Run HypAware headless (CI and servers)

Capture agent sessions on a machine with no browser and no interactive user:
a CI runner, a container, or a long-lived server. Enrollment happens with a
token minted ahead of time on your own machine, so the headless machine never
signs in.

Two things make headless different from a laptop install:

- **No browser sign-in.** Enrollment uses a pre-minted token with
  `hyp join` instead of `hyp remote login`.
- **No service manager.** Container runners usually lack launchd and
  systemd, so the daemon runs as a foreground process that your CI shell
  or supervisor backgrounds, via `hyp join --no-daemon` plus
  `hyp daemon run --foreground`.

Every run that joins with one token lands under **one shared gateway** on the
server, so a pipeline's runs stay grouped together. A token-based join
forwards immediately: there is no first-sync review hold, because whoever
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

The token never rotates. When it nears expiry, mint a new one and swap the
CI secret; nothing on the server needs cleanup.

## Each run: join, capture, flush

Three steps, all in the run's shell. The join URL is the server base (not a
`/v1/mcp` query URL), and the token goes in on standard input so it never
appears in `ps` output or `set -x` traces:

```sh
# setup
printf '%s' "$HYP_CI_TOKEN" | hyp join https://hyp.example.com --no-daemon
hyp daemon run --foreground &

# ... the job's agent steps run unchanged ...

# teardown: flush what the schedule has not exported yet
hyp sync --yes
```

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
          printf '%s' "$HYP_CI_TOKEN" | hyp join https://hyp.example.com --no-daemon
          hyp daemon run --foreground &
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
printf '%s' "$HYP_CI_TOKEN" | hyp join https://hyp.example.com
```

Without `--no-daemon`, join installs and starts the daemon under launchd or
systemd, and it survives reboots. In a container image or a host without a
service manager, keep `--no-daemon` and run `hyp daemon run --foreground` as
the entrypoint or under your own supervisor. No teardown flush is needed on a
machine that keeps running; the scheduled exports drain it. Flush with
`hyp sync --yes` before deliberately retiring the machine.

## Troubleshooting

- `hyp status` on the runner reports whether recording is active and which
  gateway the machine forwards to.
- `hyp remote mint` failing with HTTP 404 means the server predates the mint
  endpoint; upgrade the server.
- A join that hangs or exits nonzero usually means the URL is a query target
  (`.../v1/mcp`) rather than the server base, or the token has expired; mint
  a fresh token and retry.

Command details live in
[the CLI reference](./CLI_REFERENCE.md#hyp-remote-mint), and the enrollment
model for interactive machines in [the team setup guide](./TEAM_SETUP.md).
