# LLP 0505: a plugin install destination is one name or `@scope/name`

**Type:** Decision
**Status:** Active
**Systems:** Plugins
**Author:** Phil / Claude
**Date:** 2026-10-16
**Related:** LLP 0005, LLP 0007

> Extends [LLP 0007](./0007-plugin-install-and-locking.decision.md#install-root-and-lock-file)
> with the shape a manifest name must have before `hyp plugin install` or
> `hyp plugin update` uses it as an install destination (issue #2123). LLP 0007
> is settled, so the rule lands here and LLP 0007 carries a forward-ref to it.

## Context

LLP 0007 puts each installed plugin at `<state>/plugins/<plugin-name>/`, and
both install lanes replace whatever already sits there: the local lane removes
it recursively, the git lane renames it aside and then removes the backup. The
guard ahead of that replacement asked only whether the derived directory is
strictly inside `<state>/plugins` (issue #2119). That admits names that stay
inside the root but are not install destinations:

- A bare `@scope` names the directory every `@scope/*` plugin lives in, so
  installing it deletes them all, leaves their lock rows pointing at nothing,
  and reports success.
- `trail/` keeps its trailing separator through `path.join`, so the git lane's
  backup path becomes a child of the install directory and every later update
  fails.
- Deeper or normalizing names (`sub/dir/deep`, `a/../b`, `/absolute/name`)
  install at a path that does not read back as the name.

## Install name shape

New installs and updates accept a manifest name only when it is:

- one unscoped segment that does not start with `@`, or
- exactly `@scope/name`, where `name` does not start with `@`.

Each segment (the scope without its `@`) must be non-empty and literal: no `\`
(a separator on Windows), no NUL, and no trailing space or dot. Windows strips a
trailing space or dot from a path component, so `. ` aliases the plugins root
and `a.` aliases `a`. The trailing-dot rule also refuses `.` and `..`.

The check runs before any removal, replacement, backup rename, trust prompt or
lock write, so a refused install changes nothing on disk or in the lock. The
refusal keeps the existing `manifest_name_unsafe` error kind.

The rule is install-time only. Boot-time manifest validation, which also loads
bundled and already-installed plugins, is unchanged: tightening it would make a
plugin installed under an older, looser rule disappear from the boot plan
instead of being refused at its next install.

## Removal

`hyp plugin remove` still clears any lock row, because `hyp status` prints it as
the repair for a bad row. It deletes a directory only when the row's key is
itself an install name and the directory the row records (or derives, when it
records none) is exactly the one that key derives. Both install lanes record
the derived directory, so any other row was hand-edited, and judging the
directory alone would let it point at a plugin it does not own: a key of
`a/../b` or `trail/` resolves to another plugin's valid destination, a recorded
`install_dir` can name another plugin, and a bare `@scope` names every plugin
under that scope. Such a row is cleared and nothing is deleted. A plugin
installed under the older rule with a name that is no longer an install name
keeps its directory on disk after its row is removed; leaving files is the safe
failure here.

## Out of scope

This rule is lexical. It does not resolve symlinks, so a valid scoped name whose
parent is a pre-existing symlink is issue #2118's filesystem-containment work,
not this one. The Windows aliasing described above is reasoned from documented
Win32 path behavior; it has not been run on a Windows host, and the repository
ships no Windows daemon installer.

The check is linear in the name's length and reads no directory tree.
