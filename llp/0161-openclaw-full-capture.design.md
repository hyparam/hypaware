# LLP 0161: OpenClaw full capture, technical design

**Type:** design
**Status:** Active
**Systems:** Plugins, Sources, Gateway, Observability
**Generated-by:** neutral
**Author:** neutral (Designer)
**Date:** 2026-07-30
**Related:** LLP 0016, LLP 0027, LLP 0037, LLP 0044, LLP 0045, LLP 0049, LLP 0085,
LLP 0103, LLP 0109, LLP 0143, LLP 0144, LLP 0145, LLP 0146, LLP 0147, LLP 0148,
LLP 0149, LLP 0150, LLP 0152, LLP 0157, LLP 0158, LLP 0159

> Technical design for the two deliverables and one removal LLP 0157 specifies:
> the OpenClaw-side steering plugin, the `@hypaware/openclaw` adapter rework,
> and the `json_path` core removal. This document names the real files, the
> exact call shapes, and resolves the forks LLP 0157 leaves open (steering
> precedence, client registration, projector shape, and cross-shape match-key
> normalization) so a plan can split this into independently mergeable tasks.

## 1. Package layout {#package-layout}

Two packages change (`@hypaware/openclaw` under
`hypaware-core/plugins-workspace/openclaw/`) and one is created.

**Fork: where does the steering plugin live?** The repo's root
`package.json` has no `"workspaces"` field, and every directory under
`hypaware-core/plugins-workspace/` is a HypAware kernel plugin, loaded by
relative import against a `hypaware.plugin.json` manifest, not an installable
npm package. The steering plugin is neither: it is an npm package OpenClaw
installs (R1, `openclaw plugins install`), so it needs its own
`package.json`, its own publish lifecycle, and an OpenClaw-native plugin
manifest whose shape belongs to the OpenClaw repo's own plugin API, not this
one. It cannot be dropped into `plugins-workspace/` without lying about what
it is.

**Decision:** a new top-level directory, `openclaw-steering-plugin/`, sibling
to `hypaware-core/` and `src/`, with its own `package.json` (name
`@hypaware/openclaw-steering-plugin`) and its own `src/index.js` entrypoint.
It stays in this repo rather than a separate one because the
`x-hypaware-upstream` header contract (Section 4) is a two-sided agreement
between this package and the `@hypaware/openclaw` projector: the plugin
writes the header, the projector reads it to recover true provider identity
(R6). Landing both sides in one PR against one commit history is what keeps
that contract from drifting the way two independent copies of a parse rule
already did once in this codebase (LLP 0150's #453/#459). A separate repo
would need a version-pin dance across two release cadences to keep the
header's meaning agreed; co-location makes "agreed" the default. The exact
OpenClaw plugin-manifest fields (whatever OpenClaw's own `plugin.json`
equivalent requires: id, entry, permission declarations) are OpenClaw API
surface, not HypAware's, and are verified against the openclaw repo at
implementation time (Section 10), mirroring how LLP 0157 itself verified
`extensions/anthropic/stream-wrappers.ts` and
`openclaw/plugin-sdk/provider-auth-runtime` against that repo rather than
guessing their shape.

`openclaw-steering-plugin/` has no `hypaware.plugin.json` and is not loaded
by the HypAware kernel; it never calls `ctx.requireCapability` or any
`PluginActivationContext` method. Its only coupling to this codebase is the
header name and value contract in Section 4, which is documentation, not a
code dependency, at build time.

## 2. The steering plugin {#steering-plugin}

`openclaw-steering-plugin/src/index.js` registers two shadow providers via
OpenClaw's own `api.registerProvider({ catalog: { run } })` (LLP 0144
[constrained-by]):

- `hypaware-anthropic`, `api: "anthropic-messages"`
- `hypaware-openai`, `api: "openai-completions"`

Both `run` catalog entries point `baseUrl` at the local AI gateway
(`gateway.localEndpoint()`'s value, resolved once at plugin load from an
environment variable the HypAware install sets when it configures OpenClaw,
since the steering plugin cannot call into the HypAware kernel directly, only
ever talking to the gateway over HTTP the same way any other client of
`localEndpoint()` does).

@ref LLP 0157#steering-plugin [implements]: the two shadow providers are
registered programmatically with `baseUrl` at the local gateway, satisfying
R1's requirement to contribute exactly the two shadow providers and never
write to the user's `openclaw.json`, since `api.registerProvider` is an
in-process catalog contribution, not a settings-file write.

