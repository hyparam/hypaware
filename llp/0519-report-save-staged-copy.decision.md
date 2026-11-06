# LLP 0519: `hyp report save` copies into a hidden staging folder and renames it into place

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports
**Author:** HypForge / Claude
**Date:** 2026-10-17
**Extends:** LLP 0465 (#move: supersedes its failed-copy clause only; move by default, removal bounded to what was copied, and `--keep` stand)
**Related:** PR #2535 (review finding 4, deferred), issue #2541

> LLP 0465 #move said a copy that fails midway leaves the partial slot in
> the store, named in the error. A partial slot is visible: `list --local`
> shows it and `publish <name>` sends it. `save` now copies into a hidden
> folder in the store and renames it over the slot only once every page
> has landed, so a failed save leaves nothing to list or publish.

## Context {#context}

Review of PR #2535 found that the slot is claimed before the copy. A copy
that fails on a later page (a full disk, say) leaves a folder under the
report's own name holding `report.md` and some of its pages. That folder
passes every `list` rule in LLP 0465 #list, so it is listed as a saved report
and publishes by name as an incomplete one. The draft is untouched, so the
retry also lands at `<name>-2` and leaves the partial one in front of it.

## Decision

### Staged copy {#staging}

- `save` creates a folder named `.saving-<random>` (`mkdtemp`) inside the
  store root. It is in the store, so it is on the store's filesystem and the
  final rename is atomic. It is dot-prefixed, so LLP 0465 #list skips it and
  the publish-by-name grammar (which needs a leading letter or digit) never
  resolves to it.
- The pages are copied into it. Only after the last one lands does `save`
  claim the slot with the usual exclusive `mkdir` and `rename` the staging
  folder over that empty slot. POSIX rename replaces an empty directory in
  one step, so the slot is never visible half-filled.
- On a failed copy, `save` unlinks only the pages it started copying (a page
  that failed before its file existed is skipped), then removes the staging
  folder with a plain `rmdir`. It never deletes recursively, as LLP 0465 #move
  requires. It exits 1, says the source is untouched and nothing was saved,
  and names the hidden folder only if that cleanup fails.
- A failed claim or rename removes the empty slot it claimed and cleans up
  staging the same way.

The draft is removed only after the rename, exactly as before. The receipt is
unchanged.

## Validation and cost {#validation}

`test/core/report-commands.test.js` injects a fault on the third page's copy:
a partial file, then `ENOSPC`. It asserts exit 1, an empty store (no slot and
no hidden leftover), the draft intact byte for byte, `list --local` silent on
the name, `publish <name>` refused with no request sent, and a retry that takes
the name itself. A second test fails the cleanup and checks that the hidden
folder is named. Both fail on the code before this change.

Cost: one extra `mkdtemp` and one `rename` per save, on a command run once per
report. The cleanup touches only the pages already in memory.
