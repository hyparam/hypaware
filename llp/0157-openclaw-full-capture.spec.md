# LLP 0157: OpenClaw full capture

**Type:** Spec
**Status:** Draft
**Systems:** Plugins, Sources, Gateway, Observability
**Author:** Phil / Claude
**Date:** 2026-07-30
**Related:** LLP 0016, LLP 0027, LLP 0037, LLP 0049, LLP 0085, LLP 0103, LLP 0143, LLP 0144, LLP 0145, LLP 0146, LLP 0147, LLP 0148, LLP 0149, LLP 0152, LLP 0158, LLP 0159

> Requirements for implementing the Accepted OpenClaw full-capture decision
> set (LLP 0143 through 0149 and 0152), plus the backfill route those
> decisions anticipated (LLP 0158, 0159). The decisions are settled and are
> cited, not restated: this document says what must be built and how to
> know it is done. Two deliverables: an OpenClaw-side steering plugin (an
> npm package OpenClaw installs) and the reworked `@hypaware/openclaw`
> adapter on the HypAware side, with core losing the now-consumerless
> `json_path` probe format.

## Motivation

LLP 0152 replaced the settings-file attach mechanism with plugin-steered
shadow providers, and its companion decisions settled steering scope,
identity, credentials, wire parity, deferrals, and warnings. None of it is
built. This spec exists so the plan and the implementation have one
document to cite requirement-by-requirement, and so acceptance is defined
before the code exists.

## Deliverables {#deliverables}

Two packages change and one is created:

1. **The OpenClaw steering plugin** (new, npm package installed via
   `openclaw plugins install`): owns the `hypaware-*` shadow providers,
   steering, credential borrowing, wire parity, and pass-through warnings.
2. **The `@hypaware/openclaw` adapter** (rework): loses the settings-file
   attach surface, gains the `openai-completions` projection branch, the
   settlement enricher, and the backfill provider.
3. **Core** (removal only): the `json_path` probe format goes
   (LLP 0143 [constrained-by]).

## The steering plugin {#steering-plugin}

The plugin registers two shadow providers, `hypaware-anthropic`
(`api: "anthropic-messages"`) and `hypaware-openai`
(`api: "openai-completions"`), contributed programmatically via
`api.registerProvider({ catalog: { run } })` with `baseUrl` at the local
AI gateway (LLP 0144 [constrained-by], LLP 0152 [constrained-by]).

Steering is a `before_model_resolve` hook returning `providerOverride`
for every steerable candidate; the hook re-fires per fallback candidate
and per model slot, which is what makes coverage total
(LLP 0152 [constrained-by]).

Credentials are borrowed from the shadowed provider inside
`prepareRuntimeAuth` via the public
`openclaw/plugin-sdk/provider-auth-runtime` `resolveApiKeyForProvider`,
returned per request together with the gateway `baseUrl` (the
belt-and-braces endpoint override LLP 0152 Consequences names) and
`expiresAt` when the credential is OAuth (LLP 0145 [constrained-by]).

Wire parity for `hypaware-anthropic` is mirrored in the plugin's own
`wrapStreamFn` (LLP 0148 [constrained-by]). The concrete mirror at time of
writing, verified against `extensions/anthropic/stream-wrappers.ts`
(openclaw repo, 2026-07-30):

- default betas `fine-grained-tool-streaming-2025-05-14`,
  `interleaved-thinking-2025-05-14`;
- OAuth adds `claude-code-20250219`, `oauth-2025-04-20`;
- `context-1m-2025-08-07` per the user's opt-in, excluded under OAuth;
- `service_tier` from the same config keys OpenClaw's plugin reads.

Unsteerable turns pass through unmodified and warn
(LLP 0149 [constrained-by]); the deferred set is a declared list naming
`amazon-bedrock`, `anthropic-vertex`, the Google providers, and the
per-account-URL gateways (LLP 0146 [constrained-by]).

## The adapter rework {#adapter-rework}