### 2.1 Steering precedence {#steering-precedence}

**Fork:** LLP 0157 states that `before_model_resolve` must steer every
steerable candidate (R2) and that an unsteerable one must pass through and
warn with one of exactly three named causes, `no_credential`, `no_preset`,
`deferred` (R5, Warning ledger), but does not state the decision order that
produces exactly those three outcomes without inventing a fourth or
double-counting. The `AiGatewayUpstreamPreset` the gateway exposes
(`hypaware-plugin-kernel-types.d.ts`) has a static per-preset `base_url`:
there is no per-request dynamic forward target. That single fact is what
makes the precedence order load-bearing, not cosmetic: steering a candidate
whose real target is not the literal `api.anthropic.com` or
`api.openai.com` would silently redirect that traffic to the wrong vendor,
because the gateway's `anthropic`/`openai` presets always forward to their
one hardcoded `base_url` regardless of what the original request wanted.

**Decision:** four ordered checks, each terminal:

```
resolveSteering(candidate, ctx):
  shape = candidate.api                      // e.g. 'anthropic-messages'
  shadow = SHADOW_FOR_SHAPE[shape]            // hypaware-anthropic | hypaware-openai | undefined

  if shadow is undefined:
    return warn(candidate, cause: 'no_preset')   // no shadow covers this api shape at all

  if candidate.provider != CANONICAL_PROVIDER[shape]:   // e.g. shape's real 'anthropic' | 'openai'
    if candidate.provider in DEFERRED_SET:               // LLP 0146's named families
      return warn(candidate, cause: 'deferred')
    return warn(candidate, cause: 'no_preset')            // shape matches, vendor does not; unrecognized non-canonical target

  credential = tryResolveApiKeyForProvider(candidate.provider, ctx)
  if credential is undefined:
    return warn(candidate, cause: 'no_credential')

  return { providerOverride: shadow, requestMeta: { 'x-hypaware-upstream': candidate.provider } }
```

`DEFERRED_SET` is exactly LLP 0146's named list: `amazon-bedrock`,
`anthropic-vertex`, the Google providers, `cloudflare-ai-gateway`,
`vercel-ai-gateway`. Every member of that set already fails the
canonical-provider check (none of them are literally `anthropic` or
`openai`), so `deferred` is not a parallel branch racing `no_preset`, it is
the named subset of "wrong vendor for this shape" that LLP 0146 already
triaged, checked first so a known family gets its documented cause instead
of falling into the catch-all. An unrecognized future provider sharing an
`api` shape (a new Anthropic-compatible vendor OpenClaw might add before
this repo triages it) lands on `no_preset`, which is the honest answer:
nothing here has decided it is out of scope on purpose, unlike the named
`deferred` set. This is the one place the design commits to a stance LLP 0157
left implicit, and it is worth a `deferred`-set-membership test at
implementation time, because a new OpenClaw release adding a provider to a
deferred family (e.g. a new Google variant) must land in `DEFERRED_SET`
deliberately, not be discovered by a `no_preset` warning going unexpectedly
noisy.

@ref LLP 0157#requirements [implements]: R2 (steer every steerable
candidate), R3 (credential-only failure is `no_credential`), R5 (every
unsteerable turn passes through and warns with a named cause), and R6 (the
static-`base_url` constraint is why only the two canonical vendors are ever
steered) collapse into one algorithm, not four independent checks.

### 2.2 Credential borrowing and wire parity {#credentials-and-wire}

