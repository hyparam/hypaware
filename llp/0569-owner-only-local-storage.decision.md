# LLP 0569: Local storage is owner-only

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Runtime, Privacy
**Date:** 2026-11-02
**Related:** LLP 0253, LLP 0326, LLP 0525

The local cache, its spool and the state under `HYP_HOME` hold recorded
content. Until now they were created with the process umask, so on a typical
`022` host every other local user could read them. The Claude raw-body spool
was the one exception (LLP 0253): it is created and repaired 0700. This
decision extends that to the rest of HypAware's storage, as two halves: new
storage is created owner-only, and an existing install is tightened at a few
verified roots rather than walked.

## The roots {#roots}

Every process (CLI, daemon, gateway) boots through `bootKernel`, so the
roots are tightened there, once per process, before anything writes. Three
roots, each tightened only when it is HypAware's:

- **`HYP_HOME`.** Dedicated by name when it is a `.hyp` directory (the
  default). A custom `HYP_HOME` is dedicated only when every entry in it is
  one HypAware writes there (`hypaware`, `hypaware-config.json` and its
  temp and backup siblings, `spool`, `ask`, `exports`).
- **The state root, `<HYP_HOME>/hypaware`.** HypAware's own directory by
  name. It holds the default cache, plugin state, daemon logs and
  credentials, so tightening it contains every existing file below it.
- **A separate cache root** (`opts.cacheRoot` outside the state root). Dedicated
  only when it holds nothing but the cache's own entries (`datasets`,
  `plugins`, `session-purges`, `.purge-cleanup`, `_hyp_*`).

Nothing is recursive and no parent of `HYP_HOME` is touched: securing a root
is enough to keep other users out of everything below it, and walking an old
cache would cost time proportional to its size on every upgrade. A preview
boot (LLP 0525) leaves the state root as found, so it skips this step. A
missing root is not created here.

## Verifying a root {#verified-root}

The final component is resolved with `realpath`, so a root that is a symlink
is tightened at its target and ancestors may be links (a home directory on
another volume is common). The resolved directory is then opened with
`O_RDONLY | O_DIRECTORY | O_NOFOLLOW`, and every later step uses that
descriptor: `fstat` for owner and mode, `fchmod` for the change. A link
swapped in after the resolve fails the open instead of redirecting the
chmod, and there is no check on one inode followed by a chmod on another.

- Owned by another uid: left alone (`foreign_owner`).
- Group and other bits already clear: nothing to do (`unchanged`), without
  reading the directory.
- A root dedicated by its entries is listed by path, so after the listing
  the path is `lstat`ed and its inode and device compared with the
  descriptor's. A mismatch means the listing was of a different directory,
  and nothing is changed (`replaced`).

## New files {#new-files}

New storage gets explicit modes, so it is owner-only whatever the umask:
directories 0700 and recorded content 0600. That covers the cache spool
(its directory and `active.jsonl`), committed Iceberg data and metadata files
and their directories, the ingest counter's directory, compaction generation
directories, retired partitions, plugin state, cache and temp directories, and
the daemon log. A recursive `mkdir` applies the mode to every directory it
creates, intermediate ones included.

An `active.jsonl` left by an earlier version keeps its old mode until it
rotates, so the spool tightens it through the append's own descriptor the
first time a storage service opens it for a table, once per table per
service. A file it cannot change is left as is and the append goes ahead.

Bookkeeping JSON beside the content (flush stamps, cursors, the ingest
counter) keeps the umask mode: it holds no recorded content and sits inside
an owner-only directory. Existing committed files are not rewritten; they are
behind the tightened root. The Claude raw-body spool keeps its own create and
repair (LLP 0253), unchanged.

## A location that is not HypAware's {#not-dedicated}

A shared, foreign-owned, replaced or unreadable root is left exactly as it
was and logs one `storage.root_not_secured` warning per process, with the
root kind and reason as `hyp_root` and `error_kind`. Boot carries on and
storage keeps working: refusing to start would turn a permission preference
into lost capture. The outcome per root is also on the `kernel.boot` span as
`owner_only_<root>`.

## Windows {#windows}

POSIX modes do not describe Windows access, and HypAware does not set ACLs.
On Windows this step reports `unsupported` and changes nothing; the docs say
the data is protected only by the user profile's own permissions.

## Cost {#cost}

Per process: for each root, one `realpath`, `open`, `fstat` and `close`, plus
a `readdir` and `lstat` for a root dedicated by its entries and one `fchmod`
when it needs tightening. Per table per storage service: one `fchmod` on the
first append. Per append: nothing; the mode is passed to the `open` call the
append already made. Nothing is retained beyond one set of resolved root paths
per process and one boolean per table.
