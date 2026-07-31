# LLP 0045: Client attach on join (implementation design)

**Type:** design
**Status:** Active
**Systems:** Config, Daemon, Onboarding, Sources, Gateway
**Author:** Phil / Claude
**Date:** 2026-06-26
**Related:** LLP 0016, LLP 0036, LLP 0037, LLP 0041, LLP 0044
**Extended-by:** LLP 0086 (attach tracks the gateway's ephemeral port, extends the "attach once" model of Part 1 with endpoint-aware markers that re-attach on a rebind, and teaches manual `hyp attach` to read the daemon's live port from `status.json`; the §Part 1 proven-bound-endpoint invariant is preserved unchanged)

> [LLP 0044](./0044-client-attach-on-join.decision.md) decided **client attach on
> join**, the reversible instance of the [LLP 0036](./0036-central-config-driven-client-actions.decision.md)
> action seam: when a joined machine confirms a central config that enables a
> client adapter, the daemon performs that client's attach machine-effect and
> reverses it on leave. This document is the *implementation* design, the
> reversible-instance counterpart to [LLP 0041](./0041-central-config-client-actions.design.md)
> (which designed the seam itself plus the run-once backfill instance). It does
> for attach what LLP 0041 Parts 1–2 did for the reconciler and backfill: where
> the handler lives, the new context dependency it needs, the adapter changes
> that make the round-trip reversible, the config/status surface, and the
> independently-mergeable tasks.

The decision ([LLP 0044](./0044-client-attach-on-join.decision.md)) is the
authority for *why* (consent default-on, conflict back-up-&-restore, opt-out
operator-only); this design is constrained by it and must not relitigate it.
Where it makes a fresh choice (the reconcile-context seam, the adapter marker
field), that choice is called out.

`@ref LLP 0044: client attach on join (the decision this designs)`
`@ref LLP 0041: the seam + backfill design this mirrors`

## What the code already gives us

The seam was built reversible for exactly this instance; attach plugs into
machinery that already exists.

- **The reconciler already drives `reverse()`.** `createActionReconciler` in
  [`src/core/config/action_reconciler.js`](../src/core/config/action_reconciler.js)
  runs a *reverse gap* loop: for any persisted marker whose request key
  `desired()` no longer names, it calls `handler.reverse(requestKey, ctx)` and
  drops the marker on success. Backfill omits `reverse()` (imported data stays);
  attach is the first handler to implement it. The reconciler core needs **no
  change**.
- **The marker store is namespaced per `kind`.** The same module writes
  `config-control/client-actions.json` with a top-level bucket per handler kind;
  a second bucket (`"attach"`) costs nothing. A `done` marker short-circuits the
  forward gap, so an applied attach is not re-performed every pass.
- **The gateway capability exposes the client registry.** `AiGatewayCapability`
  ([`hypaware-plugin-kernel-types.d.ts`](../hypaware-plugin-kernel-types.d.ts))
  gives `listClients()`, `getClient(name)`, and `localEndpoint()`. The shared
  `hyp attach`/`hyp detach` router (`runClientLifecycle` in
  [`src/core/cli/core_commands.js`](../src/core/cli/core_commands.js)) already
  resolves a client this way and calls `client.attach({ endpoint, config,
  stdout, stderr, dryRun, json })`: auto-attach is a second caller of that exact
  *attach* path. (The *detach* branch is rerouted to the single core undo,
  Part 3, task 5; so it no longer calls a per-adapter `detach()`.) **Caveat:**
  `AiGatewayClientRegistration` has no owning-plugin field, so the registry alone
  can't map a client to its config entry, Part 1 closes that with the static
  `clientDescriptors`.
- **The static client→plugin map already exists.** `clientDescriptors`
  ([`src/core/plugin_catalog.js`](../src/core/plugin_catalog.js)), a
  `Map<clientName, { plugin, name, attachProbe? }>` derived from manifests, is
  what `status.js` uses to know which enabled plugins are client adapters. The
  attach handler enumerates `desired()` off the same map.
- **The adapter already reports what attach changed.** In `json: true` mode the
  Claude/Codex `attach()` emits a one-line JSON object with `changed`,
  `settings_path`, `port`, and `prev_value`
  ([`hypaware-core/plugins-workspace/claude/src/index.js`](../hypaware-core/plugins-workspace/claude/src/index.js),
  `writeAttachOutput`). The handler captures that to record the marker detail:
  no new adapter return contract.
- **Per-plugin policy validation has a template.** `validateBackfillSection` in
  [`hypaware-core/plugins-workspace/claude/src/config.js`](../hypaware-core/plugins-workspace/claude/src/config.js)
  validates `config.backfill`; `validateAttachSection` mirrors it for
  `config.attach`. The top-level plugin-config validator already passes unknown
  sibling keys through, so this is additive.
- **The status surface already renders arbitrary kinds.** `buildClientActionsReport`
  in [`src/core/daemon/status.js`](../src/core/daemon/status.js) iterates every
  marker `kind` generically into `done`/`failed`, and already special-cases
  `backfill` for the *declared-but-unrun* `pending`/`n/a` derivation. Attach adds
  a symmetric declared-targets derivation; the `done`/`failed` rendering is
  reused unchanged.

### Note: there is no handler `consent` slot

