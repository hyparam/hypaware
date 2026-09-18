# LLP 0418: The grep migration never forges a pick answer

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Onboarding, Plugins
**Author:** Phil / Claude
**Date:** 2026-09-18
**Supersedes:** LLP 0415#migration, in part ("With only a central config, write an additive local config", and with it "exclusively create a missing local file")
**Extends:** LLP 0277#answer-less (a missing local layer is answer-less in the same way an answer-less one is)
**Related:** LLP 0011, LLP 0183, LLP 0281, LLP 0413

> LLP 0415 settled that a central-only install gets a new additive local
> config. The only document such an install has to write is
> `{"version":2,"plugins":[{"name":"@hypaware/grep"}]}`, and a `plugins`
> array is exactly what the rest of the product reads as "somebody
> answered the picker". So the compatibility write left an enrolled
> machine looking like a configured one before anyone had been asked a
> question. This decision keeps the entry in memory on that lane.

## Context {#context}

LLP 0277 made `plugins` the discriminator for whether a config records a
pick answer, because the picker's composer always writes that array and the
side-channel writers never touch it. `configRecordsPickAnswer`
(`src/core/config/schema.js`) is that test, and two lanes read it: the pick
phase decides between seeding from the config and seeding from detection
(LLP 0277 #answer-less), and `collectHypAwareStatus` publishes
`configRecordsAnswer` for the returning gate (LLP 0281 #returning-gate).

The grep migration already honoured that for an *existing* answer-less local
config: it applies the compatibility entry in memory rather than writing a
`plugins` array into a file that had none. The central-only lane did not,
because it had no file to leave alone. It created one, and a created file
whose entire content is `version` plus `plugins` is the strongest possible
"answer recorded" signal the discriminator can see.

The window this matters in is the enrolled-but-never-picked one. The seed
`hyp join` / an enrolling `hyp remote login` writes names only
`@hypaware/central` and the central sink, so `centralAnswersPick`
(`src/core/daemon/status.js`) is false: the fleet has not answered on the
machine's behalf either. Before the migration, such a machine correctly
reported no answer. After its first client boot it reported one, `hyp status`
called it a returning install, and the first `hyp init` seeded its picker
from an empty configured set instead of from detection: every detected client
unchecked, no defaults gate, no express gate. That is the symptom LLP 0277
exists to prevent, arriving by a new route.

## Decision {#decision}

<a id="no-forged-answer"></a>**The grep migration persists nothing when the
write would leave a local layer that records a pick answer the user never
gave.** The test is one predicate over the local layer, applied both before
taking the migration lock and again under it: a layer that is missing, or
present with no `plugins` array, is answer-less, and the compatibility entry
is applied in memory only. Only a local config that already records an
answer is rewritten, by the existing read-modify-atomic-write path.

This makes "no local config" and "a local config with no `plugins` key" the
same case for this migration, which is what LLP 0277 says they are for every
other reader. Search is preserved either way: the in-memory entry is the same
document the persisted one would have produced, so the client, daemon, and
MCP surfaces are identical. The only cost is that the two linear plugin-list
checks run again on the next boot, which LLP 0415 #verification already
budgets for.

Nothing else in LLP 0415 changes except its instruction to exclusively create
a missing local file, which loses the only lane it served. An existing local
config still gains the entry on disk with its backup, lock, permissions, and
concurrent-edit guards intact; central precedence, symlink handling, explicit
`enabled: false`, host profiles, and the read-only fallback are untouched.

## Consequences {#consequences}

- An enrolled machine that has never run `hyp init` keeps
  `configRecordsPickAnswer` false through any number of client boots, so
  `hyp status` does not call it a returning install and the first `hyp init`
  seeds its picker from detection (LLP 0011).
- A central-only install writes no local config at all during boot. The
  first document at that path is the one `hyp init` composes, so the
  overwrite guard has nothing to back up and the picker has nothing to read
  back.
- The `wx` exclusive-create branch is gone, and with it the race it guarded
  against. Under the lock a missing file now means one of two things, and
  both are handled: the layer is absent or answer-less (memory only), or the
  `lstat` found nothing while the re-read that follows it found a config
  recording an answer, which means the file appeared underneath the migration
  (`CONCURRENT_EDIT`, memory only).
- A machine that already took the old lane keeps the config that lane forged.
  The grep entry is on disk, so `needsGrep` is false and the migration never
  looks at it again: `configRecordsPickAnswer` stays true there and the
  LLP 0277 symptom persists until that machine runs `hyp init`. Healing that
  population needs its own decision; this one only stops new machines from
  joining it.
- The central-only lane no longer emits `migration_status: persisted`. It is
  a normal boot with no config write, so it emits nothing; a genuine failure
  on the local-config lane still emits the `memory_only` warning.
