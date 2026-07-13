# LLP 0071: the `local-only` list is machine-local, not a dotfile and not central

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Sinks, CLI
**Author:** Phil / Claude
**Date:** 2026-07-06
**Related:** LLP 0049, LLP 0050, LLP 0031, LLP 0069, LLP 0070, LLP 0004, LLP 0037, LLP 0044

> The directories a user marks `local-only` are persisted to a **single
> per-machine file under `HYP_HOME`**, private to this host. Not a committable
> `.hypignore` in each repo, and not layered/central config. This is the honest
> home for "these are *my* directories on *this* box that I don't want
> forwarded."
>
> @ref LLP 0069 [implements] — the persistence half of the login directory picker.
> @ref LLP 0031#query-is-local-only [constrained-by] — a machine-specific carve-out from central authority, by the same precedent.
> @ref LLP 0049#non-goals [constrained-by] — usage policy is honored locally, never merged with central config.
>
> **Extended-by [LLP 0103](./0103-machine-local-policy-classes.decision.md):**
> the file becomes class-per-entry (`ignore` | `local-only` | `full`,
> version 2; version-1 `dirs` read as `local-only`). Every property decided
> here (machine-local home, privacy, never central, `leave` leaves it alone)
> carries over unchanged to the widened format.

## Context

[LLP 0069](./0069-local-only-dir-selection.spec.md) lets a user select captured
working directories to withhold from forwarding. That selection has to live
somewhere. Three homes are plausible, and the existing usage-policy mechanism
([LLP 0049](./0049-hypignore-usage-policy.spec.md)) already picked one of them —
the committable `.hypignore` dotfile — for the `ignore` class. This decision
explains why `local-only`-by-login deliberately picks a *different* home.

## Decision

**Persist the selection as a machine-local list under `HYP_HOME`.** A single
versioned file (proposed: `<stateDir>/usage-policy/local-only.json`, path is a
design detail per [LLP 0004](./0004-activation-and-paths.spec.md)) holds a set of
absolute directory paths:

```json
{ "version": 1, "dirs": ["/Users/phil/side-project", "/Users/phil/clients/acme"] }
```

