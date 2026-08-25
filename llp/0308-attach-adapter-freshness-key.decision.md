# LLP 0308: The attach marker carries an adapter-computed freshness key

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Plugins, Gateway
**Author:** Phil / Claude
**Date:** 2026-08-25
**Related:** LLP 0044, LLP 0045, LLP 0086, LLP 0099, LLP 0107, LLP 0138, LLP 0262

> A client adapter may declare `attachKey()`: an opaque string naming the
> client-owned input its `attach()` would write from right now. The reconciler
> records it on the `done` attach marker and recomputes it every pass, so drift
> in an input only the adapter can see is a forward gap it closes by
> re-attaching. Codex declares one: the gateway route its `auth.json` selects.

## Context

`action_attach.js`'s `isCurrent()` decides whether a `done` attach marker still
short-circuits. It had three keys, and every one of them is a fact **core**
already holds:

- the gateway endpoint the attach was applied at (LLP 0086),
- the digest of the client asset set the attach installed (LLP 0107, LLP 0138),
- Claude's attach mode, a fixed constant compared against `'otel'` (LLP 0262).

Codex's attach writes a fourth thing none of those can see. `hyp attach codex`
picks between two gateway routes by reading Codex's own `auth.json` (LLP 0099):
a ChatGPT subscription gets `.../backend-api/codex`, anything else gets
`.../v1`. LLP 0099 recorded the consequence and left it: "a user who switches
login modes must re-attach to move routes."

Issue #996 is what that consequence costs on an enrolled machine. Switching auth
mode moves neither the port, nor the asset set, nor any mode constant, so
`isCurrent()` called the marker fresh on every pass and the daemon never
re-attached. `config.toml` kept naming the old route, and the gateway routes by
path faithfully in both directions: an `sk-` key goes to `chatgpt.com` on the
stale subscription route, and a subscription OAuth token goes to
`api.openai.com` on the stale API-key route. Each sends a credential to a host
not scoped for it, so every Codex turn fails until a human runs
`hyp attach codex`, and nothing in HypAware names the config as the cause.

The `attach_probe` cannot close this. Codex's probe is `format: toml` with a
`marker_header`, and the TOML branch answers only `{ attached }`: it confirms
the managed block exists and never reads its `base_url`. Even a probe that did
read it would only report what is on disk, which is not the same question as
what *should* be on disk.

## Options considered

1. **Teach core to read `auth.json`.** The Claude-mode key is already a
   `client === 'claude'` special case in core, so there is precedent. But that
   precedent is a *constant*; this would put Codex's file layout, its
   `CODEX_HOME` override, and LLP 0099's inference rule inside the generic
   reconciler, which LLP 0036 exists to keep free of per-client knowledge.
2. **Let the adapter name its own key.** Add an optional `attachKey()` to
   `AiGatewayClientRegistration`. The daemon stores the string it returns and
   compares it later; it never parses it. Core learns one new word, adapters
   keep their own knowledge, and any future adapter with a client-owned input
   gets the same currency for free.
3. **Route by credential in the gateway.** Detect an `sk-` key arriving on
   `/backend-api/codex` and re-route per request. This fixes the failing turn
   rather than the stale config, and it covers Codex Desktop too, but it makes
   the gateway's routing table depend on credential sniffing, which extends
   LLP 0157's routing model and wants its own request.
4. **A Codex `SessionStart` hook.** Codex resolves its provider from
   `config.toml` at process start, so a hook repairs the *next* session, not the
   failing one, and re-attaching per session start races `writeAtomic`'s mtime
   guard against Codex Desktop sharing the same file.

## Decision

Option 2.

### The key is adapter-computed

`AiGatewayClientRegistration` gains an optional
`attachKey(): Promise<string | undefined> | string | undefined`. It returns an
opaque string naming the client-owned input the adapter's `attach()` would write
from right now: everything outside the gateway endpoint and the asset set, which
the reconciler already tracks itself. It must be cheap, side-effect free, and
stable for an unchanged input, because it runs on every reconcile pass.

`perform()` records the returned string as `attach_key` on the `done` marker;
`isCurrent()` recomputes it and compares. Both halves route through one core
reader (`readAttachKey`), so what is recorded and what is recompared cannot come
from different code. Core treats the value as opaque: it compares for equality
and never interprets, which is what keeps the reconciler generic.

`perform()` reads the key **before** it calls `attach()`, not after. The adapter
reads the same client-owned input a second time inside `attach()`, so the two
reads straddle a window (the attach itself, plus the asset copy that follows)
that a `codex login` can land in. Reading first records a key at least as old as
the effect: a mid-pass change then recomputes differently on the next pass and
re-attaches, which is idempotent and settles. Reading last would record a key
*newer* than the `base_url` that landed, and `isCurrent()` would match it
forever over a config naming the wrong route, which is issue #996 again and
unreachable by any later pass. The key must fail toward one redundant attach,
never toward a permanent stale one.

