# LLP 0580: win32 active-slot pointer is a regular file

**Type:** Decision
**Status:** Draft
**Systems:** Core
**Author:** Kenny / Claude
**Date:** 2026-11-04
**Related:** LLP 0025, LLP 0031, LLP 0300

> On win32 the apply engine's active-slot pointer
> (`config-control/active`) is a regular file holding the slot's
> basename, not a symlink. Extends
> [LLP 0031 §physical layout](./0031-layered-config.decision.md#physical-layout),
> which relocated the pointer into `config-control/` and kept the atomic
> symlink-flip crash-safety of LLP 0025.

## Context

The apply engine commits a pulled org config by flipping
`config-control/active`, a relative symlink to the A/B slot file, created
at a tmp path and renamed over the pointer so a crash leaves either the
old or the new pointer, never neither (LLP 0025, relocated by LLP 0031).

On Windows, creating a *file* symlink requires the
`SeCreateSymbolicLinkPrivilege`, which an ordinary unelevated process has
only with Developer Mode enabled. The daemon and CLI run unelevated, so
every `flipPointer` on win32 failed with EPERM: no pulled config could
ever commit, which blocks the enrolled/managed lane of the Windows port
(LLP 0300 established capture already works there).

## Options considered

1. **Require Developer Mode / elevation on win32.** Rejected: a telemetry
   daemon must not demand a machine-wide security posture change, and a
   silent EPERM on hosts without it is exactly the stuck-apply failure
   LLP 0025's probation machinery exists to avoid.
2. **A junction or hardlink.** Junctions only cover directories; a
   hardlink to the slot file cannot express "which slot" without reading
   content anyway, and breaks the never-modify-the-previous-slot
   invariant if anything writes through it.
3. **A regular pointer file holding the slot basename, tmp+rename.**
   `rename` atomically replaces an existing regular file on NTFS, so the
   old-or-new crash guarantee carries over unchanged. The pointer's
   *content* is the same string the symlink's target was.

## Decision

Option 3, win32 only. `flipPointer` writes the slot basename (one line,
mode 0600) to the tmp path and renames it over
`config-control/active`; POSIX keeps the symlink exactly as before.
Reading goes through one helper (`readActivePointerTarget`): `readlink`
first, and on win32 only, a reply of EINVAL/UNKNOWN (present but not a
symlink) falls back to reading the file's trimmed content. Both
representations resolve relative to the pointer's directory and must name
slot `a` or `b`, as before.

On POSIX a regular file at the pointer path **remains an error**: the
symlink is the only representation ever written there, so a file stays
what issue #2432 treats it as, evidence of an unreadable (tampered)
central layer, and the `hyp status` diagnostic for it is unchanged. A
win32 pointer file whose content names no slot resolves to `null` and
surfaces through the same unresolvable-layer diagnostics.

A host migrated POSIX→win32 (or the reverse) is out of scope: the state
root is machine-local and never copied across operating systems.

## Consequences

- The apply engine's full lifecycle (stage, probation, rollback,
  `evaluateAtBoot`, re-join reset) runs on win32; nothing else in the
  engine branches on platform. Rollback and reset already unlink the
  pointer as a directory entry, which covers a regular file the same way.
- Crash-safety is unchanged on both platforms: one `rename` is still the
  commit point.
- CPU/memory: the win32 read is one failed `readlink` plus one small file
  read on the same path; POSIX reads are byte-for-byte what they were.

## References

- [LLP 0031 §physical layout](./0031-layered-config.decision.md#physical-layout)
- [LLP 0025](./0025-remote-config-join-flow.spec.md) (apply semantics, staged restart)
- [LLP 0300](./0300-daemon-control-channel.decision.md) (win32 groundwork)
