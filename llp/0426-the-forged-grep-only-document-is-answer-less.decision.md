# LLP 0426: The forged grep-only document is answer-less

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Onboarding, Plugins
**Author:** Claude
**Date:** 2026-09-20
**Extends:** LLP 0418 (#consequences: the residue item "healing that population needs its own decision" is that decision, here), LLP 0277 (#answer-less: the plugins-array discriminator gains one exact-document carve-out)
**Related:** LLP 0415 (the migration whose central-only lane wrote the document), LLP 0281 (#returning-gate: the status field the carve-out reaches), LLP 0011 (detection seeds a first run), LLP 0183 (the reconfigure seeding this protects)

> LLP 0418 stopped the grep migration's central-only lane from forging a
> pick answer, but a machine that took the pre-fix lane already holds the
> document that lane wrote, records an answer nobody gave, and reports as a
> returning install whose first `hyp init` opens on a grep-only seed
> (issue #1892). This decision heals that population at the readers: the
> exact document the lane wrote is classified answer-less, boot rewrites
> nothing, and the migration is barred from ever minting that document
> again.

## Context {#context}

The migration as v1.36.0 published it
(`git show d6ca7749:src/core/config/grep_migration.js`, the publish commit)
created a missing local config on an enrolled central-only machine by writing
`JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/grep' }] }, null, 2)`
plus a newline, mode `0o600`, via an exclusive `wx` create. That `plugins`
array is what every reader takes for a recorded pick answer (LLP 0277), so
`hyp status` calls the machine a returning install and its first `hyp init`
seeds the picker from the forged config: grep only, every detected client
unchecked, no defaults gate, no express gate. On such a machine `needsGrep`
is false (the grep entry is on disk), so the shipped LLP 0418 guard returns
before it is ever consulted and the symptom persists until an `hyp init`
runs. The population is closed: machines that upgraded to v1.36.0
(published 2026-09-18) while enrolled but never picked, and booted a client
before LLP 0418's fix shipped.

Issue #1892 carries a premise from the PR that filed it: "no signal
distinguishes a forged `plugins:[{grep}]` from a user who genuinely picked
only grep", which would make any heal a gamble with a real user's choice.
That premise was tested before this decision was made, and it is false at
the document level.

## Evidence {#evidence}

A reliable discriminator exists: **no writer in the product's history other
than the pre-fix migration lane can produce the document that lane wrote.**
Each claim below names how it was established.

- **The picker's composer has always written a `query` key.** Verified by
  running `git show` over the composer at its introduction and today:
  `composePickerConfig` (and the pre-picker walkthrough before it, commits
  `e0797f66` and `9fcae872`) writes
  `query: { cache: { retention: { default_days } } }` into every config it
  composes, including a record-nothing pick. The forged document has no
  `query` key. The carry-forward fold (`carryForwardExistingConfig`)
  re-asserts `query.cache.retention.default_days` on every merge, so no
  reconfigure output lacks it either.
- **Grep never enters a composed plugin list alone.** Read from the grep
  manifest and `ridersFor`: `@hypaware/grep` contributes no picker row and
  declares `compose_with: ["@hypaware/ai-gateway"]`, so composition can only
  add it beside the gateway entry.
- **The attach lane cannot produce it.** Read from
  `enableClientAdapter` (`src/core/config/client_enable.js`): it appends
  client-adapter entries, grep is not a client, and its caller contract
  forbids reaching it with no local config (LLP 0174 #bootstrap-floor).
- **The side-channel writers never touch `plugins`** (`hyp remote add` /
  `remove`, LLP 0277 #context; re-read at this head).
- **The current migration appends into existing documents**, so its output
  carries whatever other keys and entries the document had, except for one
  input, `{ version: 2, plugins: [] }`, whose append reproduces the forged
  document exactly. That input is itself composer-impossible (no `query`
  key), so it too is hand-authored where it exists; #no-minting below closes
  the lane anyway. Established by running the regression test against the
  pre-decision head: the migration minted the byte-identical forged document
  from that input.
- **What remains is hand-authoring**: a person editing
  `hypaware-config.json` to exactly `version` plus a one-entry `plugins`
  holding `{ "name": "@hypaware/grep" }` and nothing else, or feeding that
  document to `hyp init --from-file`, which writes a supplied config
  verbatim (read from `src/core/commands/init.js`). No timestamp, mtime,
  enrollment record, or provenance field was needed, and none was found
  that would out-perform the document shape: reasoned from the writers
  above, the config document carries no version or provenance field, and
  file mtime is disturbed by any later write.

Signals considered and rejected: file mtime against the v1.36.0 publish
window (fragile, destroyed by any rewrite, timezone- and clock-dependent)
and conditioning on a present central enrollment seed (the seed can be
removed by `hyp leave` after the forge, and the status reader passes only
the config document to the classification).

## Decision {#decision}

<a id="forged-shape"></a>**A local config that is exactly the document the
pre-fix lane wrote records no pick answer.** The test is shape-level over
the parsed document: top-level keys exactly `version` and `plugins`, a
one-entry `plugins` array, and that entry exactly
`{ name: '@hypaware/grep' }`. `isForgedGrepOnlyConfig`
(`src/core/config/schema.js`) is that test, and
`configRecordsPickAnswer` returns false for a match. Everything else keeps
LLP 0277's rule unchanged: any other `plugins` array, `plugins: []`
included, records an answer.

<a id="readers-classify"></a>**The heal is at the readers; boot rewrites
nothing.** The file stays byte-identical on disk, so a mistaken
classification (a hand-authored twin) costs a re-opened question, never a
destroyed document. Both readers of the discriminator heal through the one
predicate: `hyp status` reports `configRecordsAnswer` false, so the
returning gate (LLP 0281 #returning-gate) takes the first-run path, and the
pick phase seeds from detection (LLP 0011) while the composition fold still
carries the document's keys forward (LLP 0277
#carry-forward-still-applies). The forged document is replaced only by the
user's own confirmed `hyp init`, with the standard backup. Search is
unaffected throughout: the grep entry on disk keeps activating the plugin.

<a id="no-minting"></a>**The migration never writes a document matching the
forged shape.** Appending the compatibility entry to a config that is
exactly `{ version: 2, plugins: [] }` would mint the document #forged-shape
classifies as residue, converting a recorded answer into an answer-less
classification by the product's own hand. That one append stays in memory,
the same fallback LLP 0418 uses for answer-less layers and with the same
cost, two linear list checks re-run on the next boot (LLP 0415
#verification budgets them). Every other persist lane is unchanged, and
with this the forged shape becomes unmintable by any product writer from
this release on.

Rejected alternatives: a boot-time rewrite or delete of the forged file
(irreversible against a hand-authored twin, and a silent write to a
user-owned file that no user action prompted); a `hyp status` notice with
no reclassification (leaves the actual harm, the mis-seeded first picker,
in place); doing nothing (the issue's no-discriminator premise did not
survive scrutiny, so the residue is cheap to close correctly).

## Consequences {#consequences}

- A machine the pre-fix lane forged reports `configRecordsAnswer` false
  from its next `hyp status`, and its first `hyp init` opens on
  detection-seeded checkboxes with the defaults and express gates rendered.
  No daemon restart or file change is needed for the classification to
  apply.
- The population decays to zero through normal use: each affected machine's
  first `hyp init` composes a config with a `query` key, which the carve-out
  can never match again. The predicate then matches nothing the product has
  ever written and stands as a guard against hand-authored twins only.
- **Residual:** a hand-authored config semantically equal to the forged
  document (direct edit, or `hyp init --from-file` with that exact
  document) is classified never-picked: status shows the first-run path and
  the next `hyp init` seeds from detection instead of from the file, though
  every interactive confirm still stands between that seed and any capture.
  The document is behaviorally inert to lose: grep is bundled and applied
  in memory regardless, and the document configures nothing else. The
  classification is shape-level over the parsed document, so unrecognized
  keys inside the plugin entry (which the parser drops) do not defeat it;
  any additional top-level key does.
- **Residual:** a deliberately emptied hand-written config that is exactly
  `{ version: 2, plugins: [] }` no longer gains a persisted grep entry; the
  entry is applied in memory each boot instead. Its recorded answer is
  preserved, which is the point of #no-minting.
- The forged population is exactly the central-only creates. v1.36.0 as
  published already kept the compatibility entry in memory for an *existing*
  answer-less local config (verified by reading the publish commit's
  migration: its pre-lock guard predates LLP 0418, which extended the same
  rule to the missing-file lane), so `hyp remote add` residue gained no
  forged `plugins` array and no other document shape joined the population.
