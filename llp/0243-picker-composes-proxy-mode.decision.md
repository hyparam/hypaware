# LLP 0243: The Claude picker row composes proxy_mode, so fresh installs default to proxy attach

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Plugins, Gateway
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0130, LLP 0135, LLP 0213, LLP 0232, LLP 0242, LLP 0251
**Extends:** LLP 0233 (#proxy-mode-is-explicit: the key is still the only
switch and is still explicit in the file; what changes is who writes it)
**Extended-by:** LLP 0262 (accepted 2026-08-17; the Claude row stops
declaring `compose.gateway_proxy_mode`, because the client it composes for
is no longer captured by proxy; the composition rule itself is unchanged)

> A picker row that attaches its client by proxy declares
> `compose.gateway_proxy_mode: true` in its manifest. The composition fold
> writes `proxy_mode: true` into the gateway block it already owns, the same
> way rows already contribute `gateway_upstream`s. The Claude Code row
> declares it; every path that rides the fold (interactive picker, express,
> `hyp init --yes`) and the literal `hyp init claude` preset therefore
> produce proxy-mode configs by default.

## Context

LLP 0233 made proxy mode explicit: `proxy_mode: true` in the ai-gateway
config is the only thing that turns it on, and a config never acquires it "by
inference, by upgrade, or as a side effect of installing an adapter". That
settled how the *daemon* reads the key. It did not settle who writes it, and
as LLP 0242 records, the answer shipped as "nobody": the wizard composes a
config without the key, so the default install still gets the base-URL attach
whose Remote Control breakage motivated LLP 0231 in the first place.

## Decision

### Composed by default {#composed-default}

The picker composition fold (`composePickerConfig`) learns one new
per-descriptor compose field, `gateway_proxy_mode`. When any picked row sets
it, the composed gateway block carries `proxy_mode: true`. The Claude Code
row sets it in `@hypaware/claude`'s manifest, beside the upstream it already
contributes; rows for clients that attach by base URL (Codex) do not, so a
Codex-only install mints no CA it will never use.

The `hyp init claude` preset writes its config literally rather than through
the fold, so it writes the key literally too.

### The user's key wins {#user-key-wins}

Composition owns the gateway's `upstreams` outright, but `proxy_mode` belongs
to the prior entry entirely on a reconfigure (LLP 0183 carry-forward): a
hand-written `proxy_mode: false` survives, and so does the key's *absence* -
an existing gateway entry without the key stays without it, because a
reconfigure is a picker run, not the LLP 0244 migration verb. Declining the
default is one explicit key, and it stays declined; the composed default
applies only where composition creates the gateway entry.

"Reconfigure" here means the interactive lane, the only one that folds the
existing config in. A non-interactive re-init (`--yes`, presets,
`--from-file`) composes from scratch by design - its output stays
byte-identical for the same inputs, and it only ever overwrites an existing
file behind an explicit `--force`, which is the whole-file consent - so it
re-applies the composed default like a fresh install.

### Still explicit, still consented {#still-explicit}

LLP 0233's invariant survives narrowed, not discarded. The key is still the
only switch, and it still never lands in a config the user did not just ask a
setup flow to write: composition writes whole configs on the user's
instruction, which is not inference, not an upgrade, and not a side effect of
dropping an adapter into an existing install. The materially larger ask, the
trust grant for the CA, keeps its own consent moment: the keychain dialog at
attach (LLP 0237), which a user can refuse while keeping capture.

Existing configs are exactly what this decision does not touch: they gain the
key only through LLP 0244's consented migration.

## Consequences

- Fresh installs attach Claude through the proxy and keep Remote Control
  working, with no extra wizard question.
- Hermetic smokes that drive the picker now boot gateways that mint a CA in
  the temp `HYP_HOME`. Attach-exercising smokes must never reach the real
  keychain or launchd environment; see the LLP 0244 test-sandbox consequence.
