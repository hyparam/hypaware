# LLP 0593: Unattended setup preserves the local configuration

**Type:** Spec
**Status:** Draft
**Systems:** Onboarding, CLI, Config
**Date:** 2026-11-09
**Extends:** LLP 0183#carry-forward, LLP 0183#retention
**Related:** LLP 0462, LLP 0474, LLP 0031

## Request {#request}

Agent-led setup must use normal `hyp setup` for configuration, service
installation, client attachment, skills, and history import. Reconstructing
that finale with separate commands after `--from-file` duplicates the wizard
and fails to preserve the configuration that cloud login can create first.

## Preservation {#preservation}

The flag-driven picker reads the existing local layer and uses the same
carry-forward composition as guided setup. Retained sources keep their custom
settings; unrelated plugins, sinks, query remotes, and enrollment survive.
Omitted retention and export flags preserve recorded choices. A file containing
only remote connections has no export answer and receives the new-install
export default. Explicit retention overrides still apply.

Source flags describe the desired recording selection, so unselected
composer-managed sources are removed. The established Ollama add/repeat
exception in LLP 0474 remains additive. Central sources are resolved and
excluded from local composition just as on the guided path.

`--force` remains required to write over an existing local file and still
backs it up. It authorizes the write, not discarding unrelated settings.
`--dry-run` and refused writes leave configuration and policy unchanged.
Presets and `--from-file` retain their whole-config contracts; `--from-file`
still does not run the finale.

This extends the unattended carve-out in LLP 0183. The shared merge and
existing finale remain the implementation, with no new config fields or
dependencies. Work is bounded by config and catalog size, with no persistent
state or background work added.

## Verification {#verification}

Cover ordinary reconfiguration and a remote-only login config, explicit
retention overrides, selection removal, custom plugin and sink preservation,
the overwrite guard, and the existing Ollama add/repeat contract. Verify the
normal wizard finale still runs after a preserved config is committed.
