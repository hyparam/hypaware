# LLP 0006: Dependencies and Capabilities

**Type:** Spec
**Status:** Active
**Systems:** Plugins
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0005, LLP 0016

> How plugins depend on each other. Decomposed from `hypaware-design.md`
> (Dependencies and Capabilities).

## Two kinds of dependency

Most plugins have no dependencies. When a plugin *does* need cross-plugin
behavior it declares one of two kinds:

- **Plugin dependency** — "this named plugin must be installed and activated
  before me." Used when you specifically need that plugin's presence (e.g. an
  adapter that exists *for* it).
- **Capability dependency** — "some plugin must provide this versioned API."
  Used when the implementation is interchangeable.

Capability identifiers are bare names (`hypaware.ai-gateway`); the version
requirement travels alongside as a semver range, **never baked into the
identifier**. Adapters often use both kinds — e.g. `@hypaware/claude` depends on
`@hypaware/ai-gateway` as a plugin (it makes no sense without it) **and**
requires the `hypaware.ai-gateway` capability (so a drop-in replacement could
satisfy the contract):

```json
{
  "name": "@hypaware/claude",
  "requires": {
    "plugins": { "@hypaware/ai-gateway": "^1.0.0" },
    "capabilities": { "hypaware.ai-gateway": "^1.0.0" }
  }
}
```

A provider declares its capability version under `provides`:

```json
{ "name": "@hypaware/ai-gateway",
  "provides": { "capabilities": { "hypaware.ai-gateway": "1.2.0" } } }
```

## Resolution rules

- Core resolves dependencies **before** activation.
- Missing or incompatible capabilities **fail early**, with a clear error.
- Plugin dependencies must be **acyclic**.
- Plugins must not import another plugin's private files.
- Plugins talk to each other **only** through `ctx.requireCapability(name, range)`.

```js
const proxy = ctx.requireCapability('hypaware.ai-gateway', '^1.0.0')
proxy.registerClient({ name: 'claude-code', defaultUpstream: 'anthropic', attach, detach })
```

The capability registry is the single sanctioned cross-plugin channel — it is
what keeps the plugin graph decoupled and replaceable.
