# LLP 0612: The Claude Desktop managed-profile commands and `@hypaware/claude-account` are removed

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, CLI, Onboarding
**Author:** Brendan / Claude
**Date:** 2026-11-17
**Extends:** LLP 0358 (the profile and install commands it kept as an optional experiment are removed; transcript capture is unchanged), LLP 0248 (#tree: `client claude-account ...` and `client claude-desktop ...` leave the tree)
**Supersedes:** LLP 0117 (the credential plugin), LLP 0133 (the sudo-placed managed plist), LLP 0116 (the client-presented credential helper), as far as each describes shipped behaviour
**Related:** LLP 0140 (#manifest-declares-ownership: what `@hypaware/claude-desktop` still does), LLP 0115, LLP 0131, LLP 0139, LLP 0393 (#contract: nine command names leave the finite vocabulary)

> Claude Desktop is captured by a scheduled transcript import (LLP 0358).
> The older route, which pointed Desktop's inference at the local gateway
> through a managed profile, a credential helper and a root-owned plist, was
> kept as an optional experiment. It is unreachable on a normal install and
> is now removed, along with the credential plugin that existed only for it.

## Context {#context}

`hyp client claude-desktop install|install-helper|profile|status|verify` all
required the `hypaware.anthropic-credential` capability, which only
`@hypaware/claude-account` provides. That plugin is excluded from default
activation and no setup path composes it, so on an install made through
`hyp setup` every one of the five commands stopped with "managed-profile
commands require @hypaware/claude-account". Reaching them took a hand edit to
`plugins[]`. Desktop capture itself has not depended on any of this since
LLP 0358.

## Decision {#decision}

- `@hypaware/claude-account` is removed from the package: its commands
  (`client claude-account login|logout|status`, the hidden
  `claude-account credential`), its capability and its config.
- `@hypaware/claude-desktop` registers no commands. It keeps what capture
  uses: the `claude-desktop` client declaration with its transcript
  entrypoints (LLP 0140) and the picker row (LLP 0358 #onboarding).
- The plugin's `claude_desktop` config section is still accepted, so an
  existing config that carries one validates. Nothing reads its keys.

### Consequences {#consequences}

- A config that names `@hypaware/claude-account` now fails
  `hyp config validate` with `plugin_unknown`. Remove the entry.
- A machine where `hyp client claude-desktop install` completed still has
  `/Library/Managed Preferences/com.anthropic.claudefordesktop.plist` and a
  credential wrapper that runs `hyp claude-account credential`. That command
  no longer exists, so Desktop's inference through the profile stops working
  on such a machine until the plist is removed with `sudo rm`. HypAware never
  had a command that removed it. To clean up:
  `sudo rm '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist'`,
  then restart Claude Desktop.
- The credential files stay on disk:
  `~/.hyp/hypaware/plugins/@hypaware/claude-account/credentials.json`, which
  can hold a live refresh token, and
  `~/.hyp/hypaware/plugins/@hypaware/claude-desktop/credential-helper.sh`. The
  removed `client claude-account logout` was the only command that deleted the
  token file, so remove both by hand:
  `rm ~/.hyp/hypaware/plugins/@hypaware/claude-account/credentials.json ~/.hyp/hypaware/plugins/@hypaware/claude-desktop/credential-helper.sh`.
  In `org_key` mode the key sits in the config instead; remove `api_key` from it.
- No live capture path for Desktop remains; sessions arrive on the five-minute
  import.

### Telemetry {#telemetry}

`claude-account credential`, `client claude-account login|logout|status` and
`client claude-desktop install|install-helper|profile|status|verify` leave
the finite command vocabulary of LLP 0393 #contract. A receiver should keep
them for clients released before this change.
