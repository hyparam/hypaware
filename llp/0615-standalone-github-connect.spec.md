# LLP 0615: Connect GitHub outside onboarding

**Type:** Spec
**Status:** Draft
**Systems:** CLI, Config, Plugins, Sources
**Author:** Phil / Codex
**Date:** 2026-11-17
**Extends:** LLP 0409
**Related:** LLP 0031, LLP 0360, LLP 0393, LLP 0411, LLP 0608

## Connect {#connect}

`hyp github connect [--no-browser]` is an explicit opt-in available before the
collector is active. It enables GitHub and its context graph dependency in
local config, preserves existing configuration, and respects central ownership.
Standalone GitHub and Linear opt-ins share the guarded config write.

After saving, invoke `hyp github login` through the existing in-process command
seam so the newly enabled plugins can activate. The login owns device-code
sign-in, cancellation, scope disclosure, and private credential storage. The
same default repository inventory and withholding rules apply. The command
name joins LLP 0393's finite product telemetry vocabulary.

On successful sign-in, restart a running service daemon to load the settings.
An incomplete sign-in leaves the user's explicit opt-in saved and propagates
the login exit code. On retry, skip an identical config write, run sign-in,
and restart the service after success. If restart fails, report how to load
the saved settings manually.
