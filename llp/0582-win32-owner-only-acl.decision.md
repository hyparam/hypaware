# LLP 0582: Windows storage roots get an owner-only DACL

**Type:** Decision
**Status:** Draft
**Systems:** Cache, Runtime, Privacy, Windows
**Author:** Kenny / Claude
**Date:** 2026-11-04
**Related:** LLP 0569 (#windows: the paragraph this supersedes; #roots, #verified-root, #cost: the model this carries onto win32), LLP 0580, LLP 0581 (the prior win32 decisions in this series)

## Summary

LLP 0569 made local storage owner-only on POSIX and said, honestly, that on Windows the step reports `unsupported` and the data is protected only by the user profile's own permissions. That leaves every `mode: 0o600` credential - GitHub OAuth tokens, the OIDC refresh token, the service-account secret, the interception CA's private key, the central seed's policy token - world-readable the moment `HYP_HOME` sits anywhere outside the profile. This decision replaces `unsupported` with a real tightening: each verified storage root gets an inheritance-stripped DACL granting full control to the current user, SYSTEM, and Administrators, applied with `icacls`, once per process per root, exactly where the POSIX `fchmod` happens.

## Context

Windows ignores POSIX mode bits: `fs.chmod(0o700)` toggles nothing but the read-only flag, so every `0o600`/`0o700` in the tree is a no-op there. What protects the default install is that `%USERPROFILE%` already carries an inheritable owner/SYSTEM/Administrators DACL, which `~/.hyp` inherits. A custom `HYP_HOME` or cache root on another location (`C:\hyp`, a second drive) inherits that location's ACL instead - on a drive root that includes `BUILTIN\Users` read access, inheritable, which is exactly the `022`-umask exposure LLP 0569 closed on POSIX.

One Windows behavior changes the containment story relative to POSIX and has to be named: by default every process holds the bypass-traverse-checking privilege, so denying traversal at a directory does not deny opening a file below it by full path, the way a `0700` root does on POSIX. Tightening a root therefore protects what inherits from it, not what already exists below it with a permissive ACL of its own.

## Options considered

1. **Stay `unsupported`.** The LLP 0569 position, taken when no win32 ran this code at all. Now that the suite and the daemon run on Windows, "protected only by the profile" silently becomes "unprotected" for any custom root. Rejected.
2. **A Node ACL dependency or `child_process` to PowerShell.** A native module is a new runtime dependency (ruled out by repo policy); PowerShell costs ~1s per boot. Rejected.
3. **Recursive `icacls /t` over the roots.** Would also repair existing permissive children, at a cost proportional to the cache's size on every boot - the exact recursion LLP 0569 #cost rejected. Rejected.
4. **Root-only `icacls` with inheritance-carrying grants.** One `icacls` per root per process: strip inherited ACEs, grant `(OI)(CI)F` to the current user's SID, `SYSTEM`, and `BUILTIN\Administrators` (the OpenSSH private-key convention; both can reach the data regardless, and naming them keeps elevated maintenance and backup agents working). Everything created under the root afterwards inherits owner-only. **Chosen.**

## Decision

<a id="decision"></a>`secureOwnerRoot` on win32 verifies the root the same way its POSIX half does - `realpath`, a directory check, and the dedicated-location listing for a root HypAware did not name - then runs `icacls <root> /inheritance:r /grant:r <user-sid>:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F` and reports `secured`. The user is named by SID (read once per process from `whoami /user`), never by account name, so localization and renames cannot misdirect the grant. The same three roots as LLP 0569 #roots, the same once-per-process gate, the same never-throws contract: a root the user cannot re-ACL (someone else's directory) fails the `icacls` and is left as found with one warning.

What this does not replicate from POSIX, stated rather than papered over:

- <a id="traversal"></a>**Existing children with their own permissive ACLs stay reachable by path** (bypass traverse checking). The grant makes everything *new* under the root owner-only; existing entries tighten as they rotate or are rewritten. The default `%USERPROFILE%\.hyp` was never exposed - profile inheritance already matched this DACL - so the gap is confined to custom roots created before this shipped.
- **The descriptor discipline of LLP 0569 #verified-root does not transfer**: `icacls` takes a path, so the resolve-then-apply window exists on win32. The change only ever narrows access to principals that could already reach the data, so a swapped root costs an attacker nothing they did not have.
- **`unchanged` is not detected.** Reading a DACL back means parsing localized `icacls` output; re-applying is idempotent and costs one child process. Win32 reports `secured` or a failure, never `unchanged`.

## Consequences

- A custom `HYP_HOME`/cache root on a world-readable location becomes owner-only for every file HypAware writes from then on; the per-file `0o600` no-ops stop mattering because the root's inheritance carries the DACL.
- Boot on win32 spawns `whoami` once and `icacls` two or three times, ~50ms each, once per process (the LLP 0569 #cost shape, with a child process in place of a syscall). POSIX boots are byte-identical.
- <a id="explicit-grants"></a>**Explicit grants for other accounts are kept.** `/inheritance:r` drops what the root inherited from its parent, and `/grant:r` replaces the grants only for the three SIDs it names. A grant someone added by hand on the root itself, such as `icacls C:\hyp /grant Users:(OI)(CI)R`, survives every start and is inherited by everything new under the root. This is deliberate: a root shared on purpose stays shared, and HypAware never removes a grant it did not write. Stripping them (for example with `/reset` first) was considered and declined.
- `unsupported` disappears from the outcomes a win32 boot reports; the read-side mode checks that are disabled on win32 (`github/src/auth.js`) stay disabled - Node cannot read a DACL - which is unchanged from LLP 0569.