- **Match semantics** are the ancestor rule [LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope)
  already defines: a `cwd` is `local-only` when it equals, or is a path-segment
  descendant of, any listed directory. This is a second source into the one
  shared resolver ([LLP 0070 §resolver](./0070-local-only-export-seam.decision.md#resolver)),
  not a second matcher.
- The file is **read locally by the export driver and the CLI**, written by the
  login picker and the durable authoring command
  ([LLP 0072 §cli](./0072-enrollment-dir-picker.decision.md#cli)), under the same
  atomic-write discipline other `HYP_HOME` state uses.
- It is **never forwarded, never pushed, never pulled** — it is not a sink, not a
  dataset, and not part of layered config.

## Why not committable `.hypignore` dotfiles {#not-dotfiles}

`.hypignore` ([LLP 0049](./0049-hypignore-usage-policy.spec.md)) is the right home
for `ignore`: a repo-wide "never record this tree" decision the whole team should
see and that belongs in version control. `local-only`-by-login is a different
kind of choice, and three properties of the login picker make the dotfile the
wrong home:

1. **It is private, not shared.** "I don't want my Claude history from this
   directory shipped to my employer's server" is a *personal* stance on a
   BYOD-ish machine ([LLP 0063 BYOD consequence](./0063-login-auto-provision-forward-sink.decision.md)).
   Committing a `.hypignore` announces that stance to every teammate who clones
   the repo and drags it through code review. The list must be invisible to the
   repo.
2. **It must not mutate the user's repos.** The picker offers directories the
   user *already worked in*; writing a dotfile into each selected one modifies —
   and, if the user commits broadly, checks in — files across many repositories
   as a side effect of logging in. A login command silently touching working
   trees is a surprising, unwanted blast radius.
3. **Not every candidate is a repo.** The candidate set is distinct captured
   `cwd`s ([LLP 0069 §enumerate](./0069-local-only-dir-selection.spec.md#enumerate)).
   Some are not git repos, some are scratch dirs, and some **no longer exist** on
   disk. There is nowhere to drop a dotfile for those, but the user can still
   name them — an absolute-path list handles all three; a dotfile scheme cannot.

`.hypignore` is not deprecated or altered: a user who *wants* the committable,
team-visible, repo-scoped form still authors one, and the resolver honors both
sources. The two are complementary homes for two different intents.

## Why not layered / central config {#not-central}

The list could be a key in the config model ([LLP 0010](./0010-config-model.spec.md),
[LLP 0031](./0031-layered-config.decision.md)). It must not be, for two reasons
that point the same way:

- **It is precisely the machine-specific, operator-can't-author kind of state
  that [LLP 0031](./0031-layered-config.decision.md) already carves out as
  local-only.** LLP 0031's §"Query is local-only" establishes the precedent: some
  config is inherently per-machine ("the fleet operator cannot sensibly set it")
  and lives only in the local layer, never central. Which directories *this
  user's laptop* holds that *this user* considers private is the textbook case —
  the org operator has no basis to author it, and it would be meaningless pushed
  to another machine. The `local-only` list takes the same carve-out, by the same
  argument.
- **Putting it in the *central-writable* layer would make it fleet policy**,
  which cuts exactly against the point. [LLP 0037](./0037-backfill-on-join.decision.md)/
  [LLP 0044](./0044-client-attach-on-join.decision.md) hold that central-owned
  policy is locked with no local override. If the exclusion list were central, an
  operator could clear it and force-forward the user's private directories — the
  opposite of a privacy control. Keeping it machine-local is what makes it a
  *user* control at all.

This does not contradict [LLP 0049 non-goal 3](./0049-hypignore-usage-policy.spec.md#non-goals)
("no central/config interaction"); it *extends* the same stance to the new
source. Usage policy — `ignore` or `local-only`, dotfile or list — is honored
locally and is never merged with or pushed by central config.

### The org-forces-forwarding question is deferred, not decided here {#org-policy}

Keeping the list machine-local means an org **cannot** currently forbid a user
from withholding directories. Whether it *should* be able to — a central
`local_only: forbidden` / force-forward policy — is a real tenant-governance
question, but it is a **central-server policy concern**, deliberately out of V1
scope and owned by [LLP 0072 §org-policy](./0072-enrollment-dir-picker.decision.md#org-policy).
It is named, not silently emergent; V1 ships the user control, exactly as
[LLP 0063](./0063-login-auto-provision-forward-sink.decision.md) shipped
login-enrollment and named the server-side opt-out knob as a follow-up.

## Reconciliation with the "no local opt-out" doctrine {#doctrine}

LLP 0037 §"No local opt-out" and [LLP 0044](./0044-client-attach-on-join.decision.md)
§"Opt-out — operator-only" hold that an enrolled machine cannot locally override
locked central policy: it "cannot drop the central sink," and not importing
history "is an operator scoping decision, not a local override." A per-machine
`local-only` list *is* a user withholding slices of what the sink would forward,
so the tension is real and must be met head-on, not waved away.

It is met by a precedent **already in the corpus**: `.hypignore`'s `ignore` class
already lets an enrolled user withhold directories from forwarding, and
[LLP 0049 non-goal 3](./0049-hypignore-usage-policy.spec.md#non-goals) makes it
"honored whenever found" — explicitly *outside* the layered-config/central model
and regardless of enrollment. An `ignore`d tree on an enrolled machine is never
recorded, hence never forwarded — a strictly **stronger** withholding than
`local-only`, which still records locally. If the doctrine forbade a user from
keeping their own directories off the central sink, it would already forbid
`.hypignore` on an enrolled box — which it does not. `local-only` adds a gentler
point on a spectrum the corpus already allows; it opens no new hole.

The reconciliation, precisely: the doctrine governs **fleet topology** — the sink
set, central config entries, whole-machine backfill/attach the operator owns and
locks. Usage policy governs **content privacy** — which of *this user's own*
captured exchanges are their private business — and the corpus has always kept
the two as different systems (LLP 0049 is tagged `Sources, Gateway, CLI`, not
`Config`). The central sink still exists and still forwards everything the user
did not mark private; no fleet machinery is dropped. Whether an org may
nonetheless *forbid* this is the one coherent central angle, and it is deferred to
[§org-policy](#org-policy) — named, not silently emergent.

## Consequences

- Code landing this carries `@ref LLP 0071 [implements]` on the list
  reader/writer and on the resolver source that consumes it.
- The list survives across logins, daemon restarts, and cache rebuilds (it is
  `HYP_HOME` state, not cache data), so a cache rebuild does not silently
  re-expose withheld directories.
- `hyp leave` ([LLP 0063 prerequisites](./0063-login-auto-provision-forward-sink.decision.md#prerequisites))
  does **not** clear the list: it is the user's private data, not fleet state the
  reconciler owns, so severing the fleet connection leaves the user's stated
  preferences intact for the next enrollment. (Stated so a future `leave`
  implementer does not "helpfully" wipe it.)
- Because the list is a plain local file, the durable authoring path
  ([LLP 0072 §cli](./0072-enrollment-dir-picker.decision.md#cli)) is a thin
  read/modify/write over it — no schema migration, no config-layer merge.

## Alternatives considered

- **Committable `.hypignore` with a `local-only` class token.** The file format
  already reserves class tokens ([LLP 0049 §file-format](./0049-hypignore-usage-policy.spec.md#file-format)),
  so this is expressible. Rejected for the login-driven flow ([not-dotfiles](#not-dotfiles)):
  wrong privacy properties, mutates repos, can't name non-repo/vanished paths. It
  remains available for users who deliberately want the shared form.
- **A key in local layered config.** Rejected ([not-central](#not-central)):
  usage policy is deliberately *outside* the config-authority model
  ([LLP 0049 non-goal 3](./0049-hypignore-usage-policy.spec.md#non-goals)); a
  dedicated local file keeps it that way and avoids implying it could ever be
  central-writable.
- **Central/fleet-managed exclusion list.** Rejected for V1: it would make the
  privacy control operator-revocable, defeating its purpose. The *inverse* (org
  forbids exclusions) is the only central angle with a coherent story, and it is
  deferred ([org-policy](#org-policy)).
