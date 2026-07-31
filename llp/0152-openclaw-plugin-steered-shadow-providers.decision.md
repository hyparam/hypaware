# LLP 0152: OpenClaw capture is steered by a plugin, not a settings edit

**Type:** Decision
**Status:** Superseded
**Systems:** Plugins, Gateway, Config
**Author:** Phil / Claude
**Date:** 2026-07-29
**Related:** LLP 0016 (ai-gateway), LLP 0044 (client attach on join), LLP 0045 (client attach design), LLP 0109 (OpenClaw client adapter)

> Reverses the *mechanism* in LLP 0109, not its goal. The AI gateway proxy
> stays the capture path — it is the only seam that yields real request
> bodies, real status codes, stream events, and a record that cannot be
> silently skipped. What changes is how OpenClaw traffic is steered into
> it: an OpenClaw-side plugin instead of an edit to the user's
> `openclaw.json`.

> **Superseded-by [LLP 0168](./0168-config-override-replaces-plugin-steering.decision.md):**
> steering moved to a per-provider `models.providers` baseUrl override
> written by `hyp attach`, an option this decision never considered (its
> rejected settings edit was the per-model-ref rewrite). The goal stands;
> the plugin mechanism and package are retired. See LLP 0167.

## Context

LLP 0109 shipped attach as a write to `~/.openclaw/openclaw.json`: add
`models.providers.hypaware`, repoint `agents.defaults.model.primary` from
`anthropic/<model>` to `hypaware/<model>`, and carry the undo record in the
injected provider's `headers` map. That worked, and its premises were
sound at the time. Two things have since become clear.

**The steering is partial, and fails silently.** `model.primary` is one of
several routes to a model call in OpenClaw. Verified against OpenClaw
source (`openclaw` repo, 2026-07):

- `agents.defaults.model.fallbacks` is a flat list of model refs. A
  fallback fires and the traffic goes direct to the vendor, uncaptured,
  with nothing marking the gap.
- `agents.list[].model` per-agent overrides are untouched, so every
  non-default agent is invisible.
- The `imageModel` / `imageGenerationModel` / `pdfModel` slots and the
  subagent model slot resolve independently.
- A runtime `/model` override leaves the captured provider entirely.

For a product whose claim is "here is the record of what your agents did",
partial capture with no coverage signal is the worst available failure
mode. It is worse than lower-fidelity capture, because it is not
detectable from the data.

**A plugin-side seam exists and reaches all of it.** OpenClaw's
`before_model_resolve` plugin hook returns `{ providerOverride,
modelOverride }` and is awaited before model resolution
(`openclaw` repo, `src/agents/pi-embedded-runner/run/setup.ts`). It
re-fires per fallback candidate: `runWithModelFallback` loops candidates,
each candidate calls `runAgentAttempt`, which calls `runEmbeddedPiAgent`,
which calls `resolveHookModelSelection` — so every candidate gets a fresh
hook invocation, not just the primary. Image-model fallbacks run through
the same candidate collector.

A plugin can also contribute provider catalog entries programmatically —
`api.registerProvider({ catalog: { run } })` returning
`providers: { <id>: { baseUrl, api, apiKey } }` — so the shadow provider
does not have to exist in the user's config file at all.

Two further facts bound the alternatives:

- OpenClaw does not honor `ANTHROPIC_BASE_URL` anywhere (verified: no
  reads in core or the bundled Anthropic plugin), so environment steering
  is not available.
- `wrapStreamFn` and `prepareRuntimeAuth` — the hooks that wrap the actual
  model call — are **owner-scoped**: `resolveProviderRuntimePlugin`
  resolves only the plugin that owns the provider id, then filters by
  `matchesProviderId`. A third-party plugin cannot wrap another vendor's
  provider. This rules out a pure in-process observer, and is also why
  owning the shadow provider ids is worth something (LLP 0144).

## Options considered

1. **Keep the settings-file edit, widen it.** Repoint every model slot and
   every `agents.list[]` entry. Rejected: the write surface grows without
   bound, the undo record has to track all of it, and a runtime `/model`
   override still escapes. Config mutation cannot express "always".
2. **Global `undici` dispatcher interceptor from a plugin service.** Sits
   below provider resolution, so it catches everything in-process with no
   steering at all. Rejected: it is monkeypatching an undocumented
   internal, so an OpenClaw upgrade can break capture *silently* — the
   same class of failure this decision exists to remove. It also misses
   call sites that pass an explicit dispatcher, of which OpenClaw has
   several.
