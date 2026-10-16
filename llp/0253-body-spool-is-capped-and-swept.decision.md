# LLP 0253: The body spool is owner-only, byte-capped, evicted oldest-first, and swept on removal

**Type:** Decision
**Status:** Accepted
**Systems:** Privacy, Config, Sources, Daemon
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0049, LLP 0066, LLP 0085, LLP 0103, LLP 0262 (the RFC this
decision realizes, accepted 2026-08-17), LLP 0252, LLP 0257, LLP 0258
**Extended-by:** LLP 0263 (#byte-cap is also enforced by the client hook, so
the bound holds while the daemon is down), LLP 0287 (#delete-on-drop is
applied by the Claude OTEL listener to an `undetermined` verdict too, which is
none of the three drops this names; open, nothing settled until that issue is),
LLP 0328 (#purge-and-detach-sweep: the sweep asks the filesystem about each
directory it walks, not only the string about the name)

> Raw request and response bodies land in a spool directory under the HypAware
> home with owner-only permissions. Its size is a config value with a 512 MB
> default and oldest-first eviction, so a down daemon can never fill the disk.
> Bodies belonging to an ignored or policy-dropped session are deleted, not
> skipped, and `hyp purge` and detach both sweep the directory.

## Context

Claude Code writes bodies to a directory we name at attach (LLP 0258
#env-keys) and it keeps writing whether or not the daemon is reading. Measured
volume is about 145 KB per request, so a heavy day passes gigabytes through the
directory. LLP 0262 settles that transient spool presence is acceptable, given
the same content already sits in `~/.claude/projects`, on three conditions.
This decision is those conditions.

## Decision

### The spool lives under the HypAware home, owner-only {#spool-location}

**The directory is `<hyp-home>/spool/claude-bodies`, created mode `0700`.**
Raw prompts must not be world-readable, and a path under the HypAware home is
one the user already knows to be ours: it is what `hyp purge` and detach can
find without being told, and what a backup tool that excludes the HypAware home
already excludes.

### A byte cap with oldest-first eviction {#byte-cap}

**The spool is bounded by a configured byte cap, default 512 MB, and the oldest
files are removed first when it is exceeded.** The cap is enforced by the
daemon, not by hoping the reader keeps up: the window this exists for is
precisely the one where the reader is not running. Oldest-first is the right
direction because the newest bodies are the ones whose events are still
arriving.

### Eviction degrades to backfill, never to loss {#eviction-degrades}

**An evicted body is not an error.** The content it held is recoverable from
the Claude Code transcript by the existing backfill path, so the failure mode
of a full spool is "captured later, with less detail", not "captured never" and
not "disk full". Eviction is logged with a count so a machine that is
routinely evicting is visible.

### Dropped sessions have their bodies deleted {#delete-on-drop}

**When ingest drops a session (`.hypignore`, the machine-local list of LLP 0049
and 0103, or a per-session ignore under LLP 0066), it deletes that session's
bodies instead of leaving them unread.** Skipping would leave the content of
exactly the sessions the user asked us not to keep sitting in our own
directory until a cap evicted it. Deletion is what makes the opt-out mean what
it says.

**Extended-by:** [LLP 0287](./0287-undetermined-deletes-bodies-unread.issue.md)
(Draft, open): the Claude telemetry listener runs this same deletion for an
`undetermined` verdict, which is none of the three drops named above. That
issue states the asymmetry and the options; the scope of this section is
unchanged until it is settled.

### Purge and detach sweep the spool {#purge-and-detach-sweep}

**`hyp purge` and `hyp detach claude` both remove the spool directory's
contents.** The attach marker records the path (LLP 0258 #marker-and-spool) so
neither verb has to recompute it, and so a detach after a config change still
sweeps the directory that was actually used.

**Extended-by:** [LLP 0328](./0328-a-spool-path-is-checked-where-it-is-walked.decision.md)
(Accepted): the containment test that decides which directory a marker may aim
this sweep at is string work, and `readdir` follows a symlinked spool path.
The sweep now asks `lstat` about each directory at the moment it walks it. What
this section settles (both verbs empty the spool, from the recorded path) is
unchanged.

## Consequences

- Disk growth from capture is bounded by the cap plus the Iceberg cache, and
  the cap is one config value an operator can lower on a small disk.
- A stopped daemon costs detail, not integrity, and the loss has a named
  recovery path.
- The spool is a privacy surface with three named duties, so a review can check
  it against this list rather than against intent.
- Nothing in the spool outlives the user's decision to remove it, which is what
  lets LLP 0262 accept transient presence at all.
