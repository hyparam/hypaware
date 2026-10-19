# LLP 0541: The auto-updater runs its own npm install

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, CLI, Config
**Author:** neutral
**Date:** 2026-10-18
**Extends:** LLP 0309 (#mechanism: corrects which code carries the
`npm install -g`; the mechanism itself is unchanged)
**Related:** issue #1026

## Context {#context}

[LLP 0309#mechanism](./0309-kernel-auto-update.decision.md#mechanism) says
the daemon runs `npm install -g <name>@<version>` "through the existing
durable-bin helper (`ensureDurableBinForNpx` lineage,
`src/core/cli/global_install.js`)". The code does not. The updater shares the
command with setup, not the helper, so a reader of 0309 is told the update
reuses code it never calls. That helper has since been renamed
`ensureDurableBin`, which makes the old name harder still to follow.

## Decision: where the install lives {#boundary}

The automatic update and `hyp update` both install through
`applySelfUpdate` in `src/core/update/self_update.js`. It spawns npm through
that module's own command runner: `npm config get prefix` to confirm the
running package root is the npm global install, then
`npm install -g <name>@<version>`, then the installed-version check and the
preflight of [LLP 0365](./0365-self-update-cannot-strand-the-daemon.decision.md).
The staged restart that follows is the one 0309 and 0365 describe.

`self_update.js` imports one supporting helper from `global_install.js`,
`isEphemeralBinPath`, to classify the running package root. It does not
update through `ensureDurableBin`, the durable-bin installer. That helper's
callers are the daemon installer (`src/core/daemon/install.js`) and the setup
wizard (`src/core/cli/wizard/index.js`), which use it to create the durable
global binary in the first place.

What 0309 settled still holds: the update is `npm install -g` of the global
package the service unit points at, with no self-managed install root, and a
failed install degrades to a status notice rather than a retry loop.

## Non-goals {#non-goals}

- No refactor to route the updater through the durable-bin helper so the code
  matches the historical name.
- No change to update policy, install verification, the preflight, or the
  staged restart.
- No change to the `auto_update` precedence of
  [LLP 0309#config-key](./0309-kernel-auto-update.decision.md#config-key): the
  cached effective value still wins once a boot has written it, including its
  pre-boot window over a newer local file, and the cache gains no field.
