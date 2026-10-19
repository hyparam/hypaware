# Connect to HypAware Cloud and your team

Get an organization in HypAware Cloud, then set up each host to join it. A host is any machine the collector runs on: a laptop, a build box, a remote agent's box.

## Get an organization

You can sign in to HypAware Cloud and sync your own hosts without setting
up a team.

For a team, [contact us](https://hypaware.ai/contact?utm_medium=docs) to set up
an organization for your email domain. Teammates join automatically when they
sign in with a verified email address from that domain.

## Connect a host

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

> **Caution:** Setup asks `Upload now? [Y/n]`. Choose **n** to review your recordings first.
> Pressing Enter chooses Yes and uploads them immediately.

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
set privacy controls before connecting; see [headless setup](integrations/ci-and-headless.md).

## Verify the setup

<!-- agent: Run hyp status and tell me whether recording is active, what is shared with my team versus kept local, and whether a first-sync deadline is pending. -->
```sh
hyp status
```

This reports whether recording is active, what is shared with your team
versus kept on your host, and any pending first-sync deadline. To disconnect
from Cloud while retaining local capture, use [disconnect a host](#disconnect-a-host).

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

`--no-forward` grants query access without enrolling this host for sync.
Use `hyp remote add` to configure
another target; see the [remote reference](CLI_REFERENCE.md#manage-remote-query-targets)
for its URL and credential options. For remote searches and SQL, see
[queries](QUERYING.md#query-a-remote-target).

## Disconnect a host

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
