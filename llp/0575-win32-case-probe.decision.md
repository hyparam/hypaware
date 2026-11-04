# LLP 0575: win32 volumes probe for case-insensitivity

**Type:** Decision
**Status:** Draft
**Systems:** Core
**Author:** Kenny / Claude
**Date:** 2026-11-03
**Related:** LLP 0049, LLP 0050, LLP 0300

> `createVolumeCaseProbe` (`src/core/usage-policy/fold.js`) runs on win32 as
> well as darwin. Extends [LLP 0050 §normalization](./0050-ignore-enforced-in-adapters.decision.md#normalization),
> which scoped the probe to darwin and left it inert everywhere else.

## Context

LLP 0050 put case folding behind a per-volume probe (`dev`/`ino` identity of a
path against a case-flipped spelling of its last segment) and made the probe
inert — constant `false`, no syscall — off darwin, "because no shipping
Linux/Windows filesystem this codebase targets presents the macOS
case-insensitive-by-default behaviour". For Windows that premise is wrong:
NTFS is case-insensitive by default, which is exactly the aliasing the fold
exists to close. With the probe inert there, a machine-local entry declared
`C:\Users\kenny\Secret` did not govern a session whose `cwd` arrived spelled
`c:\users\kenny\secret` — the same directory, a differently-cased spelling —
so the privacy rule failed **open**, the direction
[LLP 0049 §fail-safe](./0049-hypignore-usage-policy.spec.md#fail-safe) forbids.

## Options considered

1. **Fold case unconditionally on win32.** Rejected for the same reason LLP
   0050 rejected it on darwin: a volume (or directory, see below) can be
   case-sensitive, and an unconditional fold merges genuinely distinct
   directories.
2. **Probe on win32, same mechanism as darwin.** The probe is already a pure
   `dev`/`ino` identity test with no darwin-specific syscall, and Node's
   `stat` on NTFS reports a usable `dev` (volume serial) and `ino` (file ID).
3. **Leave win32 inert until the Windows port ships.** Rejected: capture via
   `hyp daemon run --foreground` already works on win32 (LLP 0300), so the
   fail-open is reachable today.

## Decision

Option 2. `createVolumeCaseProbe` probes on win32 exactly as on darwin; every
other platform stays inert. Two win32-specific notes:

- **Separators.** The flipped spelling cuts the last segment on either `/` or
  `\` on win32, since Windows accepts both in one path. On POSIX the cut stays
  `/`-only: a backslash is a legal filename character there, and splitting on
  it would flip a partial segment.
- **Per-directory case sensitivity.** `fsutil file setCaseSensitiveInfo` makes
  a single NTFS directory case-sensitive, so on win32 the verdict is not
  strictly a property of the volume, and the per-`dev` memo can return a wrong
  `true` for such a directory. That error only widens matching, which the
  gate's `max(declared, folded)` lattice (LLP 0050 §normalization) turns into
  an over-restriction — a usability cost, never a leak. A wrong `false` is not
  reachable this way: the memo learns `false` only from a volume whose default
  state is case-sensitive.

Drive-letter case (`C:` vs `c:`) needs no separate handling: a case-insensitive
verdict lowers the whole folded spelling, drive letter included.

## Consequences

- `hyp privacy ignore` / `local-only` rules on win32 now reach every spelling
  NTFS treats as the same directory, closing the fail-open.
- The probe's cost on win32 matches darwin's: one extra `stat` per distinct
  volume per TTL window, within the LLP 0049 R6 bound.
- As on darwin, the win32 probe's real-filesystem behaviour is only exercised
  on a win32 host; Linux CI drives it through the injected verdict only.

## References

- [LLP 0050 §normalization](./0050-ignore-enforced-in-adapters.decision.md#normalization)
- [LLP 0049 §fail-safe](./0049-hypignore-usage-policy.spec.md#fail-safe)
- [LLP 0300](./0300-daemon-control-channel.decision.md) (win32 groundwork)
