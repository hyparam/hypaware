# LLP 0069: interactive local-only directory selection at enrollment

**Type:** Spec
**Status:** Accepted
**Systems:** Sinks, CLI, Onboarding, Config
**Author:** Phil / Claude
**Date:** 2026-07-06
**Related:** LLP 0049, LLP 0050, LLP 0051, LLP 0063, LLP 0037, LLP 0044, LLP 0031, LLP 0014, LLP 0022, LLP 0030, LLP 0015

> When `hyp remote login` enrolls a machine into an org's fleet
> ([LLP 0063](./0063-login-auto-provision-forward-sink.decision.md)), the host
> starts forwarding captured logs to the org's server. This spec adds one
> attended step at that moment: enumerate the working directories the user has
> actually run Claude/Codex in (from captured `cwd`), let them multi-select the
> ones that must **never leave this machine**, and persist that choice so the
> export pipeline forwards everything *except* those directories. The selected
> directories become [`local-only`](./0051-usage-policy-future-extensions.decision.md#local-only):
> still recorded to the local cache — fully queryable here — but never exported
> or forwarded.

## Motivation

[LLP 0063](./0063-login-auto-provision-forward-sink.decision.md) closes the
one-command enrollment loop: a member of a domain-claimed org runs `hyp remote
login` and the machine immediately forwards captured logs to the org server,
including — via [LLP 0037](./0037-backfill-on-join.decision.md) backfill,
default-on — pre-existing local history. LLP 0063 calls this out plainly as the
**BYOD consequence**: a *personal* machine that matched a claimed email domain
now ships its local Claude/Codex history to the org, and the pre-auth notice
(LLP 0063 D3) is the *one* moment a user can decline — but declining there is
all-or-nothing (`--no-forward` opts out of enrollment entirely).

A developer routinely runs Claude and Codex across a mix of directories: the
org's repos (which the org legitimately wants), and personal or sensitive trees
(a side project, a client under NDA, `~/personal-notes`) that happen to live on
the same laptop. All-or-nothing enrollment forces a bad choice: forward
everything, or forward nothing. This spec adds the missing **per-directory**
granularity, at the exact moment it becomes relevant (the machine is about to
start forwarding), using data HypAware already has (every captured exchange
carries its `cwd`).

This does not invent a new privacy primitive. It ships the `local-only` usage
class that [LLP 0049](./0049-hypignore-usage-policy.spec.md) reserved and
[LLP 0051 §local-only](./0051-usage-policy-future-extensions.decision.md#local-only)
deferred, and drives it from an interactive picker instead of hand-authored
files.

## What this is, in one sentence

An **attended, skippable directory picker** at enrollment time that writes a
**machine-local `local-only` list**, honored by the **export seam** so the
selected directories are recorded locally but never forwarded.

Each half is a settled choice recorded as its own decision:

- **`local-only` enforced at the export seam, derived from `cwd`** —
  [LLP 0070](./0070-local-only-export-seam.decision.md).
- **A machine-local private list, not committable dotfiles and not central
  config** — [LLP 0071](./0071-machine-local-exclusion-list.decision.md).
- **The picker is a post-enrollment refinement, not an enrollment consent
  gate** — [LLP 0072](./0072-enrollment-dir-picker.decision.md).

## Relationship to the neighbouring mechanisms {#neighbours}

This feature sits between three existing usage-policy mechanisms and reuses their
machinery rather than competing with them:

| Mechanism | Scope | Class / effect | Lifetime | Where authored |
|---|---|---|---|---|
| `.hypignore` ([LLP 0049](./0049-hypignore-usage-policy.spec.md)) | directory subtree | `ignore` (not recorded) | persistent, committable | repo dotfile |
| session opt-out ([LLP 0066](./0066-session-opt-out.spec.md)) | one client session | ephemeral drop (not recorded) | in-memory | `/hypaware-ignore` skill |
| **this spec** | directory subtree | **`local-only` (recorded, not forwarded)** | **persistent, machine-local** | **login picker + CLI** |

The distinctions that make this a separate mechanism, not a variant:

- **Versus `.hypignore` / session opt-out (both `ignore`-class):** those *drop
  the row at the capture seam* — nothing is recorded, so nothing is queryable
  locally either. This spec's `local-only` keeps the row: the user retains full
  local HypAware value (query, graph, backfill) for the excluded directory and
  only withholds it from the *remote*. "Do not send this to my employer" is a
  strictly weaker, and far more commonly wanted, request than "do not record
  this at all."
- **Versus `.hypignore`'s authoring surface:** `.hypignore` is a per-repo
  committable dotfile shared with the whole team. This spec's choice is a
  *private, per-machine* one ([LLP 0071](./0071-machine-local-exclusion-list.decision.md)):
  it must not modify or commit files inside the user's repos, must not reveal the
  choice to teammates, and must be able to name directories that are not git
  repos or no longer exist.

The mechanisms are **independent at enforcement time** and compose: a directory
governed by both a `.hypignore` (`ignore`) and the `local-only` list resolves to
the most restrictive class (`ignore` wins — it is never recorded, so the question
of forwarding never arises). See [LLP 0070 §resolver](./0070-local-only-export-seam.decision.md#resolver).

## The trigger: after login, before provisioning {#trigger}

The picker runs inside the enrolling `hyp remote login` flow (`runBrowserLogin`,
`src/core/cli/remote_commands.js`), **after** the gateway credential is confirmed
(the server minted `session.gateway`, so enrollment will proceed) and the
`--no-forward` early-return is passed, and **before** `enrollCentralSink`. That
one call writes the `@hypaware/central` sink seed, seeds the identity, and installs
the daemon **together** (`remote_commands.js:428`, [LLP 0063 D5](./0063-login-auto-provision-forward-sink.decision.md));
there is no separable "after sink-write, before daemon-install" seam, so the
picker sits *before the whole provisioning step*.

This ordering is a **hard requirement, not a convenience** (R6): the whole point
is that no exchange from an excluded directory is *ever* forwarded, not even once.
Forwarding (and backfill export) begins only when the daemon `enrollCentralSink`
installs starts materializing the central sink, so persisting the `local-only`
list *before* `enrollCentralSink` guarantees the export read sees the exclusions
on its very first pass. Running the picker before provisioning has a second
benefit: if it is dismissed or abandoned, nothing has been provisioned yet — there
is **no half-enrolled window** (see [dismiss semantics, LLP 0072 §default](./0072-enrollment-dir-picker.decision.md#default)).

> **Revisited-by [issue #281] (fresh-enroll ordering).** As shipped, running the
> picker *before* provisioning had a self-defeating consequence this spec did not
> foresee: the candidate list ([enumerate](#enumerate)) is the distinct captured
> `cwd`s in the **local cache**, but on a first-time enroll that cache is empty
> until the daemon (installed *by* `enrollCentralSink`) attaches and backfills. So
> the pre-provision picker enumerated nothing and silently skipped on every fresh
> enroll, precisely its primary trigger. The bugfix defers the picker past
> `enrollCentralSink` on the auto-daemon fresh-enroll path so it runs against the
> now-populated cache. The `--no-daemon` fresh-enroll fork also now runs the
> picker after `enrollCentralSink` writes the sink config (it is no longer
> literally *pre-provision*), but since `--no-daemon` installs no forwarding
> daemon this run, the list still lands before *any* export, so R6's substantive
> "not forwarded, even once" guarantee holds there unchanged; the re-login fork
> runs against the cache a prior daemon already filled. This narrows R6's "not
> forwarded, even once" to "withheld from every export tick after the pick" only
> on the auto-daemon fresh-enroll path (a one-time backfill window may forward
> before the user picks). Closing that window fully (hold forwarding until
> the pick, or backfill locally before the forward daemon starts) is deferred to
> the follow-up tracked in [issue #281]; this record's decision is otherwise
> unchanged.

The picker only makes sense on an **enrolling** login (one that provisions or
already has a central sink). A `--no-forward` / query-only login
([LLP 0063 D3](./0063-login-auto-provision-forward-sink.decision.md)) forwards
nothing, so there is nothing to exclude and the picker is skipped.

## Enumerating the candidate directories {#enumerate}

The candidate list is the **distinct set of working directories the user has run
Claude or Codex in**, read from the local cache. Every captured exchange carries
its `cwd` as a first-class column on the `ai_gateway_messages` dataset
(`hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js`; the
client hook records it into `session-context.jsonl` and the projector stamps it —
[LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)). Enumeration is a
read-only query over the local cache via the core query engine
([LLP 0015](./0015-query-and-datasets.spec.md), `executeQuerySql`), conceptually:

```sql
SELECT cwd, repo_root, COUNT(*) AS rows, MAX(date) AS last_seen
FROM ai_gateway_messages
WHERE cwd IS NOT NULL
GROUP BY cwd, repo_root
ORDER BY last_seen DESC
```

- Querying is **local-only** ([LLP 0031](./0031-layered-config.decision.md),
  [LLP 0033](./0033-remote-query-attach.spec.md)); enumeration reads this
  machine's own cache, never the remote.
- `repo_root`, row counts, and last-seen are carried so the picker can present a
  useful, ranked list (most-recent-first) with enough context to decide — not a
  bare list of paths (R3).
- The set is derived from **whatever is already captured** at login time. A
  directory the user starts working in *after* enrollment is not in the list;
  the durable follow-up authoring path (R7) covers that case.

## Persistence: the machine-local `local-only` list {#persist}

Selections are written to a **single machine-local file** under `HYP_HOME`, not
to any repo and not to layered/central config — the persistence-form decision is
[LLP 0071](./0071-machine-local-exclusion-list.decision.md). The file holds a
versioned set of absolute directory paths; a captured `cwd` is `local-only` when
it equals, or is a path-segment descendant of, any listed directory (ancestor
match, mirroring `.hypignore` semantics — [LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope)).

## Enforcement: the shared export read drops local-only rows {#enforce}

Enforcement is [LLP 0070](./0070-local-only-export-seam.decision.md): the shared
export read (`storage.readRowsSince`, the one seam the `@hypaware/central` forward
sink and every blob/Iceberg sink funnel through — [LLP 0014](./0014-sinks.spec.md))
consults the shared usage-policy resolver
([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)) for **each row's**
`cwd` and drops the ones that resolve to `local-only` before they reach any sink.
It is a **per-row** filter, not a partition skip: the physical cache partition is
`source=<client>` and mixes many directories, so `cwd` cannot select a partition
— but every sink already scans every row, so the resolver call (memoized per
`cwd`) is nearly free. Local *query* uses a different read path
([LLP 0015](./0015-query-and-datasets.spec.md)), so `local-only` rows stay locally
queryable — the essence of `local-only` vs `ignore`. The verdict is **derived at
export time** from the row's existing `cwd` and the machine-local list, needing
**no cache-schema change** and no capture-time marker.

This is what makes the semantics correct for **already-captured history**: rows
recorded (or backfilled) before the user made the selection sit in the cache with
their `cwd`, and the export read simply never forwards the ones that now resolve
to `local-only`. No purge, no retroactive rewrite — the backlog is withheld by
construction ([LLP 0051 §local-only](./0051-usage-policy-future-extensions.decision.md#local-only)).

## Consent and the fleet-policy doctrine {#consent}

Two settled positions bear on this feature and neither is overturned:

- **LLP 0063 D3 — "login never prompts `y/n`."** That rule governs *consent to
  enroll*: enrollment must not be gated behind an interactive confirm (it would
  break the one-command promise and hang piped flows). This picker is **not** a
  consent gate ([LLP 0072](./0072-enrollment-dir-picker.decision.md)): enrollment
  has already happened when it runs, it defaults to excluding **nothing**,
  pressing Enter / Ctrl-C proceeds with zero exclusions, and it is skipped
  entirely when stdin/stderr is not a TTY. It refines a decision already made; it
  never blocks or re-litigates it.
- **LLP 0037 / 0044 — "no local opt-out" of locked fleet policy.** Those forbid a
  machine from locally overriding *central-owned topology* (dropping the central
  sink, skipping backfill). `local-only` is not that: it is a **local privacy
  control** in the [LLP 0049](./0049-hypignore-usage-policy.spec.md) family, which
  [LLP 0049 non-goal 3](./0049-hypignore-usage-policy.spec.md#non-goals) already
  places *outside* the layered-config/central-authority model ("honored whenever
  found," never merged or pushed by central). The decisive precedent: `.hypignore`
  `ignore` **already** withholds directories from an enrolled machine's
  forwarding, so `local-only` (which withholds *less* — it still records locally)
  opens no new hole. The central sink still exists and still forwards everything
  the user did *not* mark private; the user drops no fleet machinery. The full
  reconciliation is [LLP 0071 §doctrine](./0071-machine-local-exclusion-list.decision.md#doctrine).
  Whether an org may *forbid* `local-only` exclusions
  (force-forward everything) is a future central-policy concern, named in
  [LLP 0072 §org-policy](./0072-enrollment-dir-picker.decision.md#org-policy) and
  out of V1 scope, exactly as LLP 0063 named the server-side `login_enrollment`
  knob.

## Non-goals {#non-goals}

1. **No retroactive deletion / purge.** Like [LLP 0049 §prospective-only](./0049-hypignore-usage-policy.spec.md#prospective-only),
   this spec withholds excluded directories from *future* forwarding (including
   the backfill of already-cached rows). It does **not** delete rows already
   forwarded to the remote before a directory was excluded; server-side deletion
   is a separate, destructive capability out of scope.
2. **Not a per-session or per-conversation control.** Directory-scoped only.
   Ephemeral "don't record this conversation" is [LLP 0066](./0066-session-opt-out.spec.md);
   full "never record this tree" is [LLP 0049](./0049-hypignore-usage-policy.spec.md).
3. **Raw-proxy / OTEL traffic is directory-blind.** Those paths carry no `cwd`
   ([LLP 0049 non-goal 1](./0049-hypignore-usage-policy.spec.md#non-goals),
   [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)); a directory
   exclusion is structurally a no-op for them and this spec does not change that.
4. **Not central/fleet config.** The list is machine-local and is never pushed,
   pulled, or merged with central config ([LLP 0071](./0071-machine-local-exclusion-list.decision.md)).
5. **No live-call effect.** Like every usage-policy mechanism, exclusion
   suppresses only *persistence/forwarding*; the proxied LLM call is untouched
   ([LLP 0049 R2](./0049-hypignore-usage-policy.spec.md#requirements)).

## Requirements {#requirements}

- **R1.** On an **enrolling** `hyp remote login` (one that provisions or already
  targets a `@hypaware/central` sink), and only when stdin/stderr is an
  interactive TTY, the flow MUST present the distinct captured working
  directories and let the user multi-select any subset to mark `local-only`. A
  non-TTY (piped / MDM) login MUST skip the picker with zero exclusions and MUST
  NOT hang. A `--no-forward` login MUST skip the picker (nothing is forwarded).
- **R2.** The candidate directories MUST be the distinct non-null `cwd` values in
  the local `ai_gateway_messages` cache, read via the local query engine
  ([LLP 0015](./0015-query-and-datasets.spec.md)); enumeration MUST NOT contact
  the remote.
- **R3.** The picker MUST show enough context to choose (at minimum the path;
  SHOULD include `repo_root`, exchange count, and last-seen), ordered
  most-recently-active first.
- **R4.** Selections MUST be persisted to a machine-local list under `HYP_HOME`
  ([LLP 0071](./0071-machine-local-exclusion-list.decision.md)); the flow MUST
  NOT write into, or commit to, any of the user's repositories, and MUST accept
  paths that are not git repos or no longer exist.
- **R5.** A captured exchange whose `cwd` equals or is a path-segment descendant
  of any listed directory MUST be treated as `local-only`: recorded to the local
  cache as normal and remaining **locally queryable**, but **dropped from the
  shared export read** so it reaches no sink
  ([LLP 0070](./0070-local-only-export-seam.decision.md)) — central forward, blob,
  and Iceberg export alike. This MUST hold for already-cached rows (including
  backfilled history), with no cache-schema change and no purge. The export cursor
  MUST advance past a dropped row so it is neither re-scanned each tick nor re-sent
  if the directory is later un-excluded ([LLP 0070 §incremental](./0070-local-only-export-seam.decision.md#incremental)).
- **R6.** The selection MUST be persisted **before** `enrollCentralSink` — the
  step that provisions the sink and installs the forwarding daemon together
  ([LLP 0063 D5](./0063-login-auto-provision-forward-sink.decision.md),
  `remote_commands.js:428`) — so no excluded-directory row is forwarded even once,
  and so a dismissed/abandoned picker leaves no half-enrolled machine (see
  [trigger](#trigger)).
- **R7.** A durable, non-login authoring path MUST exist so a user can review and
  edit the `local-only` list later (directories worked in after enrollment, or a
  mistaken selection) without re-running login — e.g. `hyp ignore --local-only
  [path]` / a list-management command
  ([LLP 0072 §cli](./0072-enrollment-dir-picker.decision.md#cli)).
- **R8.** `local-only` matching MUST reuse the single shared resolver in
  `src/core/usage-policy/` ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md#shared-matcher-in-core),
  [LLP 0049 R4](./0049-hypignore-usage-policy.spec.md#requirements)) — the same
  matcher `.hypignore` uses, extended with the machine-local list as a second
  source — never a second copy of path logic.
- **R9.** `hyp status` MUST surface the presence and size of the `local-only`
  list (how many directories are withheld from forwarding), so an "enrolled but
  withholding" machine is never a silent state
  ([LLP 0063](./0063-login-auto-provision-forward-sink.decision.md) never-silent
  ethos).

## `@ref` annotations code will carry {#refs}

- The picker in `runBrowserLogin` (enumerate → multi-select → persist, pre-daemon):
  `@ref LLP 0069#trigger [implements]`, `@ref LLP 0072 [implements]`.
- The distinct-`cwd` enumeration query helper:
  `@ref LLP 0069#enumerate [implements]`.
- The export-read row filter (`storage.readRowsSince`): `@ref LLP 0070#enforce [implements]`
  (see LLP 0070 for its own annotation map).
- The machine-local list reader/writer and the resolver's second source:
  `@ref LLP 0071 [implements]`, alongside the existing `@ref LLP 0050` on the
  shared resolver.

## Open questions {#open}

- **Enumeration cost on large caches.** `SELECT DISTINCT cwd` over a big cache is
  cheap relative to a login round-trip, but the bounded-query-execution work
  ([LLP 0054](./0054-bounded-query-execution.spec.md)) may bear on how the picker
  streams/limits the candidate list. Resolve in the design doc that follows.
- **Presentation of very large candidate lists.** If a user has hundreds of
  distinct `cwd`s, the multi-select needs a sensible cap / grouping (e.g. collapse
  by `repo_root`). A design concern, not a spec constraint.
- **Codex `repo_root` is null by design** (the Codex adapter leaves it unset);
  the picker groups Codex directories by `cwd` alone. Confirm the display copy in
  the design.