3. **Plugin-owned shadow providers + `before_model_resolve` steering.**
   Uses documented, versioned seams; covers primary, fallbacks, per-agent
   models, and the extra model slots because the hook re-fires per
   candidate; requires no write to the user's config. Chosen.

## Decision

HypAware ships an **OpenClaw plugin** (an npm package OpenClaw installs,
not a HypAware-side file edit). The plugin:

- contributes shadow provider catalog entries programmatically, one per
  API shape (LLP 0144), each with `baseUrl` pointing at the local AI
  gateway;
- registers a `before_model_resolve` hook that rewrites `providerOverride`
  to the matching shadow provider for every run it is asked about;
- borrows the shadowed provider's credential rather than requiring a
  vendor API key in the environment (LLP 0145).

The gateway side is unchanged: same proxy, same upstream presets, same
exchange projectors, same `ai_gateway_messages` rows. This decision is
about steering only.

`hypaware-core/plugins-workspace/openclaw/src/settings.js` and the undo
record it writes are retired. What "attach" means for OpenClaw once
nothing is written to disk is LLP 0143.

## Consequences

- Capture stops depending on which config field the user happens to have
  set, which removes the silent-partial-coverage failure mode.
- The `~/.openclaw/agents/<id>/agent/models.json` hazard named in LLP 0109
  is neutralized, though not by the mechanism first hoped. Verified: the
  cache's baseUrl-preservation rule exempts only providers declared in the
  user's config file (`resolveExplicitBaseUrlProviders` reads
  `cfg.models.providers`), so a catalog-contributed `hypaware-*` entry
  **is** subject to preservation. Two things make that harmless: the
  gateway listens on a fixed default port (LLP 0114), so the preserved
  value equals the fresh one; and `prepareRuntimeAuth` may return a
  `baseUrl` per request, which overrides whatever the cache holds — the
  same mechanism GitHub Copilot uses to swap endpoints at request time.
  The plugin should return the gateway baseUrl there as a belt-and-braces
  measure.
- Delivery changes from "HypAware edits a file" to "OpenClaw installs a
  plugin", which is a different support surface: OpenClaw's plugin install
  runs `npm install --omit=dev` in the plugin directory.
- Fidelity is unchanged, because the proxy is unchanged. This is the
  reason the plugin does not simply consume OpenClaw's `llm_input` /
  `llm_output` hooks instead: those fire once per turn (not per HTTP call),
  carry no response bodies or status codes, and are dispatched
  fire-and-forget with errors swallowed — so mid-turn model inputs are
  invisible and dropped events leave no gap marker.
- LLP 0109 is superseded in its attach mechanism. Its status is its
  author's to change; this document does not flip it.

**Subagents are covered.** Verified: a subagent spawn is a
`callGateway({ method: "agent" })` call (`src/agents/subagent-spawn.ts`),
which re-enters the same agent pipeline — fallback loop, embedded runner,
and the `before_model_resolve` hook with it.

**Direct-fetch tool paths are not covered, and must be named.** OpenClaw's
PDF tool calls Anthropic with a raw `fetch` to
`model.baseUrl ?? "https://api.anthropic.com"`, gated on
`provider === "anthropic"` (`src/agents/tools/pdf-tool.ts`,
`src/agents/tools/pdf-native-providers.ts`). This path goes around both the
steering hook and the provider stream layer, so a PDF-analysis side call is
not steered and not captured. Ironically, LLP 0109's config mutation *did*
catch it, because it retargeted the provider entry the tool reads its
baseUrl from. This is the one known regression versus 0109's mechanism:
a low-volume side channel, accepted and documented in the same honest-
coverage register as LLP 0146 and 0147. Media-understanding entries may
have similar direct paths and should be audited into the same list at
implementation time.

## Open questions

None remaining. Pass-through-vs-refuse for unsteerable providers is
settled by LLP 0149 (pass through and warn); wire parity for steered
requests is settled by LLP 0148 (mirrored in the plugin's own
`wrapStreamFn`, existing gateway unchanged).

## References

- LLP 0016, 0044, 0045, 0109, 0143, 0144, 0145, 0146, 0147
- `openclaw` repo: `src/agents/pi-embedded-runner/run/setup.ts`,
  `src/agents/model-fallback.ts`, `src/agents/agent-command.ts`,
  `src/plugins/provider-runtime.ts`, `src/plugins/types.ts`,
  `extensions/byteplus/index.ts`
- https://docs.openclaw.ai/plugins/sdk-provider-plugins
- https://docs.openclaw.ai/automation/hooks
