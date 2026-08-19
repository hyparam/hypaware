# LLP 0267: An answer-less config does not make a reconfigure

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Config
**Author:** Brendan / Claude
**Date:** 2026-08-18
**Related:** LLP 0183 (the reconfigure-seeding decision this extends), LLP 0011 (detection seeds a first run), LLP 0033 (`remote add` is a local-layer config writer), LLP 0190 (the defaults gate that goes missing), LLP 0201 (the express gate that goes missing)

> The pick phase classifies "reconfigure" by whether a local config file
> exists. `hyp remote add` creates one that holds no pick answer, so a
> first onboarding run after it seeds from an empty answer instead of
> from detection: every box arrives unchecked, no defaults gate renders,
> and the user reads it as broken client detection. This decision keys
> the classification to whether the config *records a pick answer*, not
> to whether the file exists.

## Context {#context}

LLP 0183 made the config on disk the starting state of the pick phase: a
reconfigure seeds the checkboxes from what the machine already collects,
and detection only labels rows `· detected`. Its first-run carve-out is
stated as "where there is no config and nothing else to go on".

"No config" was implemented as "no readable config *file*". But the pick
phase's composer is not the only writer of that file. `hyp remote add`
(and `remote remove`) create-or-augment it to hold `query.remotes`
(LLP 0033), and the documented team onboarding order runs them *before*
`hyp init`. The file they create on a fresh machine is
`{ "version": 2, "query": { "remotes": … } }`: no `plugins`, no sinks,
no record of any capture choice, because no one has ever been asked.

The pick phase then reads that file, classifies the run as a
reconfigure, and `configuredPickerSources` correctly answers "this
config collects nothing" - an **empty set**, which wins over the
detection seed (`configured ?? detectedSeed` only falls through on
`undefined`). Downstream, everything keyed on the same misclassification
degrades together:

- the seed is empty, so no defaults gate renders (LLP 0190) and the
  express gate has no rows (LLP 0201);
- the menu opens with every row unchecked, still labeled `· detected`,
  which reads as detection having failed;
- the export read-back sees no parquet sink and quietly flips the
  first-run `local-parquet` default to `keep-local`
  (LLP 0183 #carry-forward's read-back, applied to a config that never
  answered the export question either).

LLP 0183's own rationale does not support any of this. Its reconfigure
seeding exists so a blind confirm cannot drop what the machine collects
or re-consent to what the user excluded. A config that never held a pick
answer collects nothing and excludes nothing; there is no earlier answer
to protect, only detection to discard.

## Decision {#decision}

<a id="answer-less"></a>**A local config that records no pick answer
seeds like no config at all.** The discriminator is the `plugins` key:
every config the pick phase's composer has ever written carries a
`plugins` array (even a record-nothing pick composes the export pair),
while the side-channel writers (`remote add` / `remove`) never touch it.
So a config without a `plugins` array is classified answer-less, and the
pick phase treats it as a first run for every question it would
otherwise read back: detection seeds the checkboxes (LLP 0011), the
defaults and express gates render from that seed, and export takes the
first-run `local-parquet` default.

<a id="carry-forward-still-applies"></a>**Answer-less is a seeding
classification, not a license to discard the file.** The composition
fold of LLP 0183 #carry-forward still runs over the existing config, so
the `query.remotes` (and any other key a pre-init command wrote) passes
through to the written config, and the overwrite guard still backs the
file up. Only the *questions* re-open; the *data* is carried.

A config with a `plugins` array - even an empty one - keeps the full
LLP 0183 reconfigure behavior. `plugins: []` cannot be distinguished
from a deliberately emptied install, and re-seeding it from detection
would re-consent on the user's behalf, which is exactly what LLP 0183
forbids.

## Consequences {#consequences}

- `hyp remote add` → `hyp remote login` → `hyp init` behaves like the
  first run it is: detected clients arrive pre-checked and gated.
- A genuine reconfigure is unchanged: any composer-written config has
  `plugins` and takes the LLP 0183 path.
- A hand-written config without `plugins` re-opens onboarding's
  questions on the next `hyp init`, but its own keys survive the fold.
  Such a config could not have activated capture anyway.
- The `reconfigure` telemetry attribute on `wizard.pick.start` now
  reports the answer-keyed classification, so a run that seeds from
  detection never reports itself as a reconfigure.
- **Residual, out of scope here:** the returning gate (LLP 0129 /
  LLP 0182) still keys on `configExists && configValid`, and the
  answer-less config validates, so `hyp init` after `hyp remote add`
  still fronts onboarding with the "already set up" summary
  (quit-by-default). Choosing Reconfigure now lands on correct
  detection-seeded checkboxes, so the misleading part is the gate
  screen itself. Applying this decision's classification to the gate
  would touch the status report's config summary and is left to a
  follow-up under the same principle.
