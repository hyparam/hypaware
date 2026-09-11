# LLP 0397: installed client assets follow the update

**Type:** Decision
**Status:** Draft
**Systems:** Daemon, Plugins, Onboarding
**Author:** Brendan / Claude
**Date:** 2026-09-10
**Related:** LLP 0138 (#currency: the reconciler key this leaves alone, and its consequence that named `hyp skills install` as the only re-copy), LLP 0219 (#ledger, #edited-assets-are-not-ours: the record and the evidence this reads), LLP 0284 (#digests-are-per-path: how a shared destination is matched), LLP 0309 (#cadence: the update this rides), LLP 0365 (the restart onto the new version that this runs at), LLP 0107 (#every-attach: the manual path that stays)
**Extends:** LLP 0138, LLP 0309
**Extended-by:** LLP 0400 (#source-equality-is-ownership: widens #edited-copies-are-kept - a copy whose bytes match no recorded digest but do equal the current source is ours, not the user's, and its record is healed rather than the copy reported as an edit)

> The self-update replaces the package under a running daemon and restarts
> it, so the skill sources inside the package move on. The copies of those
> skills under `~/.claude/skills` and `~/.codex/skills` did not: they are
> plain files nothing re-read, and every install kept the stale text until
> the user ran `hyp skills install` by hand. This settles that the daemon the
> update restarts onto re-copies the installed assets whose source bytes
> changed, without touching a copy the user has edited.

## Context

Two settled decisions left this gap on purpose, for reasons that still hold:

- [LLP 0138 #currency](./0138-client-assets-one-install.decision.md#currency)
  keys the org reconciler's attach marker on the asset *set*: kind, name,
  client, destination. Its Consequences say why bytes were left out: the
  freshness predicate runs on every reconcile pass and must stay synchronous
  and disk-free, so a version bump that rewrites a skill in place never
  re-attaches, and `hyp skills install` is the way to force a copy.
- [LLP 0309](./0309-kernel-auto-update.decision.md) scopes the auto-update to
  the kernel package and the bundled plugins, applied through an npm install
  and the staged restart. It says nothing about the client's copies, and the
  update lane contains no code that names them.

The gap is wider than the reconciler case. A machine that never joined an org
has no central layer, so the reconciler is a no-op there and nothing at all
re-copies after an update. And on an enrolled machine the key does exactly
what 0138 says: an update that only rewrites `hypaware-query/SKILL.md`
produces the same key, the marker reads as current, and the stale copy stays.

The cost of the gap is that every skill fix ships to nobody until they run a
command they have no reason to know about. The fix that prompted this doc
(PR #1475, the graph column traps) reached no installed client on merge.

## Decision

**The booted daemon refreshes the installed client assets whose source bytes
changed, deciding each one by the install ledger.**

- **Refresh at boot, not in the update lane** {#refresh-at-boot}: the pass runs
  once per daemon boot, after plugin activation and before the tick loop, from
  `src/core/daemon/runtime.js`. An applied update exits through the staged
  restart and the service manager relaunches the daemon onto the new code, so
  the new daemon's boot is the first code that runs with the new sources on
  disk. Putting the copy there rather than in the updater means it also covers
  a hand-run `npm install -g` followed by a restart, needs no knowledge of
  which version was replaced, and takes the same inputs the attach handler
  already threads (client descriptors, `HOME`, the skill and agent
  registries) with the same inert cases: a non-gateway boot, no `HOME`, or no
  registries.
- **The ledger says which clients, the digests say which assets**
  {#ledger-decides}: the pass reads
  [LLP 0219 #ledger](./0219-retired-client-assets-are-pruned.decision.md#ledger)
  for the set of clients HypAware installed for, and plans the copies for
  those clients only. A client in the registries but not in the ledger has
  nothing of ours, and copying for it would turn a refresh into an attach the
  user never asked for. For each planned copy that has a ledger record, two
  digests decide: the bytes on disk must match a digest recorded for the
  path, and the source must digest differently from them. Both are taken by
  the ledger's own hasher, which hashes a tree relative to its root, so a
  source directory and its byte-identical copy produce one digest and an
  unchanged asset costs one read and no write.
- **Edited copies are kept, and named** {#edited-copies-are-kept}: a copy whose
  bytes match no recorded digest is the user's, by the same evidence
  [LLP 0219 #edited-assets-are-not-ours](./0219-retired-client-assets-are-pruned.decision.md#edited-assets-are-not-ours)
  uses before a prune, matched against every digest recorded for the path
  ([LLP 0284](./0284-recorded-digests-are-per-path.decision.md)). The pass
  skips it, warns in the daemon log with the path, and names
  `hyp skills install` as the way to replace it. A copy that is gone is not
  put back: removing it was a choice. A copy that cannot be read is treated
  as edited, never as absent.
- **Refresh never removes** {#refresh-never-removes}: pruning stays where
  LLP 0219 put it, on the materializer's install path. The rewrite itself is
  staged: the new bytes are copied to a sibling of the destination and
  renamed into place, so a copy that fails partway (a source tree half
  replaced by the update, a read error inside it) leaves the installed copy
  as it was. The install path's remove-then-copy would leave an empty
  directory, which the next boot reads as a user edit and never repairs. The
  swap of a directory is two renames, so there is a window in which the
  destination does not exist; the staging names are fixed rather than
  process-scoped and the pass restores the stepped-aside copy before it reads
  an absent destination as one the user removed, so a refresh killed inside
  the window costs a boot and not the installed skill. The same pass sweeps
  both staging names off a destination it finds in place, so a leftover never
  outlives the boot after it: left, it is a second complete copy of the skill
  under a name no ledger record covers, and one that outlived its boot would
  turn the restore into a resurrection of a destination the user deleted. A
  source that cannot be read at all is not a changed source: nothing is
  staged. Either failure is reported and the ledger record is carried
  unchanged, so the copy still sitting there stays prunable later.
- **The reconciler key is unchanged** {#reconciler-key-unchanged}: 0138's
  reason for leaving bytes out of the key was where the key is computed, not
  whether bytes matter. This pass is a separate step at a moment that has
  already touched the disk, so it can hash. Both paths copy the same bytes
  and both are idempotent, so their order at boot does not matter.

## Consequences

- `refreshClientAssets` joins `materializeClientAssets` in
  `src/core/runtime/client_assets.js`, reading the same planner and the same
  ledger, so which files a refresh may touch is derived from the one loop
  that installs them (LLP 0138 #one-materializer).
- The pass runs on every boot, not only after an update: a version gate would
  need a field the ledger does not have, and the work it saves is hashing a
  few dozen small files once per boot. Bounded by the ledger, not by uptime.
- A source tree that holds an entry the copier skips (a symlink, a device)
  never digests equal to its copy, so such an asset is re-copied on every
  boot. No shipped skill has one; the cost if one did is one small copy per
  boot, and the fix would be in the copier, not here.
- `hyp skills install` keeps the role
  [LLP 0107 #every-attach](./0107-skills-ride-attach.decision.md#every-attach)
  gives it: the way to re-copy on demand, and now also the way to replace a
  copy the refresh skipped as edited.
- Log events: `daemon.client_assets_refreshed` with the refreshed and skipped
  paths and the unchanged count, only when something was refreshed or
  skipped; `client_assets.refresh_skipped` and `client_assets.refresh_failed`
  per asset from the materializer's logger. A `hyp status` line for skipped
  copies is left for a later change.
