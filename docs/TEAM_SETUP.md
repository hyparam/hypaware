# Running HypAware across a team

This guide is for the person rolling HypAware out to a team: getting an
organization on the central server, onboarding machines, managing the fleet
config, and capturing Claude Desktop. For a single machine with no server,
the [README quickstart](../README.md#quickstart-solo-fully-local) is all you
need.

## What team mode gives you

Each enrolled machine keeps its full local install (local cache, local
queries, daemon) and additionally forwards its recordings to your
organization's central server. On top of that you get:

- **Cross-team queries**: `hyp query sql "..." --remote` answers over the
  whole org's recordings, from any signed-in machine.
- **Usage reporting**: the bundled `hypaware-ai-usage-report` skill writes
  a manager-readable review of who uses AI, on what work, and where tokens
  are wasted. Related skills cover security review and improvement
  suggestions.
- **Central config**: the server can manage plugin and sink settings for
  the fleet, so machines stay consistent without hand-edited config.

## 1. Get an organization

Organizations are hosted on the central server and keyed by email domain:
anyone who signs in with a verified email on your claimed domain lands in
your organization automatically.

> **[Get in touch](https://hypstack.ai/)** and we will set up an
> organization for your domain. Once it exists, onboarding each machine is
> the single command below; there is nothing else to distribute.

## 2. Onboard machines

### Attended: `hyp remote login`

For machines with a human at the keyboard, one command does everything:

```sh
npx hypaware remote login
```

It opens a browser sign-in, resolves the organization from the email
domain, provisions the forwarding sink, stores a per-machine credential
(mode `0600`), installs the daemon, and starts capturing and forwarding.
If an email maps to more than one organization, pass `--org <name>`.

Nothing ships immediately: the first sync waits until at least 11:59pm
local time, giving the user a review window. Point every teammate at
[what HypAware records and how to control it](./PRIVACY.md) as part of the
rollout announcement; the short version is "run the `hypaware-privacy`
skill before tonight".

### Unattended: `hyp join`

For scripted rollouts (MDM, dotfiles, CI images) where no browser is
available, `hyp join` enrolls with a fleet policy token instead:

```sh
hyp join <url> --token-file <path>
```

The policy token is a multi-use, fleet-wide credential issued with your
organization. Distribute it through your device-management secret channel
and prefer `--token-file` or stdin; a positional token lands in shell
history and process listings.

## 3. Fleet-managed config

Enrollment writes a central-enrollment layer under
`<HYP_HOME>/config-control/`, separate from the machine's own
`hypaware-config.json`. The two are layered: joining augments an existing
local install rather than replacing it, and the server-managed layer wins
for the keys it manages (plugins, sinks, client attaches). The org config
can, for example, attach Claude Code and Codex automatically on every
enrolled machine.

A user can inspect the result with `hyp status` (which reports the active
config path, attach state, and sink rows) and can disconnect at any time
with `hyp leave`, which stops forwarding and config pull, undoes
org-driven attaches, and removes the forward credential.

## 4. Capturing Claude Desktop (macOS, managed fleets)

Claude Code and Codex attach by editing their settings files. Claude
Desktop has no such file: its inference config is only reachable through
org-managed configuration, so Desktop capture is a fleet feature, deployed
through your device management (MDM), not something an individual can
switch on.

Prerequisites:

- The fleet's gateway must listen on the fixed default endpoint
  (`127.0.0.1:18521`) or another explicitly configured stable address. A
  fleet config that pins port `0` (ephemeral) cannot serve Desktop.
- The `@hypaware/claude-desktop` plugin renders the profile; the
  `@hypaware/claude-account` plugin owns the Anthropic credential. The
  credential kind is a fleet-policy switch: a static org API key
  (API-billed, zero per-user setup) or each person's own Claude
  subscription (requires a one-time per-user sign-in).

Rollout:

```sh
hyp claude-desktop install-helper       # write the no-arg credential wrapper the profile points at
hyp claude-desktop profile              # render the managed profile as JSON
hyp claude-desktop profile --plist      # or as a plist dict for MDM distribution
hyp claude-desktop status               # inspect the resolved endpoint, credential mode, helper, models
```

The rendered profile carries no secret: it points Desktop at the local
gateway and at the credential helper on disk. Your device management
distributes it to endpoints as the app's managed settings (the
`com.anthropic.claudefordesktop` managed preferences domain). Desktop
traffic then flows through the gateway and is recorded with
`client_name: "claude-desktop"`, so it stays distinguishable from Claude
Code in queries and reports.

## 5. Verify a machine

```sh
hyp status                                                    # daemon, attaches, sinks, diagnostics
hyp query sql "select count(*) from ai_gateway_messages"      # local capture is landing
hyp query sql "select count(*) from ai_gateway_messages" --remote   # the server sees the org
```

`hyp remote list` shows the configured targets and whether a credential is
stored (it never prints the token).
