# LLP 0137: Onboarding never asks for retention; the pathway sets the default

**Type:** Decision
**Status:** Active
**Systems:** Onboarding, CLI, Config
**Author:** Phil / Claude
**Date:** 2026-07-24
**Related:** LLP 0011, LLP 0013, LLP 0129, LLP 0135
**Extended-by:** [LLP 0183](./0183-reconfigure-starts-from-the-config-on-disk.decision.md#retention) - the pathway default applies to a machine with no stated window; a reconfigure keeps the window the config already carries.

> Amends [LLP 0011](./0011-setup-and-onboarding.decision.md): the
> "Cache retention (days)" question is removed from the interactive
> walkthrough, and the flat default becomes pathway-scoped.

> **Revised 2026-07-27:** the team-side default moved from 30 days to
> 90. The pathway-scoped structure below is unchanged; only the number
> widened. A 30-day window turned out to be narrower than the questions
> people actually ask of the cache (quarter-over-quarter comparisons,
> "when did this regress", month-boundary rollups), and it forced a
> round trip to the org server for work the local cache should answer
> on its own. The base rate of cache growth per day is what bounds this;
> 90 days stays inside the disk envelope the cache was sized for.

## Decision

<a id="pathway-defaults"></a>**Onboarding never asks for a cache
retention window. The pathway chosen at the fork
([LLP 0129](./0129-init-wizard-fork.decision.md#fork)) decides the
default instead:**

- **Join a team: 90 days.** The org server holds the durable copy of
  forwarded history, so the local cache is a working window, not the
  record; 90 days makes that window wide enough to answer quarter-scale
  questions locally.
- **Local install: 120 days.** Nothing leaves the machine; the local
  cache is the only copy of history, so it keeps the longest window.
- A managed machine's **scoped re-entry** counts as the team side
  (90 days), same rationale.

The wizard orchestrator passes the local default into the pick phase as
`retentionDefault`; team and scoped runs fall through to the pick
phase's `DEFAULT_RETENTION_DAYS`. The superseded programmatic
walkthrough (`runPickerWalkthrough`), which has no fork, keeps the flat
`DEFAULT_RETENTION_DAYS` value.

## Why not ask

Retention was the last free-text question in onboarding, and it asked
for a judgment the user has no basis to make on first run (how many
days of an as-yet-empty cache to keep). Every other pick already
defaults (export defaults to local Parquet,
[LLP 0011](./0011-setup-and-onboarding.decision.md#autodetect-vs-default));
the window is a config value (`query.cache.retention.default_days`,
[LLP 0013](./0013-local-query-cache.decision.md#retention-is-the-central-tradeoff))
that remains freely editable after the fact, so asking up front bought
nothing but friction.

## Overrides unchanged

`hyp init --retention-days <n>` still sets the window explicitly on the
non-interactive path (its flag default tracks the team default, now
90), and editing
`query.cache.retention` in the written config remains the post-install
knob. Fleet-enforced retention stays deliberately deferred
([LLP 0031](./0031-layered-config.decision.md#open-questions--deferred)).
