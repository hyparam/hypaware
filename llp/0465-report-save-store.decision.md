# LLP 0465: Finished reports move into `$HYP_HOME/reports` through `hyp report save`

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports, Plugins
**Author:** Brendan / Claude
**Date:** 2026-10-05
**Extends:** LLP 0450 (#launch: the skill still drafts in the caller's directory; this decision adds where the finished report goes), LLP 0436 (#sources: the publish allow-list is also what admits a folder to the store), LLP 0155 (#core-group: `save` joins `generate` as the group's second local member, and `list` gains a local section; #period-explicit: the save receipt suggests a period from the generator's folder name and never applies one)
**Related:** LLP 0393 (#contract: `report save` joins the finite command vocabulary), LLP 0398 (#run-directory: `$HYP_HOME/ask` is the precedent for a fixed folder under `HYP_HOME` that a command, not the caller's cwd, owns), LLP 0448 (unmerged; its #local-list section is revived here, its launch-in-the-store section stays replaced by LLP 0450), issue of reports accumulating wherever `hyp report generate` was last typed

> LLP 0450 kept report generation in the caller's directory so a session is
> never silently relocated. The cost showed up as clutter: every directory a
> report was asked for in keeps a `hypaware-report-...` folder, and nothing
> lists them. This decision gives finished reports one home,
> `$HYP_HOME/reports`, reached by a CLI step the skill ends with, so the
> agent never writes under the user's home directory itself; makes
> `hyp report list` show that store beside the published reports; and lets
> `hyp report publish` take a saved report by name.

## Context {#context}

PR #2263 (LLP 0448) first proposed `$HYP_HOME/reports` by launching the
client inside it. LLP 0450 replaced that because the launch moved the user's
session out of the directory they typed the command in, with the directory's
recording policy following. What survived was a draft folder under cwd and a
`hyp report list` that lists only the remote.

Two facts shape the alternative. An agent writing under `~/.hyp` on its own
is an access the report skill should never need to ask for, so the move has
to be a CLI command the agent invokes. And `hyp report publish` already
holds a folder to an allow-list of pages (LLP 0436 #sources), so the same
check can gate the store and keep working notes out of it.

## Decision

### The store {#store}

Finished reports live in `$HYP_HOME/reports/<name>/`, resolved as
`$HYP_HOME/ask` is (`HYP_HOME`, else `~/.hyp`; a relative `HYP_HOME` resolves
against the command's cwd). The folder sits outside every project directory,
so no folder marking (`hyp privacy folders`) applies to it; a report is an
output, not a recording. Nothing in the central plugin syncs it. The caller's
directory remains where the skill drafts (LLP 0450 #launch); the store is
where the reviewed report ends up.

### `hyp report save <dir> [--keep]` {#save}

`save` admits a folder to the store only when it would publish: it must hold
`report.md` and otherwise only `usage.md`, `work.md`, `health.md`, and
`recommendation-<slug>.md` (the legacy `change-<slug>.md` too), as regular
files, through the one validator `publish` uses. Anything else is refused
before a byte moves, with the stray entry named, and the store is not
created. So the store only ever holds publishable content: no ledgers, raw
logs, or `.DS_Store`.

The folder keeps its name. The name must be a plain directory name
(`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`): no hidden prefix, no separator. A
taken name gets `-2`, `-3`, ... by exclusive `mkdir`, so two saves at once
cannot share a slot and nothing is overwritten. A folder already in the
store is refused rather than saved beside itself.

The receipt prints the saved path, `hyp report list --local`, and a
`hyp report publish <name> --kind usage-review --period <period>` line. The
period in that line is read off the generator's own folder name
(`hypaware-report-<from>-to-<to>` yields `<from>-to-<to>`); any other name
leaves the placeholder. It is a hint on a receipt, never a default the
command applies (LLP 0155 #period-explicit).

The command does not fence the agent: a client with shell access can still
copy into `~/.hyp` if its permissions allow. What it buys is that the skill
never asks for home-directory access and whatever lands in the store has been
validated. The generating conversation is still recorded under the cwd's
policy, exactly as LLP 0450 says.

### Move by default {#move}

Reports left around the filesystem are the complaint, so a successful save
removes the draft. `--keep` copies instead. The removal is bounded to what
was copied: each validated page is unlinked, then the directory is removed
with a plain `rmdir`. A file that appeared after validation makes the
`rmdir` fail, and the folder is left in place and named in the receipt. The
command never runs a recursive delete. A copy that fails midway leaves the
source untouched and the partial slot in the store, named in the error.

### `hyp report list` gains the saved section {#list}

After the published reports, `list` prints a `saved reports (<root>):`
section: one line per saved folder, newest first by `report.md`'s mtime, at
most 100 with the remainder counted. Discovery is one `opendir` and one
`lstat` per candidate: immediate non-hidden directories holding a regular
`report.md`. No symlink is followed and no page is read. A missing store is
an empty one and prints nothing after a remote listing, so a machine with no
saved reports sees the listing it always did. An unreadable store is a
warning on stderr, never a failed listing.

`--local` prints that section alone with no remote read and no credential,
and refuses the remote's selectors and filters (`--remote`, `--org`,
`--kind`, `--period`, `--limit`, `--before`, `--recommendations`,
`--status`), since none has a local meaning. With none saved it says where
saves go.

When nothing selects or filters the remote and the remote read fails
(unknown default target, credential, network, non-200), a person reading the
terminal still gets the saved section under a one-line warning, exit 0.
Explicit remote selection or any filter keeps the failure and its exit code,
as does `--json`, whose single array a script would otherwise take for the
whole listing. The flat form (`--recommendations`, `--status`) is remote-only
and has no section to fall back to.

`--json` stays one array: the remote's records whole, then one row per saved
report, `{ source: 'local', name, path, modifiedAt }`, with the path derived
from the store, never read from anywhere.

### `hyp report publish` takes a saved name {#publish-by-name}

A `source` that is no path on disk, and is a plain name by the grammar
above, resolves to `$HYP_HOME/reports/<name>` when that is a directory. A
path that exists always wins, since a path is what the argument always
meant. The refusal for a bare name that is neither names the store and the
listing that shows it. Nothing else about publish changes; the bundle is
built from the store folder exactly as from any other.

### The skill ends with `save` {#skill}

Both copies of `hypaware-report` draft under the current directory as before,
and after review run `hyp report save <folder>` and return the saved path the
receipt prints. The publishing example takes the saved name. `hyp report
generate`'s prompt says the same, so a client started by the CLI and one
asked directly both end in the store.

## Validation and cost {#validation}

Tests cover: a validated folder moving under its own name with the draft
removed; `--keep`; refusal of a stray file before the store is created;
missing folder, file, missing `report.md`, hidden name; suffixing a taken
name without overwriting; refusing a folder already in the store; a file that
appears mid-move leaving the folder in place and named; the `report.save`
span recording status, `keep`, page count and error kind, never a name or
path; `--local` reading no remote and skipping hidden entries, files,
folders without a brief, symlinked folders and symlinked briefs; the 100
cap with the remainder counted; the section and the JSON array after a
remote listing; the empty-remote case; the implicit-failure degrade against
explicit, filtered and `--json` runs; an unreadable store; publish by saved
name, path precedence, and the two-part refusal; and the generate prompt.

CPU and memory: `save` copies the validated pages once and unlinks them
once; the slot claim is one `mkdir` per taken name, bounded at 1000. The
listing adds one directory read and one `lstat` per candidate folder to a
command that already makes a network call, retaining at most 100 rows by
bounded insertion; no page is read, no tree walked, no content hashed, and
nothing persists between runs. `publish` adds at most one extra `stat`.