`prepareRuntimeAuth` calls the shadowed provider's
`resolveApiKeyForProvider` (from `openclaw/plugin-sdk/provider-auth-runtime`,
verified against the openclaw repo per LLP 0157's own citation) and returns
`{ apiKey, baseUrl: gatewayBaseUrl, expiresAt? }` per request; it never
writes the resolved credential to disk or to OpenClaw's own credential
store, and it re-resolves on every call rather than caching past `expiresAt`
(LLP 0145 [constrained-by], R3).

`wrapStreamFn` on `hypaware-anthropic` mirrors the concrete header set LLP 0157
verified against `extensions/anthropic/stream-wrappers.ts`: default betas
`fine-grained-tool-streaming-2025-05-14` and `interleaved-thinking-2025-05-14`,
OAuth-only additions `claude-code-20250219` and `oauth-2025-04-20`,
`context-1m-2025-08-07` on opt-in and excluded under OAuth, `service_tier`
read from the same config key OpenClaw's own plugin reads. The merge is a
`Set`-based header union keyed by header name (idempotent by construction: a
second merge of the same inputs is a no-op), rather than an append, so a
future OpenClaw release that starts adding one of these headers itself does
not duplicate it (R4). `hypaware-openai` needs no such wrapper in v1: nothing
in LLP 0157's steering-plugin section names an OpenAI-side wire quirk to
mirror, and none surfaced in the `extensions/anthropic/` audit because that
audit only covers the Anthropic wrapper; Section 10 names auditing the
OpenAI side as an implementation-time check if OpenClaw's own OpenAI request
path turns out to add headers this repo has not seen yet.

## 3. The `@hypaware/openclaw` adapter rework {#adapter-rework}

### 3.1 Manifest {#manifest}

`hypaware-core/plugins-workspace/openclaw/hypaware.plugin.json` changes:

- `contributes.client.attach_probe` is deleted entirely (R7).
- `contributes.client.required_upstreams` grows from `["anthropic"]` to
  `["anthropic", "openai"]` (LLP 0157 adapter-rework, LLP 0016
  [constrained-by]: both upstream shapes get their own preset, mirroring how
  `@hypaware/codex` already declares `openai` and `chatgpt`).
- `permissions` drops `write_openclaw_settings`: the settings-file write
  (`src/settings.js`'s `attach()`) is retired in full (Section 3.3).
  `write_home` is kept: the LLP 0158 session reader still reads
  `~/.openclaw/agents/<agentId>/sessions/*.jsonl` under `read_home`, and
  nothing in this rework needs a home-directory write any more, so
  `write_home` should be re-audited down to `read_home` at implementation
  time; it is flagged here rather than resolved, because dropping a
  permission the manifest currently declares is the kind of surface change
  that deserves its own line in the PR description, not a silent diff.
- `picker[0].compose.gateway_upstream` stays pointed at the `anthropic`
  preset (unchanged: it is documentation for the picker's default
  composition, not itself a routing decision).
- `config_sections[0].summary` gains the `backfill` block (Section 3.2).

### 3.2 Config validator {#config-validator}

`hypaware-core/plugins-workspace/openclaw/src/config.js` gains
`validateBackfillSection(value, pointer)`, a same-shape copy of
`@hypaware/codex`'s validator (`on_join: boolean`, `window_days: positive
integer`, unknown keys rejected). This is deliberately a duplicate, not a
cross-plugin import: no plugin in this codebase imports another plugin's
`src/` at runtime (`claude-desktop` imports `claude-account`'s types only,
via `@import`, never its code), and each backfill-capable plugin owning a
byte-identical but independently-editable copy of this roughly 15-line
validator is the established shape (Claude and Codex each hold their own).
The stale "no backfill block" comment explaining why the plugin registered
no backfill provider in v1 is deleted along with the code it described.

@ref LLP 0157#backfill [implements]: the plugin-owned `backfill` policy
(`on_join`, `window_days`) declared and validated in the plugin's own config
section (LLP 0037 [constrained-by]).

### 3.3 activate(), client registration, and the attach fork {#activate-and-client-registration}

`hypaware-core/plugins-workspace/openclaw/src/index.js` currently imports
`attach`/`defaultSettingsPath` from `./settings.js` and calls
`gateway.registerClient({ name, defaultUpstream, attach(attachCtx) {...} })`
with an `attach()` that writes `~/.openclaw/openclaw.json`. `src/settings.js`
and this write are retired in full (R7, LLP 0143 [constrained-by]).

**Fork: does the reworked adapter call `gateway.registerClient` at all?**
`@hypaware/claude-desktop` is the existing "attach is inert" precedent, and
it calls `registerClient` zero times, but Desktop's captured rows carry
`client_name: 'claude'` (the already-registered Claude client; Desktop is an
entrypoint distinction, per its manifest description), so `hyp clients
claude` already covers it. OpenClaw's rows carry `client_name: 'openclaw'`,
an identity no other registered client folds into. `src/core/commands/clients.js`
resolves `gateway.getClient(name)` and errors `unknown client '<name>'` when
it is absent; `src/core/cli/walkthrough.js` and `hyp status`
(`src/core/commands/status.js:524`, `gateway.listClients()`) have the same
dependency. Dropping registration the way Desktop does would make `hyp
attach openclaw`, `hyp clients openclaw`, and `hyp clients --help`'s listing
report "unknown client" even while `ai_gateway_messages` rows keep landing
under `client_name = 'openclaw'`, a real discoverability regression LLP 0157
does not ask for; its `attach_probe` removal is about the settings-file
mechanism, not about client identity.

**Decision:** keep `gateway.registerClient({ name: 'openclaw', defaultUpstream:
'anthropic', attach })`, but make `attach()` an honest no-op: it writes
nothing, and returns/logs a message that OpenClaw routing is owned by the
`@hypaware/openclaw-steering-plugin` npm package the user installs on the
OpenClaw side, not by a HypAware-side settings write, pointing at that
package's install instructions. This costs nothing on the on-join
reconciliation path: `action_attach.js`'s `desired()` already requires
`descriptor.attachProbe` to be present before it ever names a client
(`if (!descriptor.attachProbe) continue`, with the comment that a probe-less
client could attach but never be undone, orphaning its settings on a
config-drop, exactly the failure mode a real write would risk and a no-op
cannot), so dropping `attach_probe` from the manifest (Section 3.1) already
makes attach-on-join inert through the existing generic guard, with no new
code needed there. It is only the manual `hyp attach openclaw` /
`hyp clients openclaw` commands, which resolve `getClient()` directly and do
not gate on `attachProbe`, that need the client to stay registered so they
resolve at all instead of erroring. `defaultUpstream` stays `'anthropic'`:
it is a display/status default (which upstream preset's endpoint `hyp
status` shows for this client when no per-request header is present), not a
routing decision; routing is per-request per Section 4.

@ref LLP 0157#adapter-rework [implements]: "`hyp detach --client openclaw`
is an honest no-op at the existing no-probe guard; attach-on-join stays
inert", extended here to the attach direction and to the manual-command
path, which the existing guard does not reach and which this design covers
with an honest no-op `attach()` instead.

### 3.4 Upstream presets {#upstream-presets}

`hypaware-core/plugins-workspace/openclaw/src/projector.js` keeps
`anthropicUpstreamPreset()` (`name: 'anthropic'`, unchanged, registered iff
absent, mirroring Codex/Claude's shared-preset convention) and gains
`openaiUpstreamPreset()`: `name: 'openai'`, `base_url: 'https://api.openai.com'`,
`path_prefix: '/v1'`, `priority: 100`, byte-identical in shape to
`@hypaware/codex`'s existing `openai` preset registration (same preset name
means whichever plugin activates first wins the `Map.set`, which is correct:
both plugins agree on the same real endpoint for the same shape).

Both presets' `match(input)` gain one precedence rung above their existing
path/header checks: if `input.headers['x-hypaware-upstream']` is present and
names this preset's provider (`'anthropic'` or `'openai'`), match
unconditionally. This lets the steering plugin's header (Section 4) win
routing outright for OpenClaw-originated traffic even on a path or header
signature shared with another adapter, without changing how Claude/Codex
traffic (which never sends this header) gets routed today.

### 3.5 The projector's shape-aware branch {#projector-shape}

**Fork: one projector with a shape branch, or two projectors behind the
same header gate?** LLP 0157 offers both as options. Session identity
(`openclawSessionId`), the fallback-id/`previous_message_id` chain (owned by
the shared `aiGatewayRowsFromProjectedExchange`, not the projector), and the
`x-hypaware-client: openclaw` match gate are identical regardless of which
API shape the traffic is. Two projectors would duplicate all three, and
`dispatchProjector`'s priority walk would need a second `priority: 110`
registration whose relative order against the first is untested and
irrelevant, since both would match the same traffic and only one variable
(the api shape) actually differs.

**Decision:** extend the existing `createOpenclawExchangeProjector()` (stays
at `priority: 110`) with an internal shape dispatch. `match()` is unchanged
(`x-hypaware-client: openclaw` header). `project()` reads the new
`x-hypaware-upstream` header (Section 4) to pick `anthropicMessages()`
(existing, unchanged parsing) or a new sibling `openaiMessages()` that
builds the same message list shape from an OpenAI Chat Completions-shaped
request/response pair, and no longer hardcodes `provider: 'anthropic'`:
`provider` is read from `x-hypaware-upstream` directly, falling back to
`'anthropic'` only if the header is absent (a defensive default for traffic
that reached this projector without having gone through the steering plugin
at all, which should not happen once the steering plugin is installed, but a
projector must not throw on traffic it can still parse).

@ref LLP 0157#adapter-rework [implements]: the projector "records the true
upstream; it gains a shape-aware branch... for `openai-completions`, keeping
the `priority: 110` ordering" and R6, the projection must record the true
provider, never a `hypaware-*` shadow id.

## 4. The `x-hypaware-upstream` header contract {#upstream-header}

This is the one piece of wire protocol the steering plugin and the adapter
must agree on byte-for-byte, so it is specified once, here, rather than
folded into either side's section.

- **Writer:** `openclaw-steering-plugin`, only on a request it has decided
  to steer (Section 2.1's terminal `steer` branch). Value is the real
  upstream provider name exactly as OpenClaw's own resolver names it before
  steering substitutes the shadow (`'anthropic'` or `'openai'`), never a
  `hypaware-*` name.
- **Readers, two, independent:** (a) the gateway's upstream-preset `match()`
  functions (Section 3.4), which use it to pick the correct static
  `base_url` regardless of which path the shadow provider's own client
  happened to hit; (b) the OpenClaw exchange projector (Section 3.5), which
  uses it to pick the parse branch and to stamp `provider` on the row. Both
  readers are tolerant of the header's absence (fall back to existing
  path/header-signature matching for (a), to `'anthropic'` for (b)): the
  header is an enhancement a steered request always carries, not a new
  required field that would make un-steered or manually-curled traffic
  unparseable.
- **Never a routing target itself.** It carries a provider name, not a URL:
  the gateway's static-`base_url` preset model (Section 2.1) is exactly what
  rules out letting a header carry an arbitrary forward target, which would
  turn the gateway into an open relay for whatever `x-hypaware-upstream` a
  client cared to send. This is the header's security boundary and is worth
  stating explicitly rather than leaving it to be inferred from the preset
  shape.

@ref LLP 0157#requirements [implements]: R6, the real upstream identity must
travel as request metadata; this section is that metadata's exact name,
writer, readers, and the reason it carries a name and not a URL.

## 5. LLP 0159 match keys: cross-shape content normalization {#match-keys}

**Fork:** Claude's precedent (`claude/src/transcripts.js`) hashes the raw
wire content array directly: `contentKey(role, content) =
sha256Hex(role + ':' + canonicalJson(stripVolatileBlockFields(content)))`.
This is valid there because Claude Code's transcript stores byte-identical
wire-shaped blocks. It is not reusable as-is for OpenClaw: the session
JSONL stores OpenClaw's own normalized message shape, and LLP 0159 already
names one concrete divergence (`toolCall` vs. the Anthropic wire's
`tool_use`). Hashing the session file's blocks directly against a
wire-content hash would simply never match.

**Decision:** one canonical, shape-independent tuple format, fed by two
shape-specific builders, both funneling into one hash function so there is
exactly one hash implementation to drift, the LLP 0150 anti-drift argument
applied to a hash instead of a file parse. New module
`hypaware-core/plugins-workspace/openclaw/src/match_key.js`:

- `canonicalMatchKey(role, tuples)` returns
  `sha256Hex(role + ':' + canonicalJson(tuples))`, reusing the generic
  `canonicalJson`/`sha256Hex` primitives from `src/core/util` (safe to reuse
  across plugins: these are content-independent generic utilities, not the
  OpenClaw format knowledge LLP 0158 keeps plugin-local).
- `wireMatchKey(role, content)`: builds `tuples` from Anthropic/OpenAI
  wire-shaped blocks via `stripVolatileBlockFields` plus a per-block
  `{ kind, identity }` reduction (`kind: 'text' | 'tool_use' | ...`,
  `identity`: the text hash or the tool name plus argument hash). Called by
  the projector (Section 3.5) at capture time, stamped as
  `attributes.openclaw.match_key` on every row emitted under fallback
  identity (R8).
- `sessionMatchKey(role, blocks)`: builds the same `{ kind, identity }`
  tuple shape from the session file's own block records, through a small
  synonym table (`toolCall` maps to `tool_use` is the one mapping LLP 0159
  already names; the full table is verified against live OpenClaw session
  files at implementation time, the same way LLP 0158's header shape was
  verified against live files rather than assumed). Called by the
  settlement enricher (Section 6) when it builds its per-session lookup
  index. This synonym table is OpenClaw format knowledge and stays in
  `@hypaware/openclaw`, consistent with LLP 0158's placement decision for
  the reader itself.

**Fallback matcher.** LLP 0159 names an ordinal/timestamp fallback as the
shape to use when content matching misses. Decision: when
`canonicalMatchKey` finds no entry in the session index, retry once against
`(role, ordinal among same-role messages in the session)` bounded to a
five-minute window of the row's `message_created_at`. This is deliberately
a narrower, second-pass matcher rather than a merged first-pass score, so a
match via content hash (strong evidence) and a match via ordinal-plus-time
(weaker evidence, degrades gracefully as sessions replay or retry) are never
conflated in the same code path; if the exact table needs adjusting later,
the two passes can be tuned independently.

@ref LLP 0157#requirements [implements]: R8, stamp the LLP 0159 match key
on every fallback-identity row, resolved as a two-sided, single-hash-function
normalization rather than a single shared parser, because the two sides
start from genuinely different message shapes.

## 6. The settlement enricher {#settlement-enricher}

New module `hypaware-core/plugins-workspace/openclaw/src/settle.js`,
`createOpenclawSettlementEnricher(opts)` returning
`{ name: 'openclaw-settlement', clientName: 'openclaw', settle(rows, ctx) }`,
registered in `activate()` right after `registerExchangeProjector`, mirroring
`claude/src/index.js`'s placement.

Structure follows `claude/src/settle.js`'s shape with one simplification
LLP 0158 makes possible: Claude's `pickRecordForRow` exists because a Claude
Code session can carry multiple session-context records over time (a
mid-session `cd`), so the enricher must pick the record valid at the row's
own timestamp. An OpenClaw session file carries exactly one `cwd`, stated
once in the header (LLP 0158 Context). There is nothing to pick between: the
enricher resolves the session's cwd once per session file and applies it to
every row that session settles. This removes an entire class of Claude's
logic (time-slicing across multiple candidate records) rather than porting
it unnecessarily.

Per session (grouped by `session_id`, mirroring Claude's `bySession` Map):

1. Read the session file once via the LLP 0158 reader:
   `{ sessionId, cwd, startedAt }` (header) plus the full transcript
   iteration. Best-effort: a missing or unparseable file yields an empty
   index and an absent cwd, never throws; a settlement failure degrades to
   "row stays at fallback identity, no drop," never to a lost row.
2. Build a `Map<matchKey, { nativeId, blocks }>` from the transcript via
   `sessionMatchKey` (Section 5), scoped to this one session file only (no
   cross-session lookup: subagent sessions, if OpenClaw writes them to a
   separate file per LLP 0158's open question, simply will not match here
   and stay at fallback identity, an accepted, documented degradation, not
   a crash; see Section 10 for the open-question tie-in).
3. For each row in this session: read `attributes.openclaw.match_key`, look
   it up (content match, then the ordinal/time fallback, Section 5). On a
   hit, upgrade the row's native identity (recompute `message_id`/`part_id`,
   strip the spent `openclaw.match_key`/`gateway.identity_source` attributes,
   mirroring `upgradeRow`/`cleanAttributes` in the Claude precedent).
4. Independent of match success, apply the session's single header `cwd`
   through the shared usage-policy resolver. When `policy.class === 'ignore'`,
   return `USAGE_POLICY_DROP` at that row's array position, logging
   `plugin.openclaw.usage_policy_drop` with `component`, `operation`,
   `policy_source: 'settlement_late_resolve'`, `session_id`, `cwd_hash`
   (never raw cwd), `declared`/`governed_by`, the same shape as the Claude
   precedent's drop log, for one-query cross-adapter observability.

@ref LLP 0157#requirements [implements]: R14, resolve the session's cwd
through the LLP 0158 reader, stamp it on settled rows, and drop a row whose
resolved cwd is policy-ignored before it is committed; and R9, since both
the header read and the transcript read go through the one LLP 0158 reader,
never a private parse.

## 7. The backfill provider {#backfill-provider}

New module `hypaware-core/plugins-workspace/openclaw/src/backfill.js`,
`createOpenclawBackfillProvider(opts)` implementing `BackfillContribution`
(`name`, `plugin: '@hypaware/openclaw'`, `datasets: ['ai_gateway_messages']`,
`plan(ctx)`, `run(ctx): AsyncIterable<BackfillItem | BackfillEvent>`),
registered via `ctx.backfills.register(...)` in `activate()`, mirroring
Codex's placement.

Per session file under `~/.openclaw/agents/*/sessions/*.jsonl` (enumerated
within `resolveWindow(ctx)`'s bounds via `filterByWindow`, both from
`src/core/backfill/scan_util.js`):

1. Read the header via the LLP 0158 reader. No usable `cwd` (absent, or not
   an absolute path) means the session is not gated; it projects, matching
   the existing convention LLP 0157 states explicitly (Backfill). A usable
   `cwd` is resolved through the shared usage-policy resolver once per
   file; `ignore` skips the whole file (never projects any of its rows,
   surfaced as a `covered_by`-style skip event on the `BackfillEvent`
   channel), which is cheaper and equally correct to per-row gating since
   the cwd is session-wide (Section 6's same simplification).
2. Iterate the transcript. CLI-backend exclusion (R10): a `message` record
   whose `provider`/`api` names a CLI-backend route (`claude-cli/*`, or a
   `codex`-identifying value) is skipped, not projected; that turn belongs
   to the sibling Claude/Codex transcript adapters (LLP 0147
   [constrained-by]), and re-projecting it here would double-count it under
   the wrong `client_name`. The exact `provider`/`api` string set a
   CLI-backend turn carries in the session file is verified against live
   OpenClaw output at implementation time (the session file schema was only
   verified for the shadow-covered shapes so far, per LLP 0158); until then
   this filter defaults to an explicit allowlist (project only records whose
   `provider` is `'anthropic'` or `'openai'`) rather than a denylist, so an
   unrecognized future `provider` value fails closed (excluded, not
   silently mis-attributed) instead of failing open.
3. For a message record that passes both filters, build an
   `AiGatewayProjectedExchange` directly from the session file's own fields
   (native `message_id` from the record's own id, `previous_message_id`
   chained the same way the live row-expansion path does, `usage` from the
   record's `usage` block, `model`/`provider`/`api` from the record). This
   is a new session-file-to-projection converter, not a reuse of
   `anthropicMessages()`/`openaiMessages()` (Section 3.5), which parse wire
   request and response bodies; the session file already carries one
   flattened, authoritative per-message record, so there is no wire pair to
   reconstruct. Backfilled rows therefore carry native identity directly;
   they never go through `computeMessageId`'s fallback-hash path and never
   need a match key, because backfill is reading the authoritative source
   the live path only gets a fallback hash until settlement upgrades it.
   This is exactly what makes R11 (identity-identical to settled live rows)
   true by construction rather than by coincidence: both routes converge on
   the same native `message_id`, so `part_id` dedupe (`dedupeByPartId` /
   `createBackfillDedupe`) collapses the overlap to zero writes.
4. Wrap each projection with `projectedExchangeItem(exchange, { client_name:
   'openclaw', source_path: sessionFilePath, native_id: record.id })` and
   yield it (`src/core/backfill/scan_util.js`).

@ref LLP 0157#backfill [implements]: backfilled rows carry the same
`client_name` and `conversation_source` as live rows and no route marker,
matching the Codex posture; and R11, resolved by backfill using native
identity directly rather than a second copy of the fallback-hash path.

@ref LLP 0157#requirements [implements]: R9 (LLP 0158 reader, no private
parse), R10 (per-session policy gate before any row projects, CLI-backend
turns excluded by an explicit allowlist that fails closed).

## 8. Core removals {#core-removals}

Two deletions, no behavior added:

- `src/core/config/client_detach_disk.js`: the branch
  `if (probe.format === 'json_path' && probe.marker_path) { return await
  detachJsonPathMarker({...}) }` and the `detachJsonPathMarker` function it
  calls.
- `src/core/daemon/status.js` (around line 1000): the read-side branch
  `if (probe.format === 'json_path' && probe.marker_path) {...}` using
  `getAtDottedPath`/`parseJsonRecordString`.

`json` and `toml` formats, and the `MALFORMED_MARKER` guard, are untouched
in both files. This is the last consumer of `json_path` in the repo (LLP 0143
already established this; this design does not re-derive it, only executes
the removal LLP 0143 accepted as breaking with no migration).

@ref LLP 0157#core-removals [implements]: the `json_path` branches are
deleted; `json` and `toml` remain; the `MALFORMED_MARKER` guard is
untouched.

## 9. Acceptance procedure {#acceptance}

`docs/ACCEPTANCE.md` gains `## openclaw_capture`, mirroring
`## codex_desktop_capture`'s exact heading structure (What it proves / What
it does not prove / Requires / Related / `### Steps` / `### If it fails`).

Differences from the Codex template, each because OpenClaw's mechanism
genuinely differs:

- Step 1 cannot check a settings-file marker (there is none, R7). Its
  replacement asserts the shadow providers registered: a steering-plugin
  debug/status surface (if OpenClaw exposes one) or, failing that, a probe
  request through the gateway confirming `x-hypaware-upstream` arrives.
  Exact mechanics depend on what OpenClaw's own plugin API exposes for
  introspection, verified at implementation time.
- A new step exercises the warning ledger: configure OpenClaw against a
  deferred-family provider (e.g. `anthropic-vertex`, if reachable without
  real cloud credentials, else simulated) and confirm a `deferred`-caused
  warning is queryable, satisfying R13's requirement that coverage
  reporting distinguish deferrals from gaps, as a lived check, not just a
  code path.
- The backfill step is unchanged in shape from Codex's: run
  `hyp backfill openclaw --since ...` over the window the live step just
  captured; pass condition is `rows_written: 0` with `rows_skipped >= 1`
  (LLP 0159 Consequences), proving Section 7's native-identity convergence
  in practice, not just in this document.

@ref LLP 0157#acceptance [implements]: R12, the procedure must exist and
must have been run by a human before the adapter ships; this section is
that procedure's design, landing it in `docs/ACCEPTANCE.md` and running it
is implementation work this document hands off, not something a design
document can itself satisfy.

## 10. Implementation-time verifications carried forward {#impl-checks}

Named so a plan does not silently skip them (LLP 0157 Implementation-time
checks already names the first two; this design adds two of its own from
Sections 5 and 7):

- Whether `pi-ai` adds the default betas itself absent a wrapper, and
  whether OpenClaw appends session JSONL lines in real time (both already
  named by LLP 0157, carried forward unchanged).
- The `toolCall`/`tool_use`-style synonym table `sessionMatchKey` (Section 5)
  needs against live OpenClaw session files: this design states the one
  divergence LLP 0159 already names and the mechanism for handling more,
  not an exhaustive table, because that table does not exist in this repo
  to read.
- The exact `provider`/`api` values a CLI-backend-routed session record
  carries (Section 7's backfill allowlist): verified against a live
  OpenClaw session that included at least one CLI-backend turn.

## 11. Decisions that deserve their own record {#future-llps}

Two calls in this design are narrow enough to state here, but the
`DEFERRED_SET` membership check (Section 2.1) and the CLI-backend allowlist
(Section 7) are both living lists whose correctness depends on OpenClaw's
own evolving provider catalog, not on anything in this codebase. If either
list needs its first addition after ship (a new deferred family, a new
CLI-backend route this repo has not seen), that addition should land as a
short decision LLP citing this one, not as a silent code diff: LLP 0146 set
the precedent of naming a deferred family explicitly rather than inferring
it, and the same discipline should apply the first time the list actually
changes, so the reasoning for adding (or not adding) a given provider is
findable later.

## References

- LLP 0016, 0027, 0037, 0044, 0045, 0049, 0085, 0103 (house constraints
  applied above)
- LLP 0109 (the prior "OpenClaw backfill is an open question" note, now
  answered by Section 7)
- LLP 0143 through 0149, 0152 (the Accepted decision set this implements)
- LLP 0150 (the anti-drift precedent Sections 1 and 5 both apply)
- LLP 0157 (the spec this design covers), LLP 0158, LLP 0159 (the backfill
  companion decisions this design's Sections 5-7 realize)
- `hypaware-core/plugins-workspace/claude/src/settle.js`,
  `hypaware-core/plugins-workspace/claude/src/transcripts.js`,
  `hypaware-core/plugins-workspace/codex/src/index.js`,
  `hypaware-core/plugins-workspace/codex/src/config.js`,
  `src/core/codex/rollout_session_meta.js`,
  `src/core/backfill/scan_util.js` (the precedent shapes this design mirrors
  or deliberately departs from, with reasons given in each section)
