# LLP 0099: The dispatch-miss repair line branches on *why* a plugin is inactive

**Type:** decision
**Status:** Accepted
**Systems:** CLI
**Generated-by:** neutral
**Date:** 2026-07-10
**Related:** LLP 0098, LLP 0031

> LLP 0098 settled that a dispatch miss on a known-but-inactive plugin command
> reports "unavailable + repair" rather than "unknown", with a single repair
> line: `add {"name": "<plugin>"} to plugins[]`. That advice is correct only
> when the plugin is *absent* from `plugins[]` (issue #294's scope). When the
> effective config already contains `{"name": "<plugin>", "enabled": false}`
> the entry lands in the boot pool but not the selected set, the miss path
> still fires, and the "add it" advice is wrong: the entry already exists
> ([issue #297](https://github.com/hyparam/hypaware/issues/297)). This decision
> extends LLP 0098's repair wording so it depends on *why* the plugin is
> inactive.

## Decision

This **extends** LLP 0098 (@ref LLP 0098 [constrained-by] - the first output
line and the exact-match, inactive-only, boot-selection-reuse constraints are
unchanged). Only the second (`repair:`) line changes: the miss path now
classifies the inactive plugin into one of three states and emits the matching
repair.

- **`absent`** - the plugin does not appear in the effective `plugins[]`. This
  is LLP 0098's original case and its wording is preserved **byte-identical**:

  ```
    repair: add {"name": "@hypaware/context-graph"} to plugins[] in ~/.hyp/hypaware-config.json
  ```

- **`disabled-local`** - the effective `plugins[]` contains the entry with
  `enabled: false`, and the entry belongs to the user-owned **local** layer.
  The entry already exists, so the repair is to flip it, not add a duplicate:

  ```
    repair: set "enabled": true on the {"name": "@hypaware/context-graph"} entry in plugins[] in ~/.hyp/hypaware-config.json
  ```

- **`disabled-central`** - the effective disabled entry belongs to the
  server-owned **central** layer. Under the additive merge model
  (@ref LLP 0031#merge-model [constrained-by] - the whole central document wins
  and locks; a local entry whose name central already declares is dropped as
  `collides_with_central`), the user cannot enable a fleet-disabled plugin from
  the local file. The repair says so instead of sending them to edit a local
  entry the merge would silently drop:

  ```
    repair: @hypaware/context-graph is disabled by the fleet (central) config and cannot be enabled locally; ask your fleet admin to enable it
  ```

## Why classification is cheap and correct

- **The disabled entry belongs to central iff central declares its name.** The
  merge keys `plugins[]` by name; a local entry colliding with a central name
  is dropped, so the surviving effective entry is central's whenever central
  declares that name and local's otherwise. Testing membership in
  `centralConfig.plugins` is therefore an exact discriminator - no separate
  provenance tracking is needed (@ref LLP 0031#merge-model [constrained-by]).
- **No extra I/O.** The miss path already resolves the layered config via the
  same `computeBootSelection` that `--help` synthesis and LLP 0098's lookup
  use; classification reads the effective and central documents that resolution
  already returns.
- **`absent` stays the default.** Any state that is not a present-with-
  `enabled: false` entry (missing entry, or an entry not disabled) falls back
  to `absent`, so a plugin the config simply omits keeps LLP 0098's output.

## Not a broken repair, only misleading wording

Following the old "add it" advice never hard-fails - plain CLI boot does not
enforce `validateConfig`. On a fleet-joined host the local addition is dropped
(`collides_with_central` / `invalid_merge`); on a never-joined host a duplicate
`plugins[]` entry coexists and the plugin activates, but `hyp config validate`,
init, and daemon-apply flag `duplicate_plugin`. So this decision refines
wording; it does not change any activation or merge behaviour.

## Rejected alternatives

- **Keep the single "add it" line for every inactive state.** Rejected: on a
  disabled entry it tells the user to add a duplicate of a line that already
  exists, and on a fleet-disabled plugin it points at a local edit the merge
  will drop - misleading in exactly the cases a repair hint is supposed to fix.
- **Print the local-enable advice for the central case too.** Rejected: it
  reads as "edit your local file to fix this" when the additive merge model
  guarantees that edit is a no-op; the central case must name the fleet as the
  owner (LLP 0031).
