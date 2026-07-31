# LLP 0050: ignore is enforced in the client adapters, not the gateway

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Plugins, Core
**Author:** Phil / Claude
**Date:** 2026-06-29
**Related:** LLP 0012, LLP 0016, LLP 0049, LLP 0066, LLP 0083

> The `.hypignore` capture-seam drop ([LLP 0049](./0049-hypignore-usage-policy.spec.md))
> lives in the `@hypaware/claude` and `@hypaware/codex` adapters — the only
> places that resolve a `cwd` — not in `@hypaware/ai-gateway`. The shared
> matcher lives in `src/core/usage-policy/`.

## Context

`ignore` must drop a row at the **capture seam**, before it reaches the cache
([LLP 0049](./0049-hypignore-usage-policy.spec.md#enforcement)). The question is
*which component* does the drop. The obvious candidate — the AI gateway, since it
sees all live traffic — is the wrong one.

## Decision

**Enforcement lives in the client adapters; the gateway stays `cwd`-blind.**

The `@hypaware/ai-gateway` source is provider-agnostic: it proxies bytes and
writes whatever a projector returns, and it reads **no** session context — it has
no concept of `cwd`. All folder knowledge lives in the two client adapters, which
already resolve `cwd` at four call sites:

| | Claude | Codex |
|---|---|---|
| **Live** | `createClaudeExchangeProjector` (`claude/src/projector.js`) | `createCodexExchangeProjector` (`codex/src/exchange-projector.js`) |
| **Backfill** | `claude/src/backfill.js` | `codex/src/backfill.js` |

### Live: projector returns no rows

The live exchange projector already reads `session-context.jsonl` and stamps
`cwd`/`git_branch`/`git_remote`/`repo_root` onto each projected row
(`claude/src/projector.js`). (**Extended-by:
[LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md)** — the Codex live
projector had no equivalent `cwd` source on the ChatGPT-subscription route, so it
now enriches `cwd` from the session rollout the same way; the drop mechanics here
are unchanged.) It runs **before** the cache write: the gateway
source does `projectExchange(row)` → `if (messageRows.length > 0) appendRows(...)`
(`ai-gateway/src/source.js`). So an ignored exchange is dropped by having the
projector **return `[]`** — the existing write guard then persists nothing. **No
gateway change is required.** The response has already been streamed to the
client by this point, so the live call is untouched
([LLP 0049](./0049-hypignore-usage-policy.spec.md#requirements) R2).

This is purely a projection-time decision; settlement (`claude/src/settle.js`,
[LLP 0027](./0027-cache-settlement.decision.md)) only upgrades the identity of
already-written rows and is irrelevant to ignore. (**Extended-by:
[LLP 0085](./0085-settlement-may-drop-late-ignore.decision.md)** — this holds for
the *common* case, where the projector resolved `cwd` and applied the drop. But
when `cwd` was *unknown at projection* (the Claude session-start race: the
`session-context.jsonl` record had not landed, so the row was written with
`cwd = null` and the check was skipped, failing **open**), settlement is **no
longer** irrelevant: it re-resolves the now-known `cwd` at flush and **drops** the
row when it resolves to `ignore`. The `ignore` guarantee is thus the capture seam
**or** a flush-time settlement-drop when cwd was unknown at capture; the drop
still happens before partition write and before export.)

### Backfill: skip ignored sessions

`hyp backfill` reads local transcripts that carry `cwd`/`repo_root` per session,
so each backfill provider filters ignored sessions out *before* projecting or
writing them. Without this, a backfill would silently re-import the exact
sessions ignored live.

### Shared matcher in core

Only the matcher — *given a `cwd`, walk ancestors → nearest `.hypignore` →
class*, with a per-`cwd` cache — is common to all four call sites. It is a small,
**`cwd`-agnostic** unit of path logic and lives in **`src/core/usage-policy/`**,
imported by both adapters exactly as they already import
`src/core/observability`. Core gains a reusable matcher; it gains **no** `cwd`
concept and does not inspect rows (only the adapter knows which field is the
`cwd`).

## What "the same directory" means to the shared matcher {#canonicalization}

The matcher compares directory *paths*, and a directory has more than one path.
Until this section existed, the matcher used `path.resolve` on both sides, which
is purely **lexical**: it normalizes `.`/`..` and makes a path absolute but
follows no symlinks. So the ancestor walk from a symlinked `cwd` climbed the
*link's* parents and never met the `.hypignore` governing the real directory: a
user's `.hypignore` was silently not in force for a project reached through a
symlink, which on macOS is ordinary (`/tmp` to `/private/tmp`, Homebrew
prefixes, iCloud-backed `~/Documents`). Because this is the *single shared*
matcher, every consumer inherited the hole: all four adapter capture seams,
`hyp purge`, the query-seam visibility filter (LLP 0105), `hyp ignore --check` /
`policy show`, and the machine-local list membership test.

**Decision: a directory is matched over the *set* of path spellings that denote
it, and the most restrictive verdict any spelling produces wins.** The set is
the as-given (lexical) spelling plus the canonical, symlink-resolved spelling
when it differs, computed by `src/core/usage-policy/canonical.js`. Both sides of
every comparison get this treatment: the incoming `cwd`, and every stored
machine-local entry's `dir`.

Resolving over the *set* rather than switching to the canonical form alone is
the load-bearing part, and it is a privacy argument rather than a tidiness one.
Canonicalizing only the incoming `cwd` does close the capture leak, but the
machine-local store keeps whatever path the user supplied (LLP 0071, LLP 0103),
so an entry the user marked by its symlink spelling stops governing: the class
drops from `local-only` to `full` and that directory **starts forwarding**. That
trades a capture leak for a forwarding leak. Taking the most restrictive verdict
across both spellings closes the first without opening the second, and makes the
fail-safe structural rather than a special case: a `realpath` that fails removes
a *candidate* spelling, never a verdict some other spelling already produced.

**The invariant is that canonicalization only ever moves the gate toward more
restrictive, never toward `full`**, and one step needs explicit care to hold it.
Merging verdicts across spellings is monotone, but the machine-local list's
*nearest-governs* step is an argmax over match depth, and an argmax discards
verdicts instead of merging them. A less restrictive entry (an explicit `sync`
carve-out, say) that gains reach through its canonical spelling can therefore
become the deepest match and displace a broader restrictive entry that already
governed - which would punch a hole in a private tree declared under the other
spelling and start that directory recording and forwarding. So the
nearest-governs rule is evaluated **twice**, once over the declared spellings
alone (what the lexical matcher decided) and once over the widened set, and the
more restrictive of the two answers wins, the declared one breaking a class tie
because it is the spelling the user typed. Widening an entry's reach can then
only add restriction.

The visible cost is that a nested loosening does not cross spellings *when the
broader restrictive entry is one the declared pass already found*: an explicit
`sync`/`full` carve-out declared under one spelling does not loosen a broader
restrictive entry that matches the `cwd` by its own declared spelling, and a
user who wants that carve-out has to declare it under the same spelling as the
entry it carves out of (`hyp policy show` on the path reports the class actually
in force, so the situation is diagnosable). That is the privacy-safe direction
of the trade, and it is the same direction the `cwd` side already takes.

That condition is load-bearing and the rule should not be read without it,
because the two-pass guard can only preserve a verdict the declared pass
actually produced. When the broader restrictive entry reaches the `cwd` *only*
through canonicalization, the declared pass matches nothing, there is no lexical
verdict to preserve, and ordinary nearest-governs decides among entries that are
all in the canonical namespace: a deeper carve-out does then win. That is not a
hole in the invariant above. The lexical matcher matched neither entry in that
shape, so `full` is exactly what it returned as well, and the outcome is the one
the user would have got by declaring both entries canonically in the first
place. Pinned by `resolve: between two entries that both reach only by
canonicalization, the deeper carve-out governs`.

Three consequences worth stating outright, because they are what a reader of the
privacy gate will ask:

- **A declaration stays authoritative as written.** Stored entries keep their
  as-declared `dir` on disk; nothing is rewritten. An entry governs both its
  declared spelling and, when resolvable, the canonical spelling of what it
  points at. If the declared path's target changes or disappears, the
  declaration still governs the declared spelling, so **no stored entry ever
  silently loses its class**; it merely stops governing the canonical form of a
  target it no longer names. A filesystem change never revokes a user's
  declaration.
- **Migration is canonicalize-on-read, additively.** There is no on-disk
  migration and no version bump: entries written before this decision gain
  canonical reach the moment it ships. Writes still store the caller-resolved
  path, so `policy show` and `--check` echo the spelling the user typed. The one
  write-side change is *upsert identity*: re-marking a directory through a
  different spelling replaces the existing entry rather than appending a second
  governor for the same directory (which would let the nearest-governs
  tie-break, not the user, decide the class).
- **`realpath` is not free, so it rides the existing cache.** The per-`cwd`
  memoization is keyed on the lexical path and consulted *before*
  canonicalization, so the cost is one `realpath` per distinct `cwd` per TTL
  window - the identical bound [LLP 0049](./0049-hypignore-usage-policy.spec.md#requirements)
  R6 already sets for the ancestor walk - and **zero** syscalls on a cache hit,
  which is the per-exchange hot path. Entry spellings are computed once per list
  parse, inside the same TTL. `hyp purge`'s subtree predicate runs per row, so it
  memoizes the verdict per distinct row `cwd` for the life of one purge run.

A canonicalization that does not fully resolve is reported as a structured
`usage_policy.canonicalize_failed` event carrying `error_kind:
path_canonicalize_failed`, the `errno`, how far it got, and a **hashed** path -
never a raw local path, the same discipline the `usage_policy.export_drop`
aggregate uses. `ENOENT` is routine (a deleted `cwd`, a not-yet-created
directory), so it logs at `debug`; only a wholly unresolvable path escalates to
`warn`. `realpath` is all-or-nothing, so rather than discard a failure entirely
the canonicalizer resolves the deepest existing ancestor and rejoins the
unresolved tail: with `/tmp` a symlink, `/tmp/proj/not-created-yet` still
canonicalizes usefully, which matters because the symlink is almost always an
*ancestor*, not the leaf.

`isEqualOrDescendant` stays lexical and pure, for callers comparing two strings
that are already canonical and must not touch the filesystem. The
spelling-agnostic predicate a CLI verb wants when it asks "which stored entry
governs this directory?" is `scopeGoverns`, which has to be the same predicate
`resolve` used, or `policy show` names a governor the gate did not use and
`policy unset` refuses to remove an entry the gate is enforcing.

Symlinks are not the only way a filesystem spells one directory several ways.
[§normalization](#normalization) widens the same set again, by Unicode
normalization and per-volume case, through the same two-pass guard: the two are
one mechanism in the code, not two stacked ones. Read that section before
touching `selectGoverning`, and note that the fold it adds stops at the gate
while the canonicalization described here does not.

## Why not the gateway

- The gateway is the **provider-agnostic** proxy ([LLP 0016](./0016-ai-gateway.decision.md)).
  Teaching it about `cwd`/`.hypignore` would push client-specific domain logic
  into a component whose whole point is not to have any.
- The backfills do **not** flow through the gateway at all, so gateway-side
  enforcement could not cover them — the matcher would have to live somewhere
  shared regardless.
- It makes the [LLP 0049](./0049-hypignore-usage-policy.spec.md#non-goals)
  raw-proxy/OTEL folder-blindness a **structural consequence** (those paths have
  no adapter and no `cwd`) rather than a rule someone must remember to enforce.

## Why not duplicate the matcher per adapter

Two copies of a privacy-critical matcher drift apart. A single core module with
one test suite is the safer home; sibling-to-sibling plugin imports would be
worse coupling than both importing core.

## The set of spellings that denote a directory is volume-dependent {#normalization}

The shared matcher compares **strings**. A filesystem hands one directory
several strings, and which mechanisms apply is a property of the **volume**,
not of the path and not of the platform:

| mechanism | folded by | volume-dependent? |
|---|---|---|
| symlinked components | `realpath(2)` | no |
| Unicode normalization (NFC vs NFD) | nothing in `node:fs` | yes, and folding is **unsafe** where it does not apply, but harmless *at the gate* (see below) |
| case | nothing in `node:fs` | yes, and folding is **unsafe** where it does not apply |

`realpath(2)` resolves symlinks and does nothing else. On a default macOS
(APFS) volume the kernel accepts, `stat`s, and `chdir`s to spellings it will not
fold: `Proj` and `proj` are one directory, and `Café` spelled NFC (U+00E9) and
NFD (`e` + U+0301) are one directory. So the gate could be handed a `cwd` whose
spelling differs from the spelling a machine-local entry was declared with and
return `full` for a directory the user opted out of. That is not an exotic
case: macOS frameworks and Finder-derived paths emit NFD while typed and
JSON-transported paths are usually NFC, and the two paths this gate compares are
produced by **different processes at different times** (a CLI resolving a mark,
versus a client reporting a `cwd`).

**Decision: list membership compares a folded spelling of both sides.** The fold
is `src/core/usage-policy/fold.js`:

1. **NFC unconditionally, and only because this is the gate.** It is a total
   function of the string, needs no filesystem access, cannot fail, and is the
   identity on a path that is already composed. What makes it safe here is
   **not** that NFC and NFD always name one directory. They do not: on every
   Linux volume this codebase targets, `caf` + U+00E9 and `cafe` + U+0301 are
   two directories with two inodes, and both can exist in one parent
   (demonstrated on an ext4-backed overlay host: distinct `ino`, distinct
   contents, both listed by `readdir`). Folding them together therefore *can*
   merge two genuinely different directories, exactly as unconditional case
   folding would.

   It is safe at the gate anyway, for a reason specific to the gate: the
   resolved class is `max(declared, folded)` (`selectGoverning`, and the argmax
   discussion below), so a fold that merges two distinct directories can only
   ever **over-restrict**, i.e. decline to record a directory that was in fact
   permitted. That is a usability cost
   and never a privacy or data-loss one. Case is put behind a probe rather than
   given the same treatment because case aliasing is far more likely to collide
   with a real, deliberately-distinct sibling (`Makefile` vs `makefile`) than a
   normalization difference is, not because NFC folding is universally sound.

   **Do not reuse `foldPath` as a *verdict* in a predicate where widening is not
   free.** In a *deletion* predicate (`hyp purge`) or a *disclosure* predicate,
   widening removes or reveals rows for a directory the user did not name, and
   the `max()` argument above does not apply.

   `hyp purge` closes that gap without weakening the rule, by demoting the fold
   from verdict to **candidate generator**: it proposes the spelling, and
   `sameDirectoryOnDisk` (`dev`/`ino` identity, the same test the case probe
   uses) decides. A caller that widens only on that proof cannot widen onto a
   directory the user did not name, whatever the volume's rules are, which is
   why no per-volume normalization-insensitivity probe was needed after all.
   The full argument is
   [LLP 0104 §spellings](./0104-hyp-purge.decision.md#spellings); the
   disclosure sites still have no such proof and are unchanged. See "Not
   covered".
2. **Case only behind a per-volume probe.** Case-sensitivity is a property of
   the mounted volume: an APFS volume can be formatted case-sensitive and every
   ext4 volume is. Folding it unconditionally would merge two genuinely
   different directories, which is a correctness bug in the other direction. The
   probe compares the `dev`/`ino` of a path against a case-flipped spelling of
   its last segment, memoizes by `dev`, and is inert (constant `false`, no
   syscall) off darwin. An undetermined probe resolves to "case-sensitive",
   which is the pre-fold behaviour, so a failed probe can only fail to *add*
   reach.

The fold must **distribute over the path separator**, since its only consumer is
a segment-aware prefix test: `fold(a + '/' + b) === fold(a) + '/' + fold(b)`.
Both halves do (`/` is a starter that participates in no canonical composition,
and `toLowerCase` maps it to itself), and the property is asserted rather than
assumed.

### A widened spelling must only ever add restriction

Producing a folded spelling is necessary but **not sufficient**. The
machine-local list's nearest-governs step is an **argmax over match depth**, and
an argmax discards verdicts instead of merging them. A less restrictive entry
that gains reach through its folded spelling can become the deepest match and
displace a broader restrictive entry that already governed: a `--sync` carve-out
spelled NFC would punch a hole in a private tree spelled NFD, and the directory
would **start recording and forwarding**. Nothing about "compare folded
spellings" prevents that on its own.

So nearest-governs is evaluated **twice**, once over the spellings exactly as
declared (which reproduces the pre-fold verdict) and once folded, and the **more
restrictive of the two answers wins**, the declared one breaking a class tie
because it is the spelling the user typed. The resolved class is therefore
`max(pre_fold, folded)` on the restrictiveness lattice by construction, which
makes "folding never opens the gate" structural rather than a property someone
has to remember
([LLP 0049 §fail-safe](./0049-hypignore-usage-policy.spec.md#fail-safe)).

The visible cost is that a **nested loosening does not cross spellings**: a
carve-out has to be declared in the same spelling as the entry it carves out of.
`hyp policy show` reports the class actually in force, so it is diagnosable.

Specificity is measured on the **folded** spelling, not the declared one. NFD is
longer in code units than NFC for the same name, so a declared-string depth can
rank a decomposed ancestor above a composed descendant and invert
nearest-governs.

### Cost

The per-`cwd` memo is keyed on the **lexical** path and consulted **before** any
folding, so a cache hit costs exactly what it did before. Entry spellings and
the per-volume case verdict are computed once per list parse, inside the TTL
window LLP 0049 R6 already bounds.

`String.prototype.normalize('NFC')` is roughly 60 ns on a pure-ASCII path, but
that is the case where the fold does nothing, so it is the wrong number to plan
against. When the string is **already** composed, normalize verifies and
returns: about 60 ns for a short ASCII path and about 90 ns for a 114-character
path with accented segments. When it is genuinely decomposed, which is exactly
the macOS case this section exists for, it has to recompose: about **550 ns**
for a 134-character NFD path, roughly 9x the ASCII figure, and it scales with
length (about 9.6 us for a pathological 1000-character all-decomposed path).

That is affordable only because of where it sits. Folding is on the cache-**miss**
path (once per `cwd` per TTL window) and on the list parse (once per entry per
window), never per exchange. A miss over a 20-entry list with a long NFD `cwd`
measures about 8.2 us before this change and 9.7 us after. A caller that ever
moves the fold onto a per-row or per-exchange path has to re-measure with a
decomposed path, not an ASCII one.

### Relationship to the symlink class

This is the same shape [§canonicalization](#canonicalization) arrives at for
symlinks, for the same reason, and the two were found by the same review. They
are independent in *what* they fold - `realpath` cannot fold case or
normalization, and folding cannot resolve a symlink - but not in *how* they are
guarded, so they landed as one mechanism rather than two.

The composition is a `map`, not a second set: `realpath` yields a **set** of
spellings, the fold is a **function** on a spelling, so the widened set is the
fold's image of the canonical set (`listScope` in `matcher.js`). And there is
exactly **one** two-pass argmax guard, evaluated over declared-and-unfolded
versus widened-and-folded, because the displacement hazard is identical whichever
mechanism gave a carve-out its extra reach. Running the guard twice would buy
nothing; running it once over the composed set is what makes
`class = max(pre_widening, widened)` hold for both mechanisms at once.

### Not covered

The fold is applied unconditionally at the **gate** (`resolve` / list
membership) and nowhere else. The one-shot CLI membership sites (`hyp ignore
--check`, `policy show`, `policy unset`) and `hyp purge --subtree` route through
the shared spelling-aware predicates [§canonicalization](#canonicalization)
introduced (`scopeGoverns`, `sameDirectory`, `governingListEntry`), so they fold
**symlinks** with the gate, but those predicates deliberately stop short of
taking `foldPath`'s word for anything (`canonicalScope` in `matcher.js`, as
against `listScope`). On a case-insensitive or NFD-carrying volume they can
therefore still disagree with the gate about normalization and case.

That is the "widening is not free" rule above, not an oversight. `hyp purge` is
the one site that has since bought the widening rather than declining it: it
passes `proveAliases`, which folds only to *propose* a spelling and then
requires `dev`/`ino` identity before deleting through it
([LLP 0104 §spellings](./0104-hyp-purge.decision.md#spellings)). The remaining
sites below are unchanged, and their gap is stated as it was.

The disagreement is bounded in one direction and not in the other, and the
difference matters enough to name each site:

- **The CLI can never promise more protection than the gate delivers.** The
  lexical predicate matches a subset of what the folded one does, and the gate's
  class is `max(declared, folded)`, so any entry the CLI finds the gate also
  found. There is no spelling on which `--check` reports a directory protected
  while the gate forwards it.
- **`hyp ignore --check` / `policy show` report the right class and can name the
  wrong scope.** The class comes from `resolve()`, so it is folded and correct.
  Only the "which listed directory governs this?" lookup (`governingListEntry`)
  is unfolded, so when the entry reaches `cwd` only by folding it falls back to
  the queried path. The class is right; the governing directory shown, and the
  residual row count scoped to it, are narrower than the truth. Note that the
  row count makes this a *disclosure* predicate, which is why it does not simply
  inherit the gate's fold either.
- **`policy unset` / `unignore --local-only` can refuse to remove an entry the
  gate is enforcing**, when the user spells the path the other way. It reports
  "not governed" and exits 0. That fails toward privacy: the opt-out stays on.
- **`hyp purge <path>` (the subtree target) is now covered**, and was the one
  site that failed **away** from privacy: it used to silently retain rows
  recorded under a different spelling of the target, printing
  `purged 0 rows from 0 partitions` on stdout, nothing on stderr, and exiting 0
  - an outcome indistinguishable from "that directory had nothing cached", and
  the *quieter* of its two paths, since a purge that deletes prints the
  resurrection warning. It closed by
  [LLP 0104 §spellings](./0104-hyp-purge.decision.md#spellings) rather than by
  the fold, on the argument that a deletion may widen onto a spelling the
  filesystem identifies with the target and onto no other; where it cannot
  prove that, it still retains the rows, but now names them.

- **`hyp purge --ignored` is already covered by this change**, because that
  target classifies each row through `resolver.resolve(row.cwd)` rather than
  through a lexical prefix test, so it inherits the fold. Verified against
  `master`: with an `ignore` entry declared NFC and rows recorded NFD, `master`
  purges 0 rows and leaves the row, and this branch purges it. It was the
  durable workaround for the subtree gap above while that gap was open.

The subtree gap was **not** closed by dropping `foldPath` into the predicate,
and whoever revisits the remaining sites should keep the reason in view. Purge
deletes, so widening the match is not free the way it is at the gate (see "NFC
unconditionally, and only because this is the gate"): on a Linux volume, folding
would delete cached rows for a genuinely different sibling directory that
differs only by normalization. What it took instead was making the fold
non-authoritative there - a candidate generator whose proposal `dev`/`ino`
identity has to confirm - so that no volume-level assumption is load-bearing in
a destructive predicate. The disclosure sites (`--check` / `policy show`'s
residual row count) have no equivalent proof available, since they answer about
a directory rather than about a pair of spellings, so they stay unfolded.

## Consequences

- Code that lands this carries `@ref LLP 0050 [implements]` on the adapter
  projector/backfill drop sites and on the `src/core/usage-policy/` matcher.
- Every consumer of the shared matcher inherits
  [§canonicalization](#canonicalization) for free; no adapter, `hyp purge`, or
  query-seam change is needed to gain it, which is the same argument that put the
  matcher in core in the first place.
- The gateway source and recorder are not modified.
- A future caller-supplied `cwd` for raw-proxy traffic would add a *new* call
  site that reuses the same core matcher — no change to this decision.
- The ephemeral per-session opt-out ([LLP 0066](./0066-session-opt-out.spec.md))
  reuses this same adapter drop with a *different key*: it matches on the
  `session_id` the adapter resolves instead of on `cwd`, and returns the same
  `USAGE_POLICY_DROP` sentinel. That mechanism adds a gateway *control route* and
  an in-memory set of opaque `session_id` strings, but the gateway still performs
  no drop and interprets no identity, so this decision holds unchanged.
