# LLP 0608: Connect Linear outside onboarding

**Type:** Spec
**Status:** Draft
**Systems:** CLI, Config, Plugins, Sources
**Author:** Phil / Codex
**Date:** 2026-11-17
**Extends:** LLP 0592
**Related:** LLP 0031, LLP 0393, LLP 0411

## Connect {#connect}

`hyp linear connect` is an explicit opt-in available before the collector is
active. It reuses the bundled plugin's read-only OAuth flow and automatic
callback. When an API-key override is present, connect verifies that account
instead. `hyp setup` offers no Linear step. `hyp linear login` continues to
update credentials for an enabled collector.

The command name joins LLP 0393's finite product telemetry vocabulary. Team
names, keys, IDs, credentials, and argument values stay out of telemetry.

Save the consented scope and activate Linear and context graph through the
existing local `plugins[]` entries. Preserve other settings and respect
central ownership of both entries. Make a backup of an existing config before
replacing it atomically. Cancellation and empty selections leave the config
alone. Restart a running managed daemon after changes so it loads the source.
Keep the settings if restart fails and report how to restart manually.

## Team scope {#team-scope}

Explicit `--team` values set the scope. Otherwise preserve any existing teams.
If there is no scope yet, list teams visible to the verified Linear account.
Accept the only team automatically. For several teams, require a selection in
the terminal or explicit flags when unattended. Save selected team IDs in the
existing `teams` config field, show humans the readable names and keys, and keep
the discovery results out of telemetry and datasets. Discovery reads at most
twenty pages of fifty teams and does not collect issue data. Authorization by
itself does not expand the scope to every visible team.
