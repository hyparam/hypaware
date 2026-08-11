# LLP 0210: `json_path` detach judges ownership by the signature alone

**Type:** Decision
**Status:** Draft
**Systems:** Config, Plugins, CLI
**Author:** Kenny / Claude
**Date:** 2026-08-11
**Related:** LLP 0169 (#decision: the origin-comparison clause this retires), LLP 0172 (#lane-a-detach: the URL threading this removes), LLP 0167 (the shared-predicate principle this completes), LLP 0206 (the uninstall sweep that surfaced the asymmetry), LLP 0086 (ephemeral-port rebind)

> Extends [LLP 0169 Decision](./0169-openclaw-attach-surface-returns.decision.md#decision)
> and [LLP 0172 §2 Lane A: detach](./0172-openclaw-two-lane-capture.design.md#lane-a-detach).
> One clause changes: detach no longer requires the gateway's live base URL to
> confirm an entry is its own. The entry's signature, which attach has always
> trusted alone, is the whole ownership test on both sides.

## Context {#context}

LLP 0169 made the OpenClaw provider entry self-identifying: the marker header
(`x-hypaware-upstream`) naming the provider key it sits at, a `baseUrl`, and
the empty `models` array OpenClaw's schema requires. "Nothing else writes that
triple - the marker header is HypAware's own name" (the shared predicate's own
words). Attach trusts that signature alone: a drift re-attach after an
ephemeral-port rebind (LLP 0086) overwrites an entry carrying the *old*
origin, so an origin check on the attach side would refuse every re-attach.

Detach, however, additionally required the entry's `baseUrl` to match the
gateway's live origin, and refused with `EXPECTED_BASE_URL_UNKNOWN` when that
origin could not be resolved. That made the `json_path` undo the only one that
needed a fact from a *running* daemon: the `json` marker key and the `toml`
managed block read everything off the settings file.

The cost surfaced when LLP 0206 made `hyp daemon uninstall` sweep every
client. The sweep runs after teardown, exactly when every rung of origin
resolution (bound capability, configured `listen`, live status behind a
living pid) is dead. Working around it meant resolving the origin before
teardown and threading it through three layers, and still left a machine
whose daemon was already stopped unable to detach OpenClaw at all, with
`hyp detach openclaw` failing identically as the printed remedy. One client
undo depending on daemon liveness turned a disk-only sweep into an ordering
problem.

## Decision {#decision}

<a id="d1"></a>**D1: the signature is the whole ownership test, on both
sides.** `isOwnedProviderEntry` keys on the marker header naming its own key
plus the shape attach produces (a `baseUrl` string, an empty `models` array).
Detach deletes on a signature match whatever URL the entry carries, and the
`ours`/`ownedBaseUrls` origin parameter is gone from the predicate. No
`expectedBaseUrl` flows into `detachClientFromDisk`, the reconciler's
`reverse()`, `hyp detach`, or the uninstall sweep, and the
`EXPECTED_BASE_URL_UNKNOWN` refusal no longer exists: with no origin to
resolve, the undo cannot be blocked by a daemon that is stopped, crashed, or
already uninstalled. `json_path` thereby joins the invariant the other
formats always had: the settings file is the complete undo record
(LLP 0045's disk-driven undo, without an exception).

What the origin comparison used to catch, the signature catches better:

- **A stale entry from an old port** (rebind happened, daemon moved on): the
  origin check classified our own entry as not-ours and *backed it up*;
  signature-only deletes it, which is what the user wanted.
- **A forged entry** (a user hand-writing HypAware's marker header, its key
  name, and an empty catalog into their own provider): deleted. This is the
  one behavior change that gives anything up, and it is accepted: the marker
  header exists to be HypAware's name, the entry shape is attach's whole
  output, and a value indistinguishable from ours by construction is one
  attach itself would have overwritten on the next drift pass anyway.

<a id="d2"></a>**D2: a not-ours entry is left in place, and the
`_hypaware_detach_backup` key is retired.** LLP 0169's disposal moved a
present-but-not-ours entry into a backup key inside the container. That
mechanism existed for the class the origin check created: our own entry
carrying a stale origin, which had to come out of the live config without
being discarded. Under D1 that class is ours and is simply deleted, so the
residue of "not ours" is user-authored config, and the right disposal is the
one the `json` undo already makes for an externally overridden value: leave
it where it is, warn by path (never by value, LLP 0163) - and warn only when
the same file also held entries of ours, so a partial undo is named while a
never-attached config passes untouched and unremarked. LLP 0163's "never
discard a user value" is satisfied the strong way: the value is not moved at
all. The cache purge mirrors that disposal: a key the user's settings entry
holds keeps its cache row too, so a never-attached machine's own providers
are never edited in either file. Every other managed key purges whenever the
settings undo deleted an entry or found the managed surface already empty.
The empty case is deliberate, and is what keeps a partially failed purge
retryable: these caches do not self-heal, a detach whose settings half landed
but whose cache half did not must be finishable by rerunning it, and an
orphaned cache row at a managed key with nothing in the settings is
indistinguishable from that residue, which is exactly how the unconditional
purge this refines already treated it. Backup keys written by earlier
versions are left as they are; nothing reads or writes that key anymore.

## Consequences {#consequences}

- The uninstall sweep (LLP 0206) needs no pre-teardown origin capture and no
  ordering guarantees: teardown and detach are independent disk operations
  again, and `hyp detach <client>` is a truthful remedy on a machine in any
  daemon state.
- LLP 0172's "reverse threads the gateway's own base URL into the one core
  undo" and its three-rung `resolveExpectedGatewayBaseUrl` are retired;
  `ctx.endpoint` stays what it always was for `perform()`, and `reverse()`
  passes nothing.
- The shared-predicate module (LLP 0167's one-answer principle) now has one
  signature for all callers instead of a strict side and a relaxed side,
  which removes the exact drift surface its own JSDoc warned about.
