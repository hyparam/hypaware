# LLP 0251: Attach turns on Claude Code telemetry by writing the settings `env` block

**Type:** Decision
**Status:** Draft
**Systems:** Config, Plugins
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0044, LLP 0045, LLP 0163, LLP 0232, LLP 0237, LLP 0239,
LLP 0245 (the RFC this decision realizes; Draft until 0245 is accepted)

> `hyp attach claude` gains a third mode, `otel`, that merges a fixed set of
> telemetry keys into the `env` block of `~/.claude/settings.json` and writes
> nothing else. No PATH shim, no process wrapper, no keychain, no launchd
> environment. Below the Claude Code version floor attach refuses the switch
> instead of degrading.

## Context

See LLP 0245 for why the `claude` client leaves proxy attach at all. This
decision settles only the injection mechanism: which surface carries the
telemetry configuration, and what attach is allowed to touch to put it there.

## Decision

### The keys, and only these keys {#env-keys}

**Attach merges this key set into `env` and manages exactly it.**

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<listener-port>
OTEL_LOG_USER_PROMPTS=1
OTEL_LOG_ASSISTANT_RESPONSES=1
OTEL_LOG_TOOL_DETAILS=1
OTEL_LOG_RAW_API_BODIES=file:<hyp-home>/spool/claude-bodies
```

The list is the decision, so it is written out here rather than described.
`ANTHROPIC_BASE_URL`, `HTTPS_PROXY`, and `NODE_EXTRA_CA_CERTS` are not written,
which is what keeps the endpoint first-party and Remote Control working without
the override keys LLP 0045 needed and LLP 0232 removed.

### Settings `env` is the injection surface {#settings-env}

**The `env` block of `settings.json` is the only place attach puts these
values.** Claude Code applies it at startup for every launch path (terminal,
desktop-spawned, SDK, background service), so one file write reaches sessions a
shell profile or a PATH shim never sees, and a running terminal app does not
have to be quit and reopened (the LLP 0239 duty this retires for the `claude`
client). Fleets deliver the same block through managed settings.

### Nothing else is touched {#nothing-else}

**Attach writes no keychain trust, no `launchctl setenv`, and no LaunchAgent.**
Those exist to make TLS interception work; with no interception there is
nothing for them to do, and each one is a standing obligation on the user's
machine that this mode declines to create.

### The marker keeps being the whole undo record {#marker-and-spool}

**The `otel` mode reuses the `_hypaware` marker unchanged in shape**: managed
env keys, `prev_env` per-key backup, atomic mtime-gated write, JSONC refusal,
malformed-block backup, and the mode-switch key release of LLP 0232
#mode-migration. The marker additionally records the spool directory, because
detach and `hyp purge` have to sweep a path they did not compute (LLP 0253).
The core disk-driven detach replays the marker without knowing any key by name,
so detach needs no new adapter code.

### Below the version floor attach refuses {#version-floor}

**Claude Code older than 2.1.193 (2.1.214 for `tool_source` detail) makes attach
refuse the mode switch**: any existing attach is left exactly as it is, and the
run prints an upgrade hint (`claude update`). There is no proxy fallback for the
`claude` client. One attach mode per client keeps the test matrix single, and a
silent downgrade to a mode that captures less is the failure this refusal
exists to prevent.

## Consequences

- Attaching Claude Code raises no macOS security dialog and needs no `sudo`.
- A machine migrating from proxy mode still has a trusted CA in its login
  keychain until `detach --purge` runs; migration offers that step (LLP 0245),
  it does not perform it silently.
- `hyp status` reports the third mode, so a machine can be seen to be on
  `otel`, `proxy`, or `base_url` attach.
- Codex is untouched and stays on base-URL attach, so three mechanisms now
  coexist behind one marker format.
