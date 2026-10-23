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

Enable the integration your job uses through organization configuration or
local client setup before running the agent. See the [Claude Agent SDK](#claude-agent-sdk)
section for that client's setup. Join writes enrollment settings; the daemon
then fetches configuration and starts capture. Before the agent step, use `hyp status` and `hyp client status <client>`
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

## Claude Agent SDK

The Claude Agent SDK runs Claude Code. HypAware can record it using the same
Claude integration on a workstation, CI runner, server, or in a container.
Run the SDK and HypAware as the same OS user with the same writable `HOME`.
This recipe runs the daemon alongside the application in the same environment;
it does not require a sidecar.

### Install and enable Claude capture

Install HypAware where the SDK runs. For a Docker image, add this before the
Dockerfile switches to a non-root user:

```dockerfile
RUN npm install -g hypaware@latest
```

HypAware requires Node 22.12 or newer. Build and publish the updated application
image using your normal build process.

Before the join/start sequence above, run this as the application's user at
runtime to enable Claude capture and configure its local settings and hooks:

```sh
hyp setup --client claude --export keep-local --no-daemon --no-backfill --yes
```

This enables capture and writes Claude settings and hooks under `HOME`. Keep
that home writable at runtime. The hooks execute HypAware inside the SDK's
environment to identify sessions and their working directories for privacy
rules. Installing the package alone does not start the daemon.

### Only change SDK settings if your app excludes user settings

**If your app omits `settingSources`, no change is needed with SDK 0.3.302,
which we tested.** If it already includes `'user'`, no change is needed either.

If your app explicitly sets `settingSources` without `'user'`, add it to the
existing list. For example, change `[]` inside your existing `query()` call:

```js
const response = query({
  prompt,
  options: {
    // Keep your existing options.
    // Replace settingSources: [] with:
    settingSources: ['user'],
  },
})
```

Keep other sources you already use: `['project']` becomes `['project', 'user']`.
User settings include `~/.claude/settings.json`, where HypAware configures
recording. Check your SDK version's settings behavior if using another release.

### Start capture before the SDK

Follow [join, capture, flush](#each-run-join-capture-flush). The startup script
runs inside the same container or host as the SDK. It must wait until the
daemon is healthy, Claude capture is enabled, and organization sync is
configured before starting the agent.

For a single-container application, copy the supplied
[`hypaware-start.mjs`](examples/claude-container/hypaware-start.mjs) into your
application's build directory. It performs setup and enrollment on a fresh
home, waits for capture readiness, and then runs the application command you
supply. You do not need to implement a readiness check yourself or run the
setup/join commands separately when using this helper.

For a Debian-based Node image, add these lines to your Dockerfile **before**
its `USER` instruction, alongside the HypAware installation above:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
COPY hypaware-start.mjs /app/hypaware-start.mjs
```

Replace the image's entrypoint with:

```dockerfile
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/hypaware-start.mjs"]
```

Keep your app's existing exec-form `CMD`, which becomes the helper's arguments.
For example, **only if your app starts with `node server.js`**:

```dockerfile
CMD ["node", "server.js"]
```

If your image has an existing entrypoint that performs necessary initialization,
preserve that work before invoking the helper. Other base images need their
own package-manager command to install `tini`.

Mount the enrollment token at `/var/run/hypaware/token`; the
[Kubernetes section](#kubernetes) shows how. The helper reads the same writable
HOME as the SDK. Use a dedicated home for this workload. On subsequent starts,
it reuses the setup and enrollment saved on that volume. Replacing the Secret
does not re-enroll an existing home: remove `<HYP_HOME>/.joined` and restart
when rotating the token (`HYP_HOME` defaults to `$HOME/.hyp`).

The helper checks `hyp status --json` for healthy daemon state, loaded
organization configuration, and active Claude capture, with a 90-second
startup deadline. If the app or daemon exits unexpectedly, it stops the other
process and ends the container. A daemon exit of 75 during startup is retried;
after app startup it triggers a container restart instead.

On shutdown it gives the application up to 30 seconds to finish active work,
allows five seconds for final telemetry processing, and attempts
`hyp sync --yes` before stopping the daemon. The app must handle SIGTERM by
stopping new work and finishing in-flight requests. Abrupt termination or
work exceeding those limits can still lose the tail; the flush is best effort.
It detects process exits, not a daemon that stays alive but becomes unhealthy.

For a finite CI job using its own shell script instead, keep the documented
[join, capture, flush](#each-run-join-capture-flush) sequence and implement the
readiness and failure cleanup there. The helper is the complete single-container
example tested with this guide.

### Updates in this container example

The helper preserves HypAware's default auto-update setting. In this container
layout, automatic updates cannot rely on a recognized service manager, and the
non-root app user cannot update the root-owned global npm installation. Rebuild
with `hypaware@latest` and deploy a new image tag to update. Ensure the build
reruns the npm installation instead of reusing its cached layer.

### Optional: inspect capture status

For troubleshooting, run these commands **inside the recording container or
host**:

```sh
hyp status
hyp client status claude
```

They show daemon health, Claude capture configuration, and sharing status.
For Kubernetes, use the `kubectl exec` commands in the section below to run
checks inside the container from your workstation.

### Confirm the conversation reached the server

Send a test request through your SDK app, then follow
[verify the upload](#verify-the-upload). Finding the test prompt and reply on
the server confirms recording and upload; a healthy status alone does not.

## Kubernetes

Use the same headless flow inside your application's container. Kubernetes
supplies the enrollment Secret and writable storage; agent-specific setup is
separate. For a Claude Agent SDK application, follow the
[SDK section](#claude-agent-sdk) as well.

The examples below are additions to your existing manifests, not a replacement
Deployment. **Replace every `<placeholder>` before running commands or applying
YAML.** Keep the other names as written, or change every matching reference.

| Placeholder | Your value |
|---|---|
| `<namespace>` | The namespace containing your application. |
| `<org>` | The HypAware remote name you use on your workstation. |
| `<workload-name>` | A label you choose for this recording host. |
| `<expiry-days>` | The desired token lifetime in days. |
| `<app-home>` | The app user's absolute HOME path. |
| `<app-gid>` | The app user's numeric group ID, without quotes. |
| `<storage-size>` | Requested storage, for example `1Gi`. |
| `<deployment>`, `<app-container>` | Your Deployment and application container names. |

### 1. Create the enrollment Secret

On your signed-in workstation, in a Bash or Zsh shell:

```sh
set -o pipefail
hyp remote mint <org> --label <workload-name> --expires-days <expiry-days> \
  | kubectl -n <namespace> create secret generic hypaware-join \
      --from-file=token=/dev/stdin
```

The pipe sends the token directly into the Secret; you do not paste it anywhere.
Confirm both commands succeeded before proceeding. Save the printed `gw-...`
host ID for verification. The Secret must be in the app's namespace.

### 2. Mount the token and writable storage

If the app already has a suitable persistent HOME volume, reuse it. Otherwise,
save the following as `hypaware-home.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: hypaware-home
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: <storage-size>
```

Create the claim in the application's namespace:

```sh
kubectl -n <namespace> apply -f hypaware-home.yaml
```

This uses the default storage class. If the cluster has none, add
`storageClassName: <storage-class>` under `spec`, replacing `<storage-class>`
with an available class name.

For this single-home example, use one replica and `strategy: { type: Recreate }`
on the Deployment. Remove `strategy.rollingUpdate` if present. Give each replica
its own home storage if you later scale out. `ReadWriteOnce` limits attachment
to one node, not one pod.

Merge these fields under `spec.template.spec`, preserving existing entries:

```yaml
securityContext:
  fsGroup: <app-gid>
volumes:
  - name: hypaware-home
    persistentVolumeClaim:
      claimName: hypaware-home
  - name: hypaware-join
    secret:
      secretName: hypaware-join
      defaultMode: 0440
```

Add these mounts to the existing application container's `volumeMounts`:

```yaml
- name: hypaware-home
  mountPath: <app-home>
- name: hypaware-join
  mountPath: /var/run/hypaware
  readOnly: true
```

Keep the app's existing user and `HOME`. Verify that this user can write the
home volume and read the token; PVC permission handling depends on the storage
driver. Mounting a new volume over HOME hides files supplied there by the image,
so preserve any settings the app already relies on.

Persistent storage keeps settings and pending recordings across pod replacement.
For a disposable Job, `emptyDir: {}` can replace `persistentVolumeClaim`, but
removing the pod then loses any data that has not uploaded.

### 3. Start capture and deploy

If using the SDK helper above, it reads the mounted token automatically.
For a different agent with its own startup flow, the enrollment command is:

```sh
hyp join https://api.hypaware.ai --token-file /var/run/hypaware/token --no-daemon
```

The SDK helper handles daemon startup and readiness for you. For other startup
scripts, follow [join, capture, flush](#each-run-join-capture-flush).

When using the helper, add `terminationGracePeriodSeconds: 60` under
`spec.template.spec` to allow its shutdown sequence to complete. Keep an app
readiness probe so traffic starts only after the app is listening.

Deploy the updated app image through your normal Kubernetes deployment process.
Keep any registry pull credentials your Deployment requires. Save your updated
Deployment as `<deployment-file>` and apply it:

```sh
kubectl -n <namespace> apply -f <deployment-file>
kubectl -n <namespace> rollout status deploy/<deployment>
```

Optionally check HypAware in
the application container:

```sh
kubectl -n <namespace> exec deploy/<deployment> -c <app-container> -- hyp status
```

After a test conversation, flush pending uploads:

```sh
kubectl -n <namespace> exec deploy/<deployment> -c <app-container> -- hyp sync --yes
```

Those commands target a Deployment. For a Job, put readiness and the final flush
in the job's script, including its failure cleanup, before the container exits.

Finish by [verifying the upload](#verify-the-upload) from your workstation.

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

After the workflow finishes, [verify the upload](#verify-the-upload) from your
signed-in workstation.

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

After a test conversation, [verify the upload](#verify-the-upload).

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

## Collect as an organization service account

A service-account token (it starts with `hsa_`) is created in HypAware by an
organization admin and belongs to the organization, not to a person. A host
joined with one uploads as that account and keeps working when the person who
set it up leaves. Run it in its own environment: on a person's machine the same
join would replace that machine's enrollment.

<!-- @ref LLP 0547#provision: the documented collector setup is the shipped join in its own HYP_HOME -->
```sh
export HYP_HOME=/srv/hypaware-collector   # its own state root, never a person's
install -d -m 700 "$HYP_HOME"
printf '%s' "$HYP_SERVICE_TOKEN" | hyp join https://api.hypaware.ai - --no-daemon
hyp daemon install    # or, under your own supervisor: hyp daemon run
```

The token is read from standard input, so it never appears in shell history or
the command's arguments. If your secret store mounts it as a file instead,
create the file private from the start and join from it:

```sh
rm -f "$HYP_HOME/.service-token"
(umask 077; printf '%s' "$HYP_SERVICE_TOKEN" > "$HYP_HOME/.service-token")
hyp join https://api.hypaware.ai --token-file "$HYP_HOME/.service-token" --no-daemon
```

`hyp join` reads the file and does not keep or change it; you can delete it
after the join. Join keeps its own private copy (mode `0600`) at
`$HYP_HOME/hypaware/plugins/@hypaware/central/service-token`, which is what the
daemon uses to sign in again on its own when its session expires. The join also
writes the token into its private config seed under
`$HYP_HOME/hypaware/config-control/`; the first config the host applies keeps
that seed as its rollback copy, and the next config update replaces it.
HypAware never logs the token.

To query your organization's data as the service account, store the same
token for the built-in `hypaware` target. That target is HypAware Cloud
(`https://api.hypaware.ai`), so if you joined your own server instead, first
point it at that server, in the same `HYP_HOME`, so queries go to the server
the host joined:

```sh
hyp remote add hypaware https://hyp.example.com   # your own server only; skip for HypAware Cloud
```

Then log in and query:

```sh
hyp remote login hypaware --token-file "$HYP_HOME/.service-token"
hyp query sql "select count(*) from ai_gateway_messages" --remote hypaware
```

The login stores the token, with the short-lived session it exchanges it for, in
`$HYP_HOME/hypaware/remote-credentials.json` (mode `0600`); `hyp remote remove
hypaware` removes it.

When the token is revoked or the account is disabled, the host stops uploading
and does not retry: the stop is written into the kept copy, so a restart stays
stopped, and `hyp status` reports `stopped: service token revoked` (or `service
account disabled`). Queries fail with the same reason, but nothing records it,
so each later query whose session has expired asks the server again. Create a
new token in HypAware and run the join again; for queries, run `hyp remote
login hypaware --token-file` with the new token. `hyp leave` removes the kept
copy.

To confirm a test conversation arrived, [verify the upload](#verify-the-upload).

Command details live in
[the CLI reference](../CLI_REFERENCE.md#hyp-remote-mint).

## Verify the upload

From a workstation signed in to your organization, query the host ID printed by
`hyp remote mint`. Replace `<org>`, `<host-id>`, and `<date>` with your remote
name, `gw-...` host ID, and the test's UTC date in `YYYY-MM-DD` format:

```sh
hyp query sql "SELECT session_id, role, substr(content_text, 1, 120) AS text
  FROM ai_gateway_messages
  WHERE gateway_id = '<host-id>' AND date = '<date>'
  ORDER BY message_created_at DESC LIMIT 20" --remote <org>
```

Confirm that your test prompt and reply appear. Allow time for server ingestion
if an immediate query is empty. `hyp status` showing Sync confirms the sharing
configuration; it does not prove that a particular conversation was uploaded.
