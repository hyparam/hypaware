# LLP 0508: a plugin install destination is checked on disk, not only by name

**Type:** Decision
**Status:** Active
**Systems:** Plugins
**Author:** Phil / Claude
**Date:** 2026-10-16
**Related:** LLP 0007, LLP 0505; hyparam/hypaware#2118, hyparam/hypaware#2119,
hyparam/hypaware#2123

> Extends [LLP 0505](./0505-plugin-install-name-shape.decision.md) (and through
> it [LLP 0007](./0007-plugin-install-and-locking.decision.md#install-root-and-lock-file))
> with the filesystem half of install-destination containment that LLP 0505
> left out of scope. LLP 0505 is settled, so the rule lands here and LLP 0505
> carries a forward-ref to it.

## Context

LLP 0505's guard is lexical. A valid `@scope/name` whose `@scope` directory is a
pre-existing symlink passes it, and then the local lane's recursive remove, the
git lane's parent mkdir and backup rename, and `hyp plugin remove`'s recursive
delete all follow the link out of `<state>/plugins` (issue #2118). The link need
not be planted by hand: a local-dir artifact may carry symlinks, and both lanes
keep them.

## Filesystem parent {#filesystem-parent}

Before either install lane creates, replaces or renames a destination, and
before removal deletes one, the destination is checked on disk:

- The plugin install root is resolved as configured. A `HYP_HOME`, an ancestor
  of it, or `<state>/plugins` itself may sit under a symlink and keeps working.
  A root that is a dangling link, a loop, not a directory, or cannot be
  inspected refuses.
- Below the root, a `@scope` component must be a real directory. A symlink there
  refuses even when it points inside the root, because it would alias another
  scope's plugins.
- The destination itself may be a link. Both lanes and removal unlink a final
  link rather than follow it, so its target survives.
- A missing component passes: nothing below it exists to be followed, and the
  lanes create real directories in its place.
- Any other inspection failure (permissions, a loop) refuses.

An install refusal uses the error kind `install_dir_unsafe`, names the component
and reason, and changes nothing on disk or in the lock. In the git lane the check
runs after the trust prompt, next to the mutation, because the prompt can wait
on a person.

Local-dir artifact symlinks stay supported. Refusing every artifact symlink was
considered and not chosen.

## Removal {#removal}

`hyp plugin remove` still clears the lock row in every case. When the check
refuses, or when LLP 0505's rule withholds the delete, nothing is deleted and the
result says so: the CLI prints `removed <name>` and then one stderr line,
`hyp plugin remove: deleted nothing on disk: <reason>`. Before this, a withheld
delete reported plain success.

## Boundaries

The check is at most three `stat` calls along one path. It reads no plugin
contents. It is not a sandbox: a hostile writer racing it can still swap a
component between the check and the mutation. The lexical rule in LLP 0505 is
unchanged and still runs first.
