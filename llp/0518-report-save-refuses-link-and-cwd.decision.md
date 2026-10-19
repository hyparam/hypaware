# LLP 0518: `hyp report save` refuses a symlinked source and a source holding the cwd

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports
**Author:** HypForge / Claude
**Date:** 2026-10-17
**Extends:** LLP 0465 (#save: adds two refusals before a byte moves; the allow-list, naming, and receipt rules stand; #move is unchanged for every source that passes)
**Related:** PR #2535 (review finding 8, deferred), issue #2542

> LLP 0465 moves a validated folder into the store and removes the draft.
> Two sources make that move wrong: a symbolic link, and the folder the
> shell is standing in. `save` now refuses both, names the reason, and
> touches neither the source nor the store.

## Context {#context}

Review of PR #2535 found two sources that pass every LLP 0465 #save check
and then misbehave under #move:

- **A symlinked folder.** `stat` follows the link, so the checks pass. The
  slot takes the link's name, the page unlinks run inside the link's target,
  and the final `rmdir` fails on the link. The save exits 0 having emptied a
  folder the caller never named, and leaves the link pointing at the emptied folder.
- **`hyp report save .`** (or any source that holds the cwd). The move
  removes the directory the caller's shell is in, so the shell is left in a
  deleted directory.

## Decision

### Two refusals {#refusals}

Before reading the source's pages or creating the store, `save` refuses:

- a source whose final path component is a symbolic link (`lstat`), with
  `error_kind` `symlink`, telling the caller to save the folder it points
  to; and
- a source whose real path is the caller's real cwd or one of its
  ancestors, with `error_kind` `contains-cwd`, telling the caller to run
  from the folder's parent and giving the command to type.

Both exit 2, the code for every other refused source, and both apply with
`--keep` too. A `--keep` copy of either is harmless, but the symlinked one
would still name its slot after the link. One rule is easier to explain than
two, and the fix the message gives works either way.

Refusing is preferred to resolving the link. A resolved save would move the
target under the target's name, which is a different folder from the one
the caller typed, and a move should not surprise anyone about what it
deletes.

## Validation and cost {#validation}

`test/core/report-commands.test.js` covers a symlinked folder (refused; the
link, its target's pages, and the store are untouched), a `.` source from
inside the draft (refused; the draft and store are untouched), and a plain
folder that still saves.

Cost: one `lstat` and one `realpath` per save, on a command run once per
report.
