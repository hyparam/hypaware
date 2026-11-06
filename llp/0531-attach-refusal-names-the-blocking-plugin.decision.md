# LLP 0531: An attach refusal names the one plugin that blocks the adapter

**Type:** Decision
**Status:** Accepted
**Systems:** Config, CLI, Onboarding
**Author:** neutral
**Date:** 2026-10-17
**Extends:** LLP 0174 (#detection), LLP 0178 (T3)
**Related:** LLP 0031 (layered config merge), issue #588

> [LLP 0174](./0174-attach-prompts-to-enable.design.md) is Active, so it is not
> edited. Its #detection state 2, "client known, adapter not enabled", treats
> every unregistered catalog client as an adapter that is missing from the
> config, and its remedy is to add the adapter. That remedy is wrong whenever
> the adapter is already enabled and something it needs is not. This records
> how the refusal finds the real blocker. The three states, the error codes,
> and the prompt in 0174 #prompt are unchanged.

## Context {#context}

Issue #588: with `@hypaware/claude` enabled and `@hypaware/ai-gateway` set
`enabled: false`, `hyp attach claude` said the claude adapter "is not enabled
on this install" and told the user to run `hyp setup` or add the adapter. The
adapter was enabled. Following the advice changed nothing, because the
additive enable write never touches an existing entry (0174
#bootstrap-floor). The same wrong advice appeared when the gateway was
disabled by the central config, when it was missing from the config, and
when every plugin was enabled but one failed to activate this run.

## Decision {#decision}

### The closure {#closure}

The refusal walks the adapter's dependency closure in the static
bundled-and-installed catalog: the adapter's plugin, the plugins its picker
row composes (`requires_gateway` and friends, the same list the prompt uses),
and, transitively, every plugin a closure plugin names in `requires.plugins`
and a provider for each capability it `requires`, the two edges the boot
closure follows. A provider the effective config already enables is
preferred.
The walk visits each name once, so a dependency cycle terminates. A plugin
name the catalog does not know, or a capability no catalog plugin provides,
is recorded as unresolved instead of walked. The closure is computed once per
refusal from the one catalog build and the one layered config read the
refusal already makes.

### Exactly one blocker {#one-blocker}

The refusal names one plugin and the repair for its state. When several
plugins block, the most binding state wins, and within a state the first
plugin in closure order (the adapter leads):

1. **Disabled by the central config**: the refusal says a local config cannot
   override it. Error code `adapter_disabled_central`, as in 0174.
2. **Disabled in the local config**: set `"enabled": true` on that plugin's
   entry and restart the daemon. Adding the entry, which `hyp setup` and the
   prompt do, cannot help here.
3. **Unresolved**: a plugin that is not installed names
   `hyp plugin install <name>`; a capability nothing provides points at
   `hyp plugin list`. The unresolved name is printed, never dropped.
4. **Absent from the config**: the add path from 0174 stands, naming the
   absent plugin, which is the adapter itself in the common case.

States 2 to 4 use `adapter_not_enabled`. The message text is the only thing
that changes, so `--json` consumers keying on `error_kind` see the same
codes. The adapter-absent and adapter-central messages are unchanged.

### Enabled but not live {#not-live}

When every plugin in the closure is configured and enabled, the config is not
the problem. The refusal names the closure plugin that failed to activate this
run, with the loader's safe activation kind (never the thrown message, which
can carry paths), and points at `hyp status`. When no activation outcome is
recorded, it names the first closure plugin that is not live. Code
`adapter_not_enabled`.

### Unreadable config {#unreadable}

When a config layer exists but cannot be read or parsed, the refusal cannot
know what that layer enables or disables. It says so, names the file, and
points at `hyp config validate`. It names no disabled or central owner it
could not see. A missing file is not unreadable: it is the normal state of a
layer that enables nothing.

## Consequences {#consequences}

- The interactive prompt is unchanged. It already skips when an entry the
  write would need is disabled or every entry is present, so it never
  overrides a disabled entry and never offers a no-op write. This decision
  only makes the refusal that follows truthful.
- No new error code, so the server and the CLI reference are unaffected.
- The catalog entry now carries a plugin's `requires.plugins` names, so the
  walk can follow them; the entry is otherwise unchanged.