- `src/settings.js` and the undo record it writes are retired; the
  manifest's `contributes.client` drops `attach_probe`; `hyp detach
  --client openclaw` is an honest no-op at the existing no-probe guard;
  attach-on-join stays inert (LLP 0143 [constrained-by]).
- `required_upstreams` grows from `["anthropic"]` to both shape presets;
  presets register iff absent, and the `anthropic` preset keeps its name
  (LLP 0144 [constrained-by], LLP 0016 [constrained-by]).
- Upstream routing is per request, selected by the
  `x-hypaware-upstream` metadata the steering plugin attaches, via the
  gateway's existing header match functions; the gateway itself is
  unchanged at `hypaware.ai-gateway ^2.0.0` (LLP 0148 [constrained-by]).
- The exchange projector stops hardcoding `provider: 'anthropic'` and
  records the true upstream; it gains a shape-aware branch (or a second
  projector behind the same header gate) for `openai-completions`,
  keeping the `priority: 110` ordering (LLP 0144 [constrained-by]).
- The projector stamps a content match key on every row emitted under
  fallback identity, so settlement is a lookup (LLP 0159 [constrained-by],
  following LLP 0027#decision).
- The settlement enricher resolves the session's cwd from the session
  file header and applies the flush-time usage-policy drop when it
  resolves to ignore (LLP 0159 [constrained-by], LLP 0085's seam). Live
  OpenClaw proxy rows carry no cwd, so this seam is what makes
  `.hypignore` govern OpenClaw capture at all.

## Core removals {#core-removals}

The `json_path` branches in `src/core/config/client_detach_disk.js` and
`src/core/daemon/status.js` are deleted; `json` and `toml` remain; the
`MALFORMED_MARKER` guard is untouched (LLP 0143 [constrained-by]). This is
a breaking change with no migration path, accepted in LLP 0143
Consequences; the release notes carry the one-line manual cleanup.

## The warning ledger {#warning-ledger}

Pass-through warnings are structured records, not log prose: provider,
cause (`no_credential` | `no_preset` | `deferred`), session, rate-limited
per provider+cause (LLP 0149 [constrained-by]). They must be queryable on
the machine (the Observability surface), because every coverage statement
in this spec derives from them: LLP 0149 Consequences names the warnings
as the coverage ledger.

## Backfill {#backfill}

Backfill imports pre-existing and missed history from the session JSONL at
`~/.openclaw/agents/<agentId>/sessions/*.jsonl`, complementing live proxy
capture. The session file carries everything a row needs: header with
session id and cwd, per-message native ids and timestamps, and per
assistant message the model, provider, api, stop reason, and usage with
token counts (verified on live files, 2026-07-30).

- The backfill provider and the settlement enricher read the file through
  the one shared reader (LLP 0158 [constrained-by]).
- Route agreement with live capture is by native-identity settlement plus
  the existing `part_id` dedupe layers (LLP 0159 [constrained-by]);
  backfilled rows carry the same `client_name` and `conversation_source`
  as live rows and no route marker, matching the Codex posture.
- Registration follows the house pattern: imperative
  `ctx.backfills.register(...)` at activation, with the plugin-owned
  `backfill` policy (`on_join`, `window_days`) declared and validated in
  the plugin's own config section (LLP 0037 [constrained-by]).
- Usage from the JSONL is stamped on the same logical message the live
  route stamps, so the twin rows dedupe to one row carrying usage.
- Policy gating: rows with a usable cwd are resolved through the shared
  usage-policy resolver before projection, per session, so backfill never
  re-imports what live capture dropped (LLP 0049 R1, LLP 0103
  [constrained-by]). A session without a usable cwd is not gated,
  matching the existing convention; the reader's absolute-path predicate
  defines usable (LLP 0158).
- CLI-backend turns (`claude-cli/*`, codex) are the sibling adapters'
  territory, permanently (LLP 0147 [constrained-by]). Backfill excludes
  them from projection and surfaces the boundary as a structured
  `covered_by` event, following the Codex desktop precedent.

## Coverage statement {#coverage}

The honest statement, which every reporting surface must be able to make:
every bearer-token, in-process provider turn is captured (LLP 0152, 0144,
0145); host-signed and per-account-URL providers are deferred and warned
(LLP 0146); CLI-backend turns belong to the sibling adapters (LLP 0147);
the PDF tool's raw-fetch side call is a known, documented side channel
(LLP 0152 Consequences), and media-understanding entries are audited into
the same list at implementation time. Deferral, sibling territory, and
side channels are distinguished from gaps, and the numbers derive from
the warning ledger.

## Acceptance {#acceptance}

`docs/ACCEPTANCE.md` gains an `openclaw_capture` procedure mirroring the
`codex_desktop_capture` structure (what it proves / does not prove /
requires / steps with pass conditions / if it fails). It proves an
OpenClaw conversation reaches `ai_gateway_messages` by **both** routes:

1. Live: install the steering plugin, run a turn, query for new rows
   attributable via `client_name` / `conversation_source` = `openclaw`.
2. Backfill: `hyp backfill openclaw --since ...` over the same window;
   `rows_written: 0` with `rows_skipped >= 1` is the pass, per
   LLP 0159 Consequences.

The codex step-1 marker check has no analogue (no settings write to
verify, LLP 0143); its replacement asserts the shadow providers are
registered and steering. A step exercises the warning ledger with an
unsteerable provider. The procedure is written with the implementation,
and the release that ships the adapter records a human run of it.

## Implementation-time checks {#impl-checks}

Named by the decisions as verify-before-relying-on:

- Does `pi-ai` add the default betas itself when no wrapper runs
  (LLP 0148 Open questions)? Needs `pnpm install` in the openclaw repo to
  read `@mariozechner/pi-ai`; the mirror's merge must dedupe either way.
- Does OpenClaw append session JSONL lines in real time (LLP 0158 Open
  questions)? Settlement match rate at flush, and therefore LLP 0159's
  residue, depends on it.
- Audit media-understanding entries for direct-fetch paths into the
  LLP 0152 side-channel list.
- Does retargeted signing actually break for the LLP 0146 families? Worth
  knowing before that deferral is ever picked up, not for this work.

## Non-goals {#non-goals}

- Native session identity at capture time: v1 keeps the prompt-head hash
  (LLP 0144); native identity arrives at settlement (LLP 0159).
- Bedrock, Vertex, Google, and per-account-URL gateway support
  (LLP 0146).
- A "required" refuse-instead-of-pass-through mode (LLP 0149).
- A plugin-registry-derived attach signal for `hyp status`
  (LLP 0143 Open questions; its own LLP if wanted).
- Correlating an OpenClaw session with the child CLI session it spawned
  (LLP 0147).

## Requirements {#requirements}

- **R1.** The steering plugin MUST contribute exactly the two shadow
  providers of LLP 0144, programmatically, with `baseUrl` at the local
  gateway, and MUST NOT write to the user's `openclaw.json`.
- **R2.** `before_model_resolve` MUST steer every steerable candidate,
  including fallbacks, per-agent overrides, and the auxiliary model
  slots, to the shadow provider matching the resolved provider's declared
  `api`.
- **R3.** `prepareRuntimeAuth` MUST return the shadowed provider's
  resolved credential and the gateway `baseUrl` per request, MUST NOT
  require any vendor environment variable, and MUST NOT persist a
  borrowed credential anywhere (LLP 0145).
- **R4.** The plugin's `wrapStreamFn` MUST mirror OpenClaw's Anthropic
  request shaping per {#steering-plugin}; the merge MUST be idempotent;
  a parity gap discovered later is a bug, never an accepted loss
  (LLP 0148).
- **R5.** A turn the plugin cannot steer MUST pass through on its
  original provider unmodified, and MUST emit the structured warning of
  {#warning-ledger}; the user's turn MUST NOT fail because of capture
  (LLP 0149).
- **R6.** The real upstream identity MUST travel as request metadata and
  the projection MUST record the true provider, never a `hypaware-*`
  shadow id (LLP 0144).
- **R7.** The adapter MUST register no `attach_probe`, and core MUST
  lose the `json_path` format in the same change (LLP 0143).
- **R8.** The projector MUST handle both API shapes behind the same
  header gate and MUST stamp the LLP 0159 match key on every
  fallback-identity row.
- **R9.** The settlement enricher and the backfill provider MUST consume
  the LLP 0158 shared reader; neither may hold its own parse of the
  session file.
- **R10.** Backfill MUST resolve usage policy per session before
  projecting any row (LLP 0049 R1, LLP 0103), and MUST exclude
  CLI-backend turns from projection (LLP 0147).
- **R11.** Backfilled rows MUST be identity-identical to settled live
  rows (same expansion path, same native ids), so that route overlap
  resolves to zero writes through the existing `part_id` dedupe
  (LLP 0159).
- **R12.** The `openclaw_capture` acceptance procedure of {#acceptance}
  MUST exist and MUST have been run by a human before the adapter ships.
- **R13.** Coverage reporting MUST distinguish deferrals, sibling-adapter
  territory, and documented side channels from gaps, deriving from the
  warning ledger ({#coverage}).
- **R14.** The settlement enricher MUST resolve the session's cwd through
  the LLP 0158 reader, stamp it on settled rows, and drop a row whose
  resolved cwd is policy-ignored before it is committed
  (LLP 0049 R1 as extended by LLP 0085).

## References

- LLP 0143, 0144, 0145, 0146, 0147, 0148, 0149, 0152 (the Accepted set)
- LLP 0158, 0159 (companion backfill decisions)
- LLP 0016, 0027, 0037, 0049, 0103 (house constraints cited above)
- `docs/ACCEPTANCE.md` (`codex_desktop_capture`, the acceptance template)
- PR #475, #486 (the decision set's verified-facts record)