Reading a client-owned input means touching the filesystem, so `isCurrent()`
becomes async and the reconciler awaits it. `ActionHandler.isCurrent` therefore
returns `boolean | Promise<boolean>`; a sync predicate still works unchanged. A
predicate that *rejects* is treated exactly like one that throws: current. An
unexpected error must never re-perform a settled effect in a loop.

`undefined` is the honest "cannot tell", and every degenerate case collapses to
it: no registration this pass, an adapter that declares no hook, a hook that
returns a non-string, a hook that throws. `isCurrent()` treats it as current
rather than re-attaching on a value nothing trusts, which is the same guard the
endpoint and asset keys already apply. A freshness key is an optimization over
re-attaching, so a broken one must never turn a settled attach into a `failed`
marker.

The adapter key is checked **last**, after the three pure keys. It is the only
one that reads disk, so a pass that has already drifted settles without touching
the filesystem at all.

### Drift is a forward gap

A recomputed key that differs from the marker's makes the still-desired action a
forward gap, and the reconciler re-performs the attach this pass. That is the
same shape LLP 0086 established for the endpoint and LLP 0107 for the asset set,
and it works for the same reason: `perform()` is idempotent, and Codex's
`prepareAttach` strips and re-emits the whole managed block rather than patching
it, so the re-attach recomputes `base_url` from the current auth mode.

A pre-LLP-0308 marker records no `attach_key`. `undefined !== key` reads as
stale exactly once, which records one and makes every later pass current: the
same self-healing migration the other keys shipped with.

### The key is the route, not the auth mode

Codex returns the route path prefix (`/v1` or `/backend-api/codex`), not the raw
`auth_mode` it read. Only the route decides what lands in `config.toml`, so
`auth_mode: "apikey"` and an absent field both key to `/v1` and neither
re-attaches over the other. This matters because LLP 0099 exists precisely
because Codex stopped writing `auth_mode`: keying on the raw mode would turn a
Codex upgrade into spurious drift, while keying on the route makes exactly the
changes that would write a different `base_url` count.

### Unreadable is not the v1 default

The adapter has to hold a distinction `attach()` does not. `readCodexAuthMode`
collapses every failure into `undefined`, which `attach()` may treat as the
`/v1` default because it has to write *some* route from whatever it can see. The
key may not: a permission error, malformed JSON, or a truncated file caught
mid-write by a `codex login` or a token refresh is "cannot tell", and keying it
to `/v1` would report a settled subscription attach as drifted and re-attach it
onto the route its credential is not scoped for, which is the exact harm this
document exists to prevent. So `attachKey()` returns `undefined` there and
`isCurrent()` leaves the marker alone.

A *missing* `auth.json` is not in that class. It is the state `attach()` writes
`/v1` from, so it is a fact rather than an unknown and keys to `/v1` like any
other API-key login.

## Consequences

- A Codex login switch self-heals on the next reconcile pass on an enrolled
  machine. The user does not have to know that HypAware's `config.toml` write is
  what broke their turns.
- Any adapter with a client-owned attach input can opt into the same currency by
  declaring `attachKey()`. Adapters without one (claude, openclaw) are unchanged
  and stay judged by the three existing keys.
- `isCurrent()` now performs one small read per attached client per reconcile
  pass, for adapters that declare the hook. Codex's is a single `auth.json`
  parse it already does at attach time.
- This does not make the drift *reportable*. `hyp status` still cannot say the
  managed `base_url` disagrees with `auth.json`, because the TOML `attach_probe`
  still answers only `{ attached }`. Surfacing it is a separate request.
- It does not cover the window between the login switch and the next reconcile
  pass, nor the direction LLP 0099 already named as unsafe: a subscription login
  that leaves a stale `OPENAI_API_KEY` behind still infers no mode and keys to
  `/v1`. Routing by credential in the gateway (option 3) is the fix for the
  failing request itself and remains open.

## References

- `src/core/config/action_attach.js` (`perform`, `isCurrent`, `readAttachKey`)
- `src/core/config/action_reconciler.js` (`markerIsCurrent`)
- `hypaware-core/plugins-workspace/codex/src/index.js`
  (`attachKey`, `providerRouteKeyForAuthMode`)
- `hypaware-plugin-kernel-types.d.ts` (`AiGatewayClientRegistration.attachKey`)
- `test/core/attach-auth-route-drift.test.js`, `test/plugins/codex-auth-mode.test.js`
- Issue #996
