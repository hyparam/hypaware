# LLP 0031: Layered config — central (authoritative) + local (additive)

**Type:** Decision
**Status:** Active
**Systems:** Config
**Author:** Phil / Claude
**Date:** 2026-06-16
**Related:** LLP 0003, LLP 0004, LLP 0009, LLP 0010, LLP 0011, LLP 0013, LLP 0014, LLP 0017, LLP 0025; hypaware-server LLP 0009 (out of tree, design authority)

> A joined gateway boots an **effective config that is the merge of two
> layers**: a server-owned **central** layer (authoritative, locked) and a
> user-owned **local** layer (additive-only). `hyp join` writes only the
> central layer, so it can no longer destroy a working local install
> ([#111](https://github.com/hyparam/hypaware/issues/111)). Supersedes the
> "wholesale replace, no merging, no client-owned sections" decision in
> [LLP 0025](./0025-remote-config-join-flow.spec.md#apply-semantics-staged-restart)
> for centrally-managed hosts.

> **Status note:** implemented (issue #111). The normative prose in
> [LLP 0025](./0025-remote-config-join-flow.spec.md) and
> [LLP 0010](./0010-config-model.spec.md) is rewritten for layering, and the
> code carries the `@ref`s listed in [Annotations](#annotations-to-add-when-code-lands).
> Boot-time merge: `src/core/config/merge.js`; central-layer paths + the
> relocated pointer + seed retirement: `src/core/config/apply.js`; status
> provenance: `src/core/daemon/status.js`; the `init` overwrite guard:
> `prepareLocalConfigWrite` in `src/core/config/schema.js`.

## Problem

`hyp join <url> <token>` on a machine that already has a working install
**overwrites the entire config** with a central-only seed (no read, no merge, no
backup). Root cause: the daemon boots exactly **one operative config**
(`boot.js` loads a single `configPath`), and a server pull **replaces it
wholesale** — [LLP 0025 §Apply semantics](./0025-remote-config-join-flow.spec.md#apply-semantics-staged-restart):
*"a full HypAware v2 config and replaces the operative config wholesale — no
merging, no client-owned sections."* `join` writes its seed to that **same
path**, so it removes the local `@hypaware/ai-gateway` source, all local sinks,
and client attach wiring → Claude Code, Codex, **and** local recording all break,
with no last-known-good to roll back to (the CLI seed write happens *before* the
daemon's apply/rollback machinery ever runs).

An overwrite guard (`--force` + backup) was considered and rejected: it makes the
outage recoverable but does not prevent it, and it leaves the real defect — that
joining a fleet *replaces* local observability instead of *augmenting* it —
in place.

## Two layers, merged at boot

A host's effective config is the merge of:

- **Central layer** — server-owned, **authoritative/locked**. The document
  pulled via `GET /v1/config` and persisted by the apply engine
  ([LLP 0025](./0025-remote-config-join-flow.spec.md#apply-semantics-staged-restart)),
  or, before the first pull, the join **seed**.
- **Local layer** — user-owned, **additive-only**. `hypaware-config.json`,
  authored by `init` / `attach` / `plugin install`. It may only contribute
  entries the central layer does not name; it can never override or remove a
  central-named entry.

`effective = merge(central, local)`, computed at boot. **When no central layer
exists (a host that never joined), `effective = local`** — so non-joined installs
are completely unaffected by this design, in behaviour and on disk.

Locking model (chosen over a richer per-section override scheme): the **whole
central document is authoritative**; the user layer is purely **additive**. This
keeps the merge predictable and preserves the fleet guarantee that a user cannot
disconnect a managed host (see [server coordination](#server-coordination)).

## Merge model

Merge is **keyed per config section** (`schema.js` `RECOGNIZED_TOP_KEYS`):

| Section | Merge key | Rule |
|---|---|---|
| `plugins[]` | plugin `name` | central-named plugins are locked; local may add plugins central does not name |
| `sinks{}` | instance name | central-named sink instances are locked; local may add new instance names |
| `disambiguate{}` | capability name | central wins per capability; local may add capabilities central does not set |
| `query{}` | — | **local-only** (see below) |
| `version` | — | must be `2` in both; not a merge concern |

General rule: **union keyed by each section's natural key; central wins and
locks any key it names; local contributes only the keys central omits.** A local
entry that collides with a central-named key is *dropped*, not merged (see
[central is sacrosanct](#central-layer-is-sacrosanct)).

### Query is local-only

`query{}` (cache dir + retention + Iceberg maintenance — [LLP 0013](./0013-local-query-cache.decision.md),
[LLP 0027](./0027-cache-settlement.decision.md)) is **structurally local-only;
the central layer never owns it.** Rationale:

- `query.cache.dir` is a machine-specific filesystem path — a fleet operator
  authoring one config for many machines cannot sensibly set it.
- `query.cache.maintenance` is disk-dependent performance tuning — local.
- `query.cache.retention` is the *only* part with a real central rationale
  (compliance: "retain ≤ N days fleet-wide"), but locking the whole `query`
  block to capture it would wrongly drag in the machine-specific `dir`.

So `query` is the one principled carve-out from "whole central document
authoritative": the central layer governs the collect/export **topology**
(`plugins`, `sinks`, `disambiguate`); the local layer owns **machine storage**
(`query`). A `query` block appearing in a central document is **ignored with a
warning** and surfaced in `hyp status`. **Fleet-enforced retention policy is
deliberately deferred** — when wanted, add `query.cache.retention` as an
explicitly central-ownable sub-key with proper min/max policy semantics, not by
locking the whole block.

## Central layer is sacrosanct

All merge failures fall on the **local** layer; the central layer always boots.
Validation happens at two points with a hard asymmetry:

1. **Apply-time** (`apply.js`, unchanged in spirit): the apply engine
   shape-checks, installs pinned plugins, and validates the **central layer
   standalone** — exactly as today ([LLP 0025 §Install-on-config](./0025-remote-config-join-flow.spec.md#install-on-config-hash-pinned)).
   Probation, rollback, and `If-None-Match` convergence depend **only** on the
   central layer. A local edit can never trigger a central rollback or affect
   fleet convergence.
2. **Boot-time** (`boot.js` → `resolveLayeredConfig` in `merge.js`): merge
   central ⊕ local and validate the merge. **Any local entry that collides with a
   central-named key, or that makes the merge fail `config validate` (a
   `disambiguate`-less capability tie a local plugin introduces, an additive sink
   that names an unknown/incompatible plugin, an unknown local plugin), is dropped
   with a loud warning; the central layer always boots.** Mechanically: validate
   the central layer alone for a baseline, then add each surviving local entry
   back one at a time and keep it only when it introduces no error beyond that
   baseline — a maximal valid additive subset, so an error the central document
   carries on its own never blames the local layer. Richer cross-entry checks
   (two sources producing the same dataset table — [LLP 0000](./0000-hypaware.explainer.md#cross-cutting-invariants),
   a port clash) ride along automatically as `config validate` learns to catch
   them; they are not special-cased here.

Two guarantees this buys, both central to #111:

- A garbage local edit cannot take down fleet reporting (the central seed always
  boots) — so the "daemon crashloops with no last-known-good" failure mode is
  structurally impossible.
- Local additions are best-effort: valid ones merge, conflicting ones drop and
  surface, but they never escalate to a central-layer failure.

*Failing boot* on a bad local addition was rejected: it reintroduces the exact
outage class #111 is about (one bad local line stalls the gateway).

## Physical layout

Three distinct roles, splitting today's overloaded `hypaware-config.json` (which
is *both* the user-facing config *and* the operative pointer-to-slot):

| Role | Path | Writer | Lifetime |
|---|---|---|---|
| **Local layer** | `hypaware-config.json` (or `HYP_CONFIG`) | `init`, `attach` | regular file, may be absent |
| **Central seed** | dedicated file, mode `0600` (holds the policy token) | `join` | retired after first successful apply |
| **Central layer (applied)** | `config-control/config.{a,b}.json` + etag sidecars + `state.json` | daemon apply engine | A/B slots, as [LLP 0025](./0025-remote-config-join-flow.spec.md#apply-semantics-staged-restart) |

Consequences:

- **`join` writes only the central seed** — never `hypaware-config.json`. This is
  the fix: the local layer is untouched, so #111 dissolves by construction. It
  moves today's seed file (which the apply engine already adopts on first apply)
  off the `hypaware-config.json` path onto a dedicated central-seed path, keeping
  the CLI out of the kernel-owned slot machinery
  ([LLP 0025 §apply engine is kernel surface](./0025-remote-config-join-flow.spec.md#apply-engine-is-kernel-surface)).
- **The active-slot pointer relocates** from `hypaware-config.json` into
  `config-control/` (today `activeSlot()` reads the symlink *at* the operative
  config path). The atomic symlink-flip crash-safety of
  [LLP 0025](./0025-remote-config-join-flow.spec.md#apply-semantics-staged-restart)
  is preserved — just relocated — freeing `hypaware-config.json` to be a plain
  user file.
- **Boot resolves both layers read-only**: central = active slot **else** seed
  **else** none; local = `hypaware-config.json` **else** none. *Reading* the
  central layer is fine in any boot (CLI or daemon); only the daemon runs the
  apply *engine* that writes it — so `hyp status` / `hyp query` show the correct
  merged config without firing config polls (consistent with LLP 0025: CLI boots
  leave `ctx.configControl` undefined). The same resolution is the daemon's
  **SIGHUP reload** path: a reload re-runs the two-layer merge, never a
  local-only re-read — re-reading the local layer alone would drop the merged
  central config on a joined host and re-open #111. Boot and reload therefore
  share one resolver (`resolveLayeredConfigFromDisk`) so they can never
  disagree on what "effective" means.
- **Rollback-to-seed improves**: the central layer rolls back to the seed while
  the local layer is untouched, so a rolled-back gateway *keeps recording
  locally* — strictly better than today, where rollback-to-seed left a
  central-only host collecting nothing.
- **No field migration.** Joined-under-the-old-model hosts (where
  `hypaware-config.json` is a symlink to a slot) do not exist in the field; at
  most a trivial defensive boot-time fixup, not a migration path. Non-joined
  hosts need none — their regular file *is* the local layer.

## Local-layer writers

**Invariant: all user/CLI config mutation targets the local layer; the central
layer is written only by `join` (the seed) and the daemon apply engine (server
pulls).** `init`, `attach`, `plugin install`, etc. all write
`hypaware-config.json`.

**Collision with a locked central key → warn-and-write, never refuse.** When a
local-layer write names a key the central layer already locks (e.g. `hyp attach
claude` while the fleet config names `@hypaware/claude`), the CLI writes the local
entry anyway but warns that it will not take effect while the fleet config names
the key, and points at `hyp status` → "local config (not applied)". Refusing is
wrong (the local layer is the user's, and central can release the key later, at
which point the dormant entry activates); silently proceeding is the #111 footgun
in new clothes.

**`init` overwrite safety** (the remaining, non-destructive half of #111 — `init`
still writes the local layer and could clobber it):

- Non-interactive (`--yes` / flags / `--from-file`): refuse if a local config
  exists; require `--force`; on `--force`, write `hypaware-config.json.bak-<ts>`
  first.
- Interactive (TTY): detect the existing local config and prompt to confirm;
  back up on confirm.

## Status provenance

The merge means "what's running" is no longer one grep-able file — restore
inspectability in `hyp status` (and keep each layer file individually plain JSON,
so [LLP 0010 §Explicit plugin set](./0010-config-model.spec.md#explicit-plugin-set)'s
grep-ability rationale survives):

- **Per-entry provenance tags** — every active plugin / source / sink / client
  line is tagged `[central · locked]` or `[local]`.
- **A `local config (not applied):` section** — each local entry dropped at merge
  (collision or merge-invalidity) is listed with its reason; boot emits a
  structured `config.local_entry_dropped` log per drop (`component`, key,
  `reason`).
- **The central-layer convergence block** — joined / converged / seed-only, plus
  the probation / last-rollback / remembered-bad-etag state LLP 0025 §Last-known-good
  rollback already mandates in status.
- A dropped local entry **does not** flip `overall` to `degraded` — the gateway is
  functioning on the central config; a rejected local addition is a user-config
  choice, not a malfunction. It is loud (its own section + a log) but not an
  outage signal.

`config validate` validates the **effective merged** config. A
`hyp config show --effective|--local|--central` surface is a nice-to-have
follow-up, not core.

## What this changes in LLP 0025 and 0010

To be rewritten *with* the implementation (forward-pointers added now):

- **LLP 0025 §Apply semantics: staged restart** — "replaces the operative config
  wholesale — no merging, no client-owned sections" becomes: the apply engine
  replaces the **central layer** wholesale; the local layer is client-owned and
  additive; the effective config is the boot-time merge.
- **LLP 0025 §Seed-config mode** — the seed is the initial **central layer**
  (a dedicated central-seed file, not `hypaware-config.json`); the first
  successful apply retires the **seed file**; the local layer is never touched.
- **LLP 0025 §Server-side guarantees** — the "fleet can't be disconnected"
  guarantee *strengthens* (additive-only ⇒ a user cannot remove the central
  sink); the served document is now "the central layer."
- **LLP 0010** — add that the effective config is `merge(central, local)` with
  per-entry provenance; the explicit-`plugins[]` grep-ability rationale is
  preserved via per-layer files plus `hyp status` provenance.

Heading anchors in LLP 0025 referenced by existing code `@ref`s are **kept
stable**; only prose within those sections changes.

## Server coordination

`hypaware-server` LLP 0009 is the design authority for the feature as a whole.
This decision needs alignment there:

- The served document is reframed as **"the central layer"** — operators author
  the locked authoritative layer knowing the user layer can only **add**. Today
  they may author full configs expecting wholesale replace of the *whole* config.
- The server save pipeline should **forbid / strip a `query` block** in served
  configs (the client ignores it regardless — see [Query is local-only](#query-is-local-only)).

## Annotations to add when code lands

Attached with the implementation, following [CLAUDE.md](../CLAUDE.md)'s "land doc
edits with the code" rule:

- Boot merge (`boot.js`, `merge.js`) → `@ref LLP 0031#two-layers-merged-at-boot`
  / `#merge-model [implements]`.
- Boot-time local-drop validation (`boot.js`) →
  `@ref LLP 0031#central-layer-is-sacrosanct [implements]`.
- `runJoin` central-seed write (`core_commands.js`) →
  `@ref LLP 0031#physical-layout [implements]` (the existing
  `@ref LLP 0025#seed-config-mode` on the function still holds — `join` remains
  a wrapper over write-seed + install).
- Active-slot pointer relocation + seed retirement (`apply.js`) →
  `@ref LLP 0031#physical-layout [constrained-by]` / `[implements]`.
- `init` overwrite guard (`prepareLocalConfigWrite` in `schema.js`; the
  `walkthrough.js` and `core_commands.js` write sites) →
  `@ref LLP 0031#local-layer-writers [implements]`.
- Status provenance (`status.js` collector, `renderStatusText`/`renderStatusJson`) →
  `@ref LLP 0031#status-provenance [implements]`.

Local-writer **collision warning** at `attach` time
([Open questions](#open-questions--deferred)) is not yet wired — the config-layer
half is covered by the boot-merge drop + status surface; the `attach`
side-effect interaction stays a noted follow-up.

## Sequencing

The design was settled before code (this document is the record). Implementation
order, each landing its motivating LLP/code edits together:

1. Boot-time two-layer resolution + merge + drop-on-conflict (the core; makes
   `effective = local` a no-op for non-joined hosts).
2. Relocate the active-slot pointer into `config-control`; `join` writes the
   central seed; apply engine stages/retires the seed in the new location.
3. Status provenance + `local config (not applied)` + drop logs.
4. `init` overwrite guard.
5. Rewrite LLP 0025 / 0010 normative prose; attach `@ref`s; server coordination.

## Open questions / deferred

- **Fleet-enforced retention policy** — central ownership of
  `query.cache.retention` as an explicit sub-key (min/max semantics), deferred
  until there is demand. See [Query is local-only](#query-is-local-only).
- **Central-managed client actions** — `attach` (and, later, backfill) perform
  machine-side effects independent of declarative topology. The *mechanism* for
  these is now owned by
  [LLP 0036 — Central-config-driven client actions](./0036-central-config-driven-client-actions.decision.md):
  a daemon-side reconciler that runs such effects when the central config calls
  for them. Backfill-on-join is its first instance
  ([LLP 0037](./0037-backfill-on-join.decision.md)); the attach side-effect
  interaction (`ANTHROPIC_BASE_URL`, hooks — warn-and-write already covers its
  config layer here) is the next, still-open instance under that seam.