[LLP 0041 §Risks](./0041-central-config-client-actions.design.md#risks--open-questions)
anticipated "the handler `consent` slot exists so [attach] lands without
reworking the reconciler." The **implemented** `ActionHandler`
([`src/core/config/types.d.ts`](../src/core/config/types.d.ts)) has no such slot:
it is `kind` / `desired` / `perform` / `reverse?`. Attach needs none: consent is
**default-on**, enforced by `desired()` enumerating central-named clients and by
the operator off switch (`attach.on_join: false`), not by a per-perform gate
([LLP 0044 §Consent](./0044-client-attach-on-join.decision.md#consent-join-implies-consent-default-on)).
The anticipatory note in LLP 0041 is left as written (that record is immutable);
this is the corrected design.

## Part 1. The client seam in the reconcile context

The attach handler needs three things the daemon has but the generic reconciler
does not: a way to **enumerate** the client adapters and their owning plugins
(for `desired()`), a way to **invoke** a client's attach/detach effect (for
`perform()`/`reverse()`), and the **gateway endpoint** to point clients at.
These map to three optional fields on `ReconcileInput` / `ActionContext`
([`src/core/config/types.d.ts`](../src/core/config/types.d.ts)):

```ts
clientDescriptors?: Map<string, ClientDescriptor>  // enumerate: clientName -> { plugin, attachProbe, ... }
clients?: AiGatewayCapability                       // invoke: getClient(name).attach/detach
endpoint?: string                                  // the local gateway base URL
```

**The split between `clientDescriptors` and `clients` is load-bearing.**
`AiGatewayClientRegistration` (what `clients.listClients()` returns) carries
`{ name, defaultUpstream, attach, detach }` and **no owning-plugin field**, so it
cannot answer "is this client's plugin enabled in the config?" The static
`clientDescriptors` map
([`src/core/plugin_catalog.js`](../src/core/plugin_catalog.js):
`{ plugin, name, attachProbe? }`, keyed by client name), the same map
`status.js` already uses for backfill declared-targets, is the source of truth
for **enumeration and the client→plugin mapping**; the runtime `clients`
capability is used only to **perform the effect**. (Adding `plugin` to the
registration was the alternative; descriptors win because they need no
kernel-type change *and* hand the handler `attachProbe`, which the drift open
question later needs to re-detect attach state.)

The daemon (`runDaemon` in [`src/core/daemon/runtime.js`](../src/core/daemon/runtime.js))
resolves all three from boot: `clientDescriptors` from the plugin catalog,
`clients` from `boot.runtime.capabilities` when the gateway plugin is enabled
(`capabilities.has('hypaware.ai-gateway', '^2.0.0')` guards the lookup), and
`endpoint` from `gateway.localEndpoint()`, a **proven-bound** URL. (Hardening,
#179 round-3: the daemon path takes `localEndpoint()` and *only* that. If it
throws, the gateway never bound, the daemon leaves `endpoint` undefined and the
attach handler stays inert this pass rather than recording a base URL for a port
nothing bound; it attaches once a later boot observes a bound gateway. The
configured-`listen` fallback (`configuredGatewayEndpoint`) is kept only for the
**manual** `hyp attach`/`init` paths, where the user asked explicitly.) When the
manual path has *neither* (no gateway bound in the CLI process, no configured
`listen`, the normal shape of a central-managed install whose gateway binds an
ephemeral port only the daemon knows), `hyp attach` does not guess a port and
does not leak the internal `localEndpoint()` error: it probes the client's
on-disk attach state via `attachProbe` and reports "already attached, the
daemon manages attach" as a no-op success, or fails with a message that points
at starting the daemon or pinning `listen`. A client
adapter plugin
*requires* the gateway capability ([LLP 0016](./0016-ai-gateway.decision.md)), so
whenever a client plugin is enabled the gateway is too and the client is
registered; `desired()` still guards on `ctx.clients.getClient(name)` being
present so it never names a client `perform()` can't reach. (`startConfiguredSources`
runs during boot, `runtime.js:243`, *before* the reconciler is constructed and
any pass is scheduled, so the gateway is bound and its clients registered by the
time a boot-already-confirmed or confirm-edge pass executes; `localEndpoint()` is
live, not racing.)

Keeping these **on the context** (not captured in a handler closure) preserves
the reconciler's "knows nothing about Claude vs Codex" boundary: the *handler*
reads `ctx.clientDescriptors`/`ctx.clients`, the core never does. It also keeps
attach daemon-only by construction: a plain CLI boot has no gateway capability
*and* no `configControl`, so `hyp status` performs no machine effect.

## Part 2. The attach handler (`src/core/config/action_attach.js`)

A new module exporting `createAttachHandler(opts)` → `ActionHandler` and a
default `attachHandler`, mirroring `action_backfill.js`.

- **`kind: 'attach'`**, the marker bucket + status section key.
- **`desired(ctx)`**: pure. Iterate `ctx.clientDescriptors`; for each descriptor
  whose `plugin` is enabled in `ctx.config.plugins`, whose plugin entry does not
  set `attach.on_join: false` (read via `attach_policy.js`, the
  `backfill_policy.js` twin), and whose client the runtime registry has
  (`ctx.clients.getClient(descriptor.name)` defined), emit
  `{ requestKey: descriptor.name, params: { client: descriptor.name, plugin: descriptor.plugin } }`.
  The owning plugin comes from the **descriptor**, not from `listClients()` (which
  omits it: Part 1).
- **`perform(action, ctx)`**, in-process (a bounded settings write; **not** a
  subprocess like backfill, [LLP 0041 §Execution isolation](./0041-central-config-client-actions.design.md#execution-isolation)).
  Resolve `ctx.clients.getClient(client)`, call `attach({ endpoint: ctx.endpoint,
  config: {}, stdout: <capture>, stderr: <capture/log>, json: true })`, parse the
  one-line JSON, and return `{ status: 'done', detail: { settings_path,
  ...(prev_value ? { prev_value } : {}) } }`. A throw (file not writable,
  malformed settings) becomes a `failed` outcome the reconciler records and
  retries next pass.
- **`reverse(client, ctx)`**: **disk-driven, not adapter-driven.** The reverse
  case that matters (the central config drops the client) fires only *after* the
  staged restart has already unloaded that adapter, so `ctx.clients.getClient(client)`
  is `undefined` and there is no live `detach()` to call (Part 3 traces this).
  Reverse instead reads the descriptor's `attachProbe` (`settings_file`, format,
  marker), resolves the path with `resolveClientSettingsPath`, and replays the
  marker's self-describing undo record, strip the managed keys/hooks/block,
  restore `prev_base_url`, to leave the file clean. It is **the same single core
  undo `hyp detach` uses** (Part 3). It needs `ctx.clientDescriptors` and the
  filesystem, **not** `ctx.clients`. Returns `done` once the settings file is
  clean; the reconciler then drops the marker.

The handler is constructed with the captured-stream, filesystem, and clock seams
injectable so unit tests assert the `attach` call, the marker detail, and the
disk-driven undo without a live gateway.

## Part 3. Reverse runs from disk: the marker is a self-describing undo record

The headline reverse, an operator drops `@hypaware/claude` from the fleet
config, fires only *after* the apply engine's **staged restart**
([LLP 0025](./0025-remote-config-join-flow.spec.md#the-join-sequence)) has
relaunched the daemon **without** that plugin. At reverse time the adapter's
`registerClient` has not run, `getClient('claude')` is `undefined`, and there is
no in-process `detach()` to delegate to: the same reason the manual `hyp detach`
only works while the plugin is still installed. The only thing that survives the
restart is **disk state**: the client-action marker plus the client's own
settings-file marker.

Reverse is therefore **core/disk-driven and adapter-independent**, built on the
machinery core already has for the *read* side:

- `resolveClientSettingsPath`
  ([`src/core/daemon/client_settings_path.js`](../src/core/daemon/client_settings_path.js))
  resolves the settings path from the descriptor's `attachProbe.settings_file`.
- `probeClientAttached` ([`src/core/daemon/status.js`](../src/core/daemon/status.js))
  already reads the marker generically by format (`json` `marker_key` / `toml`
  `marker_header`) to decide attached/not. Reverse is the **write** counterpart:
  strip what attach wrote and restore what it backed up.

For that generic undo to be possible without the adapter, **`attach()` must write
a self-describing undo record into its marker**: enough for a format-aware but
plugin-agnostic core routine to fully reverse:

- **Claude (`json`):** the `_hypaware` marker records `prev_base_url` (the restore
  target) plus the managed env keys and hooks it added, so core can
  restore-or-remove `env.ANTHROPIC_BASE_URL`, remove the managed
  `ENABLE_TOOL_SEARCH` / `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` (see below),
  strip the managed `SessionStart`/… hook
  entries, and delete the marker, leaving **no orphaned hooks** still pointing at
  `hyp claude-hook`. The backup is preserved idempotently across a re-attach:
  once we own the URL the current value is *our* gateway URL, so a re-attach keeps
  the marker's recorded original rather than overwriting it. The same record
  also carries `prev_malformed`: any `env` / `hooks` block that was present on
  disk with the wrong JSON type and had to be rebuilt before attach could write
  into it, keyed by dotted path. Attach repairs rather than refuses, and the
  marker is what makes that repair reversible and reportable instead of
  destructive; the undo replays it under the never-clobber rule below. See
  [LLP 0163](./0163-attach-backs-up-a-malformed-block.decision.md).
- **Codex (`toml`):** the marked block is already self-delimiting
  (`# BEGIN/END hypaware …`) and records the prior `model_provider`, so core
  strips the block(s) and restores the recorded pointer.

Core stays **format-generic, never plugin-specific**: it knows `json` vs `toml`
and how to replay an undo record, not "Claude" vs "Codex". The split is clean: a
rich *write* (attach) needs the adapter (`ctx.clients`, Part 2); the *undo* is a
marker-guided removal core does from disk.

#### Never clobber a user edit: report every override, not just the last

The undo only reverses values that are **still the ones we wrote**. A managed
key whose live value no longer matches the record was re-pointed by the user
after we attached, so the undo leaves it in place and reports it through
`DetachFromDiskResult.warning`, which the attach handler logs as
`client_action.attach_reverse_warning`.

An undo record can carry **several** managed keys (Claude's marker already
records `ANTHROPIC_BASE_URL` plus each managed env addition; a `json_path`
record can carry several `set` entries), and they can be overridden
independently. The notice is therefore **per key**: core accumulates one
message for each key it left in place and folds them into the single `warning`
field. Reporting only the last key visited would silently hide the others,
which is exactly the case an operator needs told, since those keys stay on disk
after a detach that otherwise claims success.

The fold separator is ` | `, deliberately **not** `; `. Each notice already
reads "`<key>` was overridden externally; leaving in place", so a `; ` join
would produce four `; `-delimited clauses for two keys and leave a reader
unable to tell where one notice ends. No in-tree attach records a managed env
key or a dotted `set` path containing `|`, so ` | ` reads unambiguously for the
notices folded here.

That is a **readability** choice, not a promise that the field is splittable.
`warning` is shared with the `toml` undo, whose single notice interpolates the
user's live `model_provider` value ("… leaving `<value>` in place"), and a
`~/.codex/config.toml` reading `model_provider = "acme | prod"` puts ` | `
inside one notice. **No separator is safe field-wide, and the field must not be
parsed.**

`warning` stays a single human-readable string rather than becoming an array.
It is **displayed, never parsed**: `action_attach.js` logs it as a `detail`
attribute, and `hyp detach` prints it and echoes it verbatim into its `--json`
payload; nothing in the tree splits it. Keeping the string also keeps the
published `DetachFromDiskResult` contract and the `hyp detach --json` shape
unchanged. If a caller ever needs the keys individually, the honest move is a
new `warnings: string[]` field alongside, not a re-typed `warning`.

#### ENABLE_TOOL_SEARCH: keep deferred tool loading on through the gateway

Pointing Claude Code at the gateway has a hidden cost. When `ANTHROPIC_BASE_URL`
is a **non-first-party host**, Claude Code disables deferred (on-demand) tool
loading by default: it assumes an arbitrary proxy cannot forward the
`tool_reference` blocks that on-demand loading depends on, and instead sends
**every tool schema up front**. With the full tool set that is tens of thousands
of tokens of per-session context bloat, present on every request. The gateway
itself is innocent: it is a pure pass-through that forwards `tool_reference`
untouched; the switch is Claude Code's, keyed only on the base URL not being
Anthropic's.

So attach also writes `env.ENABLE_TOOL_SEARCH = "true"`, the documented override
that re-enables deferred loading for proxies that do forward everything (ours
does). Two rules keep this honest against the undo contract above, and they bind
**every** env key attach adds beside the base URL (see the next section for the
second one):

- **Only manage the key when it is ours.** If the user already set
  `ENABLE_TOOL_SEARCH` themselves and no prior marker recorded it as ours, attach
  leaves their value untouched and does **not** record it in `managed.env`. This
  is the same never-clobber-a-user-value stance the base URL takes, minus a
  backup: we only ever *add* the key when it was absent. **Ownership turns on the
  key being present, not on the type of its value.** Claude Code reads these keys
  as env strings, so it is tempting to treat a non-string as not-really-a-setting
  and overwrite it; that is wrong. settings.json is hand-edited JSON and
  `"ENABLE_TOOL_SEARCH": true` is a perfectly natural thing to write. A type test
  here is worse than no guard at all: attach coerces the value *and* records the
  key as managed, so the undo record now claims a key the user owns and detach
  deletes their setting outright. Presence is the whole test.
- **`prev_base_url` restores the base URL only.** It is the sole managed key with
  a backed-up prior. The undo therefore restores `ANTHROPIC_BASE_URL` to
  `prev_base_url` but *removes* any other managed key (like `ENABLE_TOOL_SEARCH`)
  rather than stamping the base URL onto it.
- **The backup is type-blind too, and needs to be more than the guard above.**
  Presence-not-type binds the base URL as well, by a different route. The
  managed additions have somewhere safe to land when a key is not ours: attach
  skips them. `ANTHROPIC_BASE_URL` has nowhere, because attach always repoints
  it, so `prev_base_url` **is** the never-clobber guard for this key rather than
  a supplement to one. Deciding whether to take the backup by the live value's
  JSON type therefore loses the value outright: a hand-written
  `"ANTHROPIC_BASE_URL": null` (a user switching an override back off) reads as
  nothing-to-back-up, attach records the key as managed with no prior, and the
  undo, seeing a managed key with no prior to restore, deletes it. Attach backs
  up whatever is at the key, the marker carries it at its real JSON type, the
  undo restores it on the field being **present** rather than on its type, and
  re-attach carries the recorded prior forward the same way. Only the
  human-readable `prev_value` / `restoredValue` report coerces to a string;
  what is on disk is never reshaped to fit it.

#### _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: keep the model's real context window

The same "not Anthropic's host" test costs a second thing, and this one is pure
display *and* pure behavior at once. Claude Code grants a native-1M model its 1M
context window only when the base URL host is `api.anthropic.com`; behind any
other host it assumes **200k**. Nothing about the session changes, but the
percentage does: a fresh attached session reports ~18% context where the same
session direct reports ~4% (measured real usage matches within a thousand
tokens). The shrunken assumed window is not cosmetic either - context warnings
and, for users who enable it, auto-compact fire against the wrong denominator, so
they trigger far too early.

Attach therefore also writes `env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = "1"`,
managed by the same two rules as `ENABLE_TOOL_SEARCH` above (only ever added when
absent or already ours; removed, never restored, on detach). The declaration is
**accurate**: the gateway is a byte-transparent pass-through to
`api.anthropic.com`, which is exactly what the flag asserts. That the flag also
gates other first-party behavior is therefore fine rather than a side effect we
tolerate.

What that "other behavior" actually is, read off the shipped Claude Code bundle
(verified against 2.1.215; the flag is one branch of a single
`isFirstPartyBaseUrl` predicate that otherwise host-matches
`ANTHROPIC_BASE_URL` against `api.anthropic.com`):

- **Sent to the upstream:** the `context-1m-2025-08-07` beta header (the window
  this section is about), `traceparent` propagation, and an
  `anthropic-usage-limit: extended` request header.
- **Sent to Anthropic's own API host, not to the gateway upstream:** error
  reporting, the org policy-limits fetch (which in turn supplies Claude Code's
  permission defaults), and memory-sync eligibility.
- **Not gated by it at all: credential choice.** The bearer token and the
  `oauth-2025-04-20` beta header ride an active OAuth session, and the API-key
  path rides a configured key; neither consults this predicate. Setting the flag
  therefore sends no secret anywhere it was not already going, because attach has
  already pointed `ANTHROPIC_BASE_URL` at the gateway and the gateway already
  forwards to whatever its upstream config says.

That accuracy is a **precondition, not an invariant**, and it is the one thing
this key needs that `ENABLE_TOOL_SEARCH` does not. `ENABLE_TOOL_SEARCH` asserts a
property of the *gateway* (it forwards `tool_reference` untouched), which is
always true. This key asserts a property of whatever the gateway *forwards to*,
and that is config: the `anthropic` upstream's `base_url` is an ordinary
configured string (the `hyp init` preset writes `https://api.anthropic.com`, and
an operator or org config can repoint it). Attach writes the declaration
unconditionally because the settings writer has only the local gateway port in
scope, not the gateway's upstream config, so repointing that upstream at a
non-Anthropic host makes the declaration false and applies the first-party
behavior it gates to traffic that never reaches Anthropic. Policing that is out
of scope for the settings writer; it is recorded here so the assumption is a
stated one rather than an implicit one.

The blast radius of a false declaration is bounded by the list above, and it is
**not** a credential problem: what extra reaches a repointed upstream is a
`traceparent`, a usage-limit header, and a beta header, none of them secrets, and
the first-party-only side channels aim at Anthropic rather than at that upstream.
What does break is the window itself, in the *unsafe* direction: a non-Anthropic
upstream that really is 200k now gets warned about and auto-compacted far too
late, and an over-long request fails at the upstream. That failure is loud, is
confined to a configuration the product does not otherwise support, and the only
code fix is to plumb the gateway's upstream config into a settings writer that
today takes a port. Hence the stated precondition rather than a check.

The honest caveat: the key is underscore-prefixed and undocumented, so a Claude
Code release may rename or drop it (last verified against 2.1.215, the same
release the predicate above was read off; that one version is the baseline every
stamp in the tree carries, code comment included). It fails *soft* - losing it
re-inflates the reported percent but breaks nothing - so the
mitigation is a note at the code, not a runtime probe: if attached sessions start
reporting an inflated context percent again, re-verify the key against the
current Claude Code. The alternative considered and rejected was a `[1m]`
model-name suffix, which restores the window per model only and means rewriting
user-visible model names.

Upstream tracking for the underlying gap (no supported way to declare a >200k
window behind a custom base URL): [anthropics/claude-code#68522](https://github.com/anthropics/claude-code/issues/68522).

**There is exactly one undo implementation, and it lives in core.** Both call
sites use it: the reconciler's `reverse()` *and* the manual `hyp detach` command
(`runClientLifecycle`'s detach branch routes through the core undo via the
descriptor instead of calling a per-adapter `detach()`). The adapters therefore
own **only `attach()`**: `AiGatewayClientRegistration.detach` is retired and the
adapters' settings-writing `detach()` removed. One implementation cannot drift
from itself: the reason we unify rather than keep two paths bound by a contract.

The cost, accepted with that choice: the format-generic undo must subsume what
the adapters' `detach()` did, including Codex's `# BEGIN/END hypaware …`
marked-block removal and prior-`model_provider` restore. The managed-block
convention thus becomes a **core-understood format contract** (part of the
`attachProbe` format), not a codex-plugin-private detail. Core still never
*imports* plugin code (which wouldn't survive the plugin being unloaded anyway);
it strips by format from the self-describing marker.

This realizes [LLP 0044 §Conflict](./0044-client-attach-on-join.decision.md#conflict-back-up--override-restore-on-leave)
("back up & override, restore on leave"): the backup is the marker's undo
record, and "leave" is the config-drop trigger (Part 5).

#### `settings_file` is home-relative, and a violation is loud

`attachProbe.settings_file` is **relative to `$HOME`** (`.codex/config.toml`),
and its first segment is the client's config home, which a `$<CLIENT>_HOME` env
override replaces. That was always the contract; it was only ever stated in
`resolveClientSettingsPath`'s JSDoc, and never enforced.

Unenforced, an **absolute** `settings_file` did not fail: `path.join(homeDir,
...settingsFile.split('/'))` swallows the leading empty segment and re-anchors
the path under `$HOME`, so
`/Library/Managed Preferences/com.anthropic.claudefordesktop.plist` silently
became `$HOME/Library/Managed Preferences/...`. The override branch was wrong
the same way (`parts.slice(1)` assumes a relative first segment, so it drops the
leading `/` and grafts the remainder onto `$<CLIENT>_HOME`). The probe then
answered about a file the manifest never named, and the usual answer was ENOENT,
which reads exactly like a correct "not attached". A probe reporting on the
wrong file is worse than a probe that fails: a **wrong negative is
indistinguishable from a right one**, which is how the Claude Desktop
`attach_probe` defect (#444) stayed invisible.

So the resolver **rejects** an absolute `settings_file`
(`ClientSettingsPathError`, `code: 'settings_file_absolute'`) rather than
honouring it. Rejecting, not honouring, because the `$<CLIENT>_HOME` override
has no meaning for an absolute path: the override relocates a config *home*,
which an absolute path does not have, so "honour it" would have to publish a
second, silently-different resolution rule for the same field. Since this
resolver is shared by the read side (the attach probe, the picker's
`settings_file` detect) and the write side (the disk-driven undo above), a value
core cannot resolve must fail rather than resolve to something else, or attach
and detach can disagree about which file they own. The picker's absolute-literal
needs are already served by the sibling `app_bundle` and `path` detect variants
([LLP 0136](./0136-install-experience-overhaul.plan.md)), so no *picker row*
loses expressiveness. `attach_probe` is the honest exception: it has only
`settings_file` and no absolute sibling, so a client whose real settings surface
is an absolute system path genuinely cannot declare one. That is not an
oversight to route around, it is the same finding from the other side - such a
file is not one the core probe/undo can read or replay anyway, which is why
[#445](https://github.com/hyparam/hypaware/pull/445) deletes Claude Desktop's
probe rather than respelling it.

A leading `/` is only the spelling that got reported. `../../../etc/passwd` is
the identical violation - it lands on a file the manifest never named, escapes
`$HOME` just as completely, and (unlike the absolute case) survives the
`isAbsolute` check - and it matters more here than in a read-only resolver
because `detachClientFromDisk` *reads and rewrites* whatever it is handed, and
`contributes.client` is unvalidated, so the value can arrive from a
remotely-installed or org-pushed plugin. So the rule is enforced on the
**resolved** path: it must stay under the base it resolved against
(`ClientSettingsPathError`, `code: 'settings_file_escapes_base'`). Each branch
is checked against its own base - `$HOME` normally, `$<CLIENT>_HOME` when the
override is set, because the override is precisely a licence to leave `$HOME`.
A `..` that normalizes away (`.codex/sub/../config.toml`) stays legal; the rule
is about where the path lands, not which characters it contains.

The containment test is **lexical** (`path.resolve` then a `base + separator`
prefix test), and two properties of that are worth stating rather than
rediscovering:

- The separator in the prefix test is the check. Without it a sibling whose
  name merely *starts* with the base's (`/home/username` against a `/home/u`
  base) reads as contained.
- The checked path is the returned path. A relative `$<CLIENT>_HOME` makes the
  join relative, and handing that back would return something re-resolved
  against `process.cwd()` at read time instead of the value validated at call
  time. The resolver's contract is an absolute path, so it returns the absolute
  one.

It is deliberately **not** `realpath`-based, so a config home that is itself a
symlink out of `$HOME` (`~/.codex -> /elsewhere`) still passes. That is the
boundary of what the guard promises, and it is the right boundary: the field is
resolved before the file must exist (attach *creates* it; the picker only stats
its directory), so `realpath` would fail on precisely the paths that matter
most, and planting that symlink already requires write access to `$HOME`, at
which point the settings file is the attacker's regardless. The untrusted input
here is the *manifest value* - `contributes.client` is unvalidated - and that is
what the guard contains.

Each caller turns the throw into whatever "observable" means on its surface, and
none of them swallows it into a plain negative:

- `probeClientAttachFromDescriptor` returns `{ attached: false, error }`, so
  `hyp status` distinguishes a broken manifest from an unmarked settings file.
  On **both** of its surfaces: `--json` carries the `error` field, and the text
  renderer prints the message under the client's line and refuses to collapse an
  errored client into the `clients: (none)` shorthand. A text surface that
  rendered the same client as a plain `not attached` would have reinstated the
  indistinguishable wrong negative one layer up from the probe.
- `hyp detach` (the core undo and its `--dry-run` path) fails loudly: a client
  whose settings file core cannot locate is one core must not claim to have
  reversed.
- The `hyp init` picker's detect probe keeps its documented best-effort stance
  and degrades to "not present". Detection only seeds checkbox state, and every
  user of it can still toggle the box.

One honest caveat on the "one resolver" argument: it holds for everything
**core** does (probe, picker detect, disk-driven undo), but the per-plugin
*attach* write side is not routed through it. `@hypaware/openclaw` calls the
shared resolver; `@hypaware/claude`'s `defaultSettingsPath` hardcodes
`~/.claude/settings.json` and ignores `$CLAUDE_HOME`, and `@hypaware/codex`
keeps its own `$CODEX_HOME` copy. So a `$CLAUDE_HOME` set today would already
make attach and detach disagree, by a different mechanism than this section
fixes. Not a regression and not addressed here: recorded so the next reader does
not mistake "core resolves this field for read and write alike" for "every
writer of this file agrees where it is".

Validating this at **manifest load** would be better still (the plugin author
learns at install, not at probe time), but `contributes.client` is not validated
today at all, and a bundled manifest currently violates the rule. That is left
to follow-up, sequenced after the Desktop manifest is corrected: adding the
check first would take a shipped plugin out of the catalog to punish a defect
already fixed elsewhere.

## Part 4. Per-plugin `attach` config + status surface

- **Config.** `attach.on_join` (boolean, default **true**) rides the client
  adapter's own `config` block, validated by that plugin's config-section
  validator: a `validateAttachSection` beside `validateBackfillSection` in the
  claude/codex `config.js`. No top-level schema; core validates nothing new. The
  operator off switch (`attach.on_join: false`) is locked with the central plugin
  entry ([LLP 0031 §Merge model](./0031-layered-config.decision.md#merge-model)),
  no local override ([LLP 0044 §Opt-out](./0044-client-attach-on-join.decision.md#opt-out-operator-only-no-local-override)).
- **Status.** `buildClientActionsReport` gains a declared-attach-targets
  derivation symmetric to backfill's, using the **same `clientDescriptors`-derived
  plugin set** status already builds for `backfillPlugins` to know which enabled
  entries are client adapters: an enabled client plugin entry on a joined host
  (`hasCentral`) is a desired attach target; with no marker it renders `pending`,
  with `attach.on_join: false` or on a non-joined host it renders
  `n/a`, and a `done` marker renders attached. A failed/pending attach does
  **not** flip `overall` to `degraded`
  ([LLP 0041 §Failure is surfaced, not fatal](./0041-central-config-client-actions.design.md#failure-is-surfaced-not-fatal)).

## Part 5. Reverse triggers: config-drop, not `hyp leave`

`reverse()` fires from the reconciler's standard reverse gap: a marker key
`desired()` no longer names. Concretely, two things can stop `desired()` naming a
client:

1. **The central config drops the client plugin** (the operator stops managing
   `@hypaware/claude` fleet-wide). This is the **headline v1 trigger**. The
   descriptor still exists in the catalog, but its plugin is no longer enabled, so
   `desired()` omits it → reverse gap → the disk-driven undo of Part 3 runs.
2. **`attach.on_join` is flipped to `false` while the plugin stays enabled.** Also
   reversed, by the same disk-driven undo. (The adapter happens to be live here,
   but reverse still goes through the disk path so there is one undo
   implementation, not two.)

**There is no `hyp leave` command**: a full unjoin (central layer removed
entirely) is not implemented, and even if it were, the reconcile pass is gated on
a present central layer (`boot.centralConfigPath != null` for the
already-confirmed pass; the confirm edge only fires during central polling), so a
host with no central layer runs no pass and reverses nothing. So v1's reverse is
**scoped to config-drop-while-still-joined**; un-attaching a fully-left machine is
a **manual `hyp detach`** (run while the plugin is installed) until a `hyp leave`
that drives a final reverse before tearing down the central layer lands. 0045
does **not** cite `hyp leave` as a live trigger; this scoping does not contradict
[LLP 0044](./0044-client-attach-on-join.decision.md) (which lists leave as a
future path), it sequences it.

## Module / seam breakdown (independently-mergeable tasks)

Ordered so each lands behind the previous but merges on its own.

1. **`attach()` writes a self-describing undo record**, claude + codex `attach()`
   record into their markers everything needed to reverse without the plugin
   (claude `_hypaware`: `prev_base_url` + managed keys/hooks; codex marked block:
   prior `model_provider`). This is the contract the single core undo (task 4)
   replays. Unit-tested via the marker contents.
2. **Attach policy reader**: `src/core/config/attach_policy.js`
   (`readAttachPolicy` tri-state over `config.attach.on_join`), the
   `backfill_policy.js` twin. Pure; unit-tested.
3. **Context seam**: extend `ActionContext` / `ReconcileInput` in
   `src/core/config/types.d.ts` with optional `clientDescriptors` + `clients` +
   `endpoint`. Tiny; no behaviour change until a handler reads them.
4. **The single core undo (= detach)**: a core routine (e.g.
   `src/core/config/client_detach_disk.js`) that reverses a client's attach from
   the `attachProbe` descriptor + the marker undo record, **format-aware** (`json`
   marker-key / `toml` managed-block) but plugin-agnostic, reusing
   `resolveClientSettingsPath` and the `probeClientAttached` format logic. It
   subsumes the adapters' old `detach()` (including the Codex marked-block strip).
   Unit-tested on fixture settings files with no plugin loaded.
5. **Retire adapter `detach()` + reroute manual detach**: drop `detach` from
   `AiGatewayClientRegistration` (kernel type) and from the claude/codex
   `registerClient` calls, and point `runClientLifecycle`'s detach branch at the
   task-4 core undo (resolved via the `clientDescriptor`). The existing
   `claude_attach_detach` / `client_attach_idempotent` smokes now exercise the
   core undo and must stay green: they are the cross-format regression for the
   single undo.
6. **Attach handler**, `src/core/config/action_attach.js`
   (`createAttachHandler` + `attachHandler`): `desired()` over
   `ctx.clientDescriptors` ∩ enabled plugins ∩ `attach_policy`, guarded on the
   runtime registry having the client; `perform()` calls `attach(json:true)` and
   records the detail; `reverse()` invokes the task-4 disk-driven undo (it does
   **not** call `ctx.clients`, which lacks the dropped client). Unit-tested with
   injected fake `clientDescriptors` + `clients` + filesystem.
7. **Daemon wiring**, `src/core/daemon/runtime.js`: resolve `clientDescriptors`
   (from the catalog), `clients`/`endpoint` (from `boot.runtime.capabilities`
   when the gateway is enabled), pass them into `reconcile()`, and register the
   handlers **`[attachHandler, backfillHandler]`: attach first**. The reconciler
   runs handlers serially and `backfillHandler.perform()` `await`s its (possibly
   multi-minute) subprocess, so attach-first starts live capture immediately
   instead of stranding it behind the historical import; attach (in-process) also
   can't be blocked by a hung backfill. Data is order-insensitive either way
   (both just land rows the forward sink drains): this is purely the latency
   ordering.
8. **Per-plugin `attach` validation**: `validateAttachSection` in the claude /
   codex `config.js`; wire into each plugin's config-section validator.
9. **Status surface**: the declared-attach-targets derivation in
   `buildClientActionsReport` (Part 4).

## Test strategy

- **Disk-driven reverse with no adapter (task 4):** given a fixture settings file
  with a hypaware marker and **no plugin loaded**, the generic undo strips the
  managed keys/hooks/block, restores `prev_base_url`, and leaves no orphaned
  hooks, proving reverse does not depend on `ctx.clients`.
- **One undo, both call sites (tasks 4, 5):** the core undo is exercised by manual
  `hyp detach` *and* the reconciler `reverse()` against the same fixtures and
  reaches the same end-state, there is no second implementation to diverge.
- **Reverse gap (task 6):** a `desired()` that drops a previously-applied client
  triggers `reverse()` once (invoking the task-4 undo); the marker is removed; a
  second pass is a no-op. Backfill's handler (no `reverse()`) is unaffected.
- **Idempotent re-attach (tasks 1, 6):** attaching twice keeps the *original*
  `prev_base_url` (not the gateway URL); a `done` marker short-circuits the second
  perform.
- **Conflict round-trip (tasks 1, 4):** pre-existing foreign base URL → attach
  backs it up and overrides → the core undo restores it byte-for-byte. The
  existing no-pre-existing-URL fixture still round-trips to empty.
- **Opt-out (tasks 2, 8, 9):** `attach.on_join: false` → `desired()` emits
  nothing, status `n/a`; a central-locked entry cannot be flipped by a local
  entry (reuse the LLP 0031 merge-drop harness).
- **Daemon-only (tasks 3, 7):** with no gateway capability, `clients`/`endpoint`
  are undefined and the handler is inert; `hyp status` performs no effect.
- **Failure surfacing (tasks 6, 9):** an `attach()` that throws writes a `failed`
  marker (not `done`), retries next pass, increments `attempts`, and status
  reports `failed` without flipping `overall`.
- **End-to-end (hermetic smoke):** a seeded join confirming a config that names
  `@hypaware/claude` auto-attaches (settings written, marker `done`, status
  attached) and does not re-attach on a second confirmed poll; then a follow-up
  confirmed config that **drops** `@hypaware/claude` reverses it (settings
  restored), the config-drop trigger of Part 5, exercised post-restart.

## Open questions

Carried from [LLP 0044](./0044-client-attach-on-join.decision.md#open-questions);
settle as the code lands.

- **Marker vs actual-file drift.** v1 keys idempotency on the marker, not the
  live settings file: a user who manually strips the gateway leaves a `done`
  marker, so the reconciler will not re-attach until the config changes. A later
  refinement could have `desired()` re-detect actual attach state via the
  `attach_probe` descriptor (which already powers `hyp status`) and re-apply on
  drift. v1 accepts the marker-only model, matching backfill.
- **Ordering vs first ingest.** ~~Open in [LLP 0036](./0036-central-config-driven-client-actions.decision.md#open-questions).~~
  **Resolved for the latency dimension** (task 6): handlers run serially and
  backfill `await`s its subprocess, so attach is registered **first** to start
  live capture without waiting on the import. Data remains order-insensitive (both
  land rows the forward sink drains); the smoke still asserts no dependency
  surfaces.
- **Codex prior-provider nuance.** "Restore the prior value" for Codex means the
  prior `model_provider`, not a URL; confirm the adapter round-trip in task 1's
  tests.
- **Undo-record completeness, the contract for the *sole* undo.** Since unify
  (Q5) makes the core undo (task 4) the **only** detach, the marker must be a
  complete undo record: a format-aware core routine has to fully reverse what
  `attach()` wrote *without importing plugin code* (for Claude: the managed hook
  entries, not just `prev_base_url`, or core re-derives them from the stable
  managed-hook pattern; for Codex: the `# BEGIN/END` managed-block convention,
  now a **core-understood format contract**). Settle the exact marker shape and
  whether core encodes the per-format replay generically or reads a declarative
  undo manifest the marker carries. Under-specifying it risks orphaned
  `hyp claude-hook` entries after a fleet-drop, and there is no second
  implementation to fall back on. Settle when tasks 1, 4, and 5 land.
- **Subprocess vs in-process consistency.** Attach is in-process; if a future
  client adapter's attach becomes unbounded (e.g. a network probe), revisit
  whether it should move to the subprocess profile backfill uses.

## References

- [LLP 0044](./0044-client-attach-on-join.decision.md): client attach on join (the decision this designs)
- [LLP 0041](./0041-central-config-client-actions.design.md): the seam + backfill implementation design this mirrors
- [LLP 0036](./0036-central-config-driven-client-actions.decision.md): the action seam (reversible-handler contract)
- [LLP 0037](./0037-backfill-on-join.decision.md): backfill on join (the run-once sibling)
- [LLP 0016](./0016-ai-gateway.decision.md): AI gateway / client adapters (`registerClient`, `attach`/`detach`, `localEndpoint`)
- [LLP 0031](./0031-layered-config.decision.md): layered config / merge model (plugin-entry locking)
- [`src/core/config/action_reconciler.js`](../src/core/config/action_reconciler.js), [`src/core/config/action_backfill.js`](../src/core/config/action_backfill.js), [`src/core/daemon/runtime.js`](../src/core/daemon/runtime.js), [`src/core/daemon/status.js`](../src/core/daemon/status.js): the code this design builds on
