# LLP 0242: Fresh installs still attach Claude by base URL, and old installs have no path to proxy mode

**Type:** Issue
**Status:** Accepted
**Systems:** Config, Plugins, Gateway
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0231, LLP 0232, LLP 0233, LLP 0174

> Proxy-mode capture shipped (LLP 0231-0239) but nothing writes
> `proxy_mode: true`, so every install path still lands on the base-URL
> attach that proxy mode exists to replace.

## Observed

A full local reset followed by the packaged wizard (v1.22.0, 2026-08-17)
produced a config with no `proxy_mode` key, a daemon with no local CA, and a
Claude attach that wrote `env.ANTHROPIC_BASE_URL` plus the two first-party
override keys, exactly the pre-0232 shape.

## Why

The chain is working as designed at every link; no link ever starts it:

1. The gateway boots interception and mints the CA only when its config has
   `proxy_mode: true` (LLP 0233 #proxy-mode-is-explicit).
2. Claude attach picks proxy mode only when that CA exists on disk
   (LLP 0232 #proxy-attach-preflight).
3. Neither the interactive wizard's composer (`composePickerConfig`), the
   express path, nor the `hyp init claude` preset writes the key. No mention
   of proxy exists under `src/core/cli/wizard/`.

So proxy attach is reachable only by hand-editing the config, restarting the
daemon, and re-attaching.

## Impact

- Every fresh install gets the attach mode that breaks Remote Control
  inbound, the defect LLP 0231 set out to fix.
- Every existing install stays on base-URL attach forever; there is no
  command that migrates one.

## Resolution

- LLP 0243: the Claude picker row composes `proxy_mode: true`, so every
  config-writing install path produces a proxy-mode install by default.
- LLP 0244: `hyp attach claude` becomes the migration verb for existing
  installs, behind an explicit consent prompt.
