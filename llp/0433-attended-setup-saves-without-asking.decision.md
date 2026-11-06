# LLP 0433: Attended setup saves the config without asking

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Config
**Author:** Kenny / Claude
**Date:** 2026-09-24
**Related:** LLP 0031 (#local-layer-writers, extended here), LLP 0183 (#say-so, retired here), LLP 0190 (#commit-point), LLP 0201 (express gate)

> An attended `hyp setup` run no longer asks "Continue?" before it
> replaces an existing config. It backs the old file up and saves.
> Unattended runs are unchanged: they still refuse without `--force`.

<a id="decision"></a>**The overwrite confirm is gone.** By the time the
wizard reaches the save, the user has answered every question, often
with the express gate's one-click "Record and sync everything". A final
"Continue? [Y/n]" asked them to agree to what they had just agreed to.
It defaulted to yes, so it rarely changed an outcome. The one thing it
guarded, the old file, is kept anyway as `hypaware-config.json.bak-<ts>`,
and the backup line names it.

A user who wants out before the save can still cancel at any earlier
question: the save is the last step before the acting phases (LLP 0190
#commit-point), so nothing is written until the questions end.

<a id="scope"></a>**What changes.** `prepareLocalConfigWrite` has one
rule: refuse an existing config unless `force`, and back it up when
forced. Attended runs (the wizard and the legacy walkthrough) pass
`force`. Unattended runs (`--yes`, presets, `--from-file`) pass the
user's `--force` flag, so LLP 0031's non-interactive refusal stands.
This retires LLP 0031's interactive bullet and LLP 0183 #say-so, which
only described the wording of the prompt removed here.
