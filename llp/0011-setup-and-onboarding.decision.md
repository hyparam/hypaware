# LLP 0011: Setup and Onboarding

**Type:** Decision
**Status:** Active
**Systems:** Onboarding
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0002, LLP 0010, LLP 0012

> The first-run experience. Decomposed from `hypaware-design.md`
> (Setup and Onboarding).

## Interactive walkthrough

The primary way to get a HypAware install on the ground is the interactive
setup (`npx hypaware`):

```text
What do you want to collect?   (Claude / Codex / raw Anthropic+OpenAI / OTEL)
Where should HypAware export?   (local cache only / local Parquet / central / later)
Cache retention (days, default 30): 30

✓ Wrote ~/.hyp/hypaware-config.json
✓ Wired Claude Code to use the local proxy
✓ Started the HypAware daemon
```

The walkthrough is the canonical first-run experience. It composes
**plugin-contributed picks** — each source/client plugin registers what it
collects; each sink plugin registers what it exports to — and writes a config
the daemon can load.

## No architectural names

The user describes **what** they want to collect and **where** it should go;
HypAware picks the plugin set. There are no names like "standalone" or
"gateway." The written config enumerates the chosen plugins explicitly
([LLP 0010](./0010-config-model.spec.md#explicit-plugin-set)) — never an implicit
"defaults" mode.

## Autodetect vs default

- **Autodetect** pre-checks a *client source* (`claude`, `codex`) when its tool
  is found on the system. It sets only the initial checkbox state — never forces
  a source on, never hides one. Raw proxy sources and OTEL are never
  autodetected (no installed tool to find). See [LLP 0012](./0012-sources.spec.md#source-kinds).
- **Default** is a fixed starting selection not derived from system state:
  export defaults to local Parquet, retention defaults to 30 days.

(Canonical definitions live in `CONTEXT.md`.)

## Non-interactive entry

For scripted installs (CI, fleet provisioning), `hypaware init <preset>` accepts
named presets contributed by plugins, and `hypaware init --from-file ./team.json`
provisions a fleet of identical installs. Presets are named after what they are
*for*, never after an architectural role.

For centrally-managed gateways, `hypaware join <url> <token>` writes a seed
config (central plugin only) and performs the non-interactive daemon install;
the full config arrives from the server at join. It is sugar over "write the
config file + install the daemon", not a separate path. See
[LLP 0023](./0023-remote-config-join-flow.spec.md#seed-config-mode).
