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

   **Do not reuse `foldPath` in a predicate where widening is not free.** In a
   *deletion* predicate (`hyp purge`) or a *disclosure* predicate, widening
   removes or reveals rows for a directory the user did not name, and the
   `max()` argument above does not apply. Closing the purge seam below needs
   either a per-volume normalization-insensitivity probe (no such probe exists;
   the current one answers only the case question) or a darwin-only guard.
   See "Not covered".
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

This is the same shape PR #482 (LLP 0049 issue #479) arrives at for symlink
canonicalization, for the same reason, and the two were found by the same
review. They are independent: `realpath` cannot fold case or normalization, and
folding cannot resolve a symlink. Whichever lands second should collapse the two
two-pass evaluations into **one** pass over one spelling set rather than keep
two, since running the argmax guard twice buys nothing.

### Not covered

The fold is applied at the **gate** (`resolve` / list membership). The one-shot
CLI membership sites (`hyp ignore --check`, `policy show`, `policy unset`) and
`hyp purge --subtree` still compare lexically, so on a case-insensitive or
NFD-carrying volume they can disagree with the gate. Those sites are exactly
what #482 reroutes through a single shared spelling-aware predicate; they should
adopt the fold there, once, rather than grow a second copy of the rule.

The disagreement is bounded in one direction and not in the other, and the
difference matters enough to name each site:

- **The CLI can never promise more protection than the gate delivers.** The
  lexical predicate matches a subset of what the folded one does, and the gate's
  class is `max(declared, folded)`, so any entry the CLI finds the gate also
  found. There is no spelling on which `--check` reports a directory protected
  while the gate forwards it.
- **`hyp ignore --check` / `policy show` report the right class and can name the
  wrong scope.** The class comes from `resolve()`, so it is folded and correct.
  Only `resolveCheckScopeDir`'s "which listed directory governs this?" lookup is
  lexical, so when the entry reaches `cwd` only by folding it falls back to the
  queried path. The class is right; the governing directory shown, and the
  residual row count scoped to it, are narrower than the truth.
- **`policy unset` / `unignore --local-only` can refuse to remove an entry the
  gate is enforcing**, when the user spells the path the other way. It reports
  "not governed" and exits 0. That fails toward privacy: the opt-out stays on.
- **`hyp purge <path>` (the subtree target) silently retains rows it was asked
  to delete**, when the rows were recorded under a different spelling of the
  target. This is the one site that fails **away** from privacy: the user asked
  for data to be deleted, the command reports success, and the rows remain.
  Observed end to end (rows recorded NFD, purge argument NFC, and the reverse;
  also a case alias):

  ```
  # the argument is typed NFC; the rows were recorded under the NFD spelling.
  # the two render identically, which is the whole problem.
  $ hyp purge ~/café/proj --yes
  purged 0 rows from 0 partitions
  $ echo $?
  0
  ```

  Nothing is written to stderr and the exit status is 0, so the outcome is
  indistinguishable from "that directory had nothing cached". Note the
  inversion: a purge that *succeeds* prints the resurrection warning on stderr,
  so the failing case is the **quieter** of the two. It is unchanged from the
  pre-fold behaviour rather than introduced here, and it is tracked separately;
  it is the reason this seam should not stay open for long.

- **`hyp purge --ignored` is already covered by this change**, because that
  target classifies each row through `resolver.resolve(row.cwd)` rather than
  through a lexical prefix test, so it inherits the fold. Verified against
  `master`: with an `ignore` entry declared NFC and rows recorded NFD, `master`
  purges 0 rows and leaves the row, and this branch purges it. So marking the
  directory and running `hyp purge --ignored` is the durable workaround for the
  subtree gap above until that gap is closed.

Whoever closes the subtree gap should note that it is **not** a matter of
dropping `foldPath` into the predicate. Purge deletes, so widening the match is
not free the way it is at the gate (see "NFC unconditionally, and only because
this is the gate"): on a Linux volume, folding would delete cached rows for a
genuinely different sibling directory that differs only by normalization. The
fix needs the fold gated on the volume actually being normalization-insensitive,
and the shared predicate PR #482 introduces (`scopeGoverns`, which reroutes this
same purge call site for the symlink class) is the right place to put it.

## Consequences

- Code that lands this carries `@ref LLP 0050 [implements]` on the adapter
  projector/backfill drop sites and on the `src/core/usage-policy/` matcher.
- The gateway source and recorder are not modified.
- A future caller-supplied `cwd` for raw-proxy traffic would add a *new* call
  site that reuses the same core matcher — no change to this decision.
- The ephemeral per-session opt-out ([LLP 0066](./0066-session-opt-out.spec.md))
  reuses this same adapter drop with a *different key*: it matches on the
  `session_id` the adapter resolves instead of on `cwd`, and returns the same
  `USAGE_POLICY_DROP` sentinel. That mechanism adds a gateway *control route* and
  an in-memory set of opaque `session_id` strings, but the gateway still performs
  no drop and interprets no identity, so this decision holds unchanged.
