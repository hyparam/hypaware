# LLP 0010: Config Model v2

**Type:** Spec
**Status:** Active
**Systems:** Config
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0011, LLP 0013, LLP 0014

> The v2 config shape. Decomposed from `hypaware-design.md` (Config Model).

> **Extended by [LLP 0031](./0031-layered-config.decision.md).** On a
> centrally-managed host the effective config is the **merge of two layers** — a
> server-owned central layer (authoritative, locked) and a user-owned local
> layer (`hypaware-config.json`, additive-only) — computed at boot, with
> per-entry provenance (`[central · locked]` / `[local]`) and a dropped-local
> section surfaced in `hyp status`. The explicit-`plugins[]` grep-ability
> rationale below is preserved: each layer file is still plain JSON. Non-joined
> hosts are a single local layer, exactly as described here.

## No mode field

Use a breaking **v2** config shape. There is **no `mode` field** and no
architectural role label. A host is described entirely by the plugins it loads,
the sinks (if any) it exports to, and its cache retention settings. A host
becomes "the gateway" purely by configuring an `@hypaware/central` sink — there
is no mode flag to keep in sync.

```json
{
  "version": 2,
  "plugins": [
    { "name": "@hypaware/ai-gateway", "config": { "listen": "127.0.0.1:8787", "upstreams": [ /* … */ ] } },
    { "name": "@hypaware/claude", "config": { "proxy": "@hypaware/ai-gateway" } },
    { "name": "@hypaware/gascity" }
  ],
  "query": { "cache": { "dir": "~/.hyp/hypaware", "retention": { "default_days": 30 } } }
}
```

## Explicit plugin set

The written config enumerates chosen plugins explicitly in `plugins[]` — there
is **no implicit "use defaults" mode**. This keeps `hypaware status` and any
config diff trivially grep-able and avoids the failure mode where a default set
drifts between releases and silently changes a running install. **Query is
intrinsic and never appears in `plugins[]`** ([LLP 0003](./0003-core-vs-plugin-surface.spec.md)).

## Sinks block

Adding a `sinks` block turns the host into one that exports. Each entry is a
user-chosen instance name; `plugin` (or `writer`+`destination`) says which
package implements it; `config` carries settings, schedule, and format. See
[LLP 0014](./0014-sinks.spec.md) for the two sink shapes.

## Validation

Each plugin validates its own `config` section through core's validation
framework — which is why a plugin declares `config_sections` in its manifest
([LLP 0005](./0005-plugin-manifest.spec.md)). Core validates cross-plugin
references after all manifests are loaded.

## Deliberate V1 gap: per-source routing

Config does not yet expose per-source export routing ("send
`ai_gateway_messages` to S3 but `logs` to a webhook"). The sinks block applies
to all datasets at V1, by design. The shape leaves room for a future
`sinks.<name>.datasets` key or a top-level `exports` block without a breaking
change. (Open question in [LLP 0000](./0000-hypaware.explainer.md): decide the
shape before a second sink ships.)
