# LLP 0023: Remote Config and Join Flow

**Type:** Spec
**Status:** Draft
**Systems:** Config, Sinks, Plugins
**Author:** Phil / Claude
**Date:** 2026-06-12
**Related:** LLP 0007, LLP 0008, LLP 0010, LLP 0014, LLP 0017; hypaware-server LLP 0009 (out of tree, design authority)

> Client-side spec for centrally-managed gateway configuration. Derived from
> the hypaware-server LLP 0009 handoff
> (`~/workspace/hypaware-server/llp/0009-remote-config.spec.md` is the design
> authority for the feature as a whole; this document owns the client half).

## Summary

A gateway can be configured entirely from the central server. MDM deploys a
**seed** — server URL + policy token, nothing else — and the gateway joins the
fleet, pulls its full config, installs any plugins that config names, and
becomes operational without the user ever touching a config file. Later edits
to the central config reconfigure the fleet on the poll cadence. This document
specifies the join sequence, the config pull loop, seed-config mode, apply
semantics, install-on-config, and last-known-good rollback.

This is **post-V1 work**: `@hypaware/central` is explicitly out of V1 scope
([LLP 0002](./0002-v1-scope.decision.md#out-of-v1-scope)).

## Motivation

The client user never touches a config file or knows one exists. Everything
the gateway does (plugins, sinks, query) is authored centrally and delivered
at join. The existing `@hypaware/central` plugin already has identity
bootstrap/refresh and the ingest path; what is missing is the config pull loop
and the apply machinery around it.

## The join sequence

1. Seed boots the kernel with the central plugin only.
2. `POST /v1/identity/bootstrap` exchanges the policy token for a JWT.
3. `GET /v1/config` pulls the operator-authored config.
4. Apply (persist + staged restart) → fully operational.

## Config pull loop

The central plugin is configured as a **sink instance**
([LLP 0014](./0014-sinks.spec.md#config-two-shapes)); the pull cadence lives
in its sink config block as `poll_interval_seconds` (already validated by
`central/src/config.js`, 5–3600s), separate from the cron `schedule` that
drives ingest exports. The pull and identity-refresh timers are
plugin-internal: started at activation, stopped at `close()` — no change to
the LLP 0014 sink contract.

`@hypaware/central`'s `src/sink.js` notes that refresh and config pull "live
on their own timers when wired in" — this spec wires the config pull:

- Pull **immediately on bootstrap success**, then on a steady timer (minutes;
  304s are cheap — the server ETag is a content hash of the served revision).
- The `proto.md` ETag/304/404/429 semantics are unchanged. The etag sidecar
  (`config-etag.json`) behavior stands.
- **`If-None-Match` must reflect the *running* config, never a
  downloaded-but-not-yet-applied one.** The server reads this header to track
  fleet convergence (it lands in the queryable `gateways` dataset), so a
  gateway mid-install/mid-apply keeps presenting its old etag until the new
  config has actually taken effect.

## Seed-config mode

The seed is an **ordinary v2 config file** — `~/.hyp/hypaware-config.json`
containing exactly the central plugin (server URL + policy token), nothing
else. There is no seed-specific file format and the kernel has no "seed"
state: seed-config mode is just this particular config booted, consistent
with [LLP 0010](./0010-config-model.spec.md#no-mode-field) (no mode flag; a
host is what its config says).

Such a config must boot cleanly: no sources, no other sinks, collecting
nothing, polling for config. This is a legitimate steady state for the
seconds between enrollment and first 200 — not an error.

The policy token lives in the seed config itself (the config file is mode
0600). Policy tokens are multi-use (server LLP 0008), so it is not consumed
on bootstrap; the first successful apply replaces the seed config wholesale,
which naturally retires the token from disk. From then on `identity.json`
carries the JWT.

`hypaware join <url> <token>` is convenience sugar for MDM install scripts:
it writes the seed config and performs the non-interactive daemon install,
and is specified as **exactly equivalent** to doing those two steps by hand —
a wrapper, not a second code path. It joins `init <preset>` and
`init --from-file` as a non-interactive entry point
([LLP 0011](./0011-setup-and-onboarding.decision.md#non-interactive-entry)).
Because a policy token is a multi-use, fleet-wide credential, `join` also
accepts `--token-file <path>` and stdin, and MDM scripts should prefer those
forms — a bare argv token lands in shell history and process listings.

## Apply semantics: staged restart

A pulled 200 body is a **full HypAware v2 config and replaces the operative
config wholesale** — no merging, no client-owned sections. Persist the
document, then restart. Never live-mutate.

Staged restart is a **process-level restart**: the daemon persists the new
config and exits; the service manager relaunches it
([LLP 0017](./0017-daemon-runtime.decision.md#staged-restart-for-config-replacement)
records the decision and why in-process re-activation is unsound — Node's ESM
module cache would run stale plugin code past the artifact hash check). The
in-place [same-shape reload](./0004-activation-and-paths.spec.md#same-shape-reload)
path is never used for remote apply.

Recommended persistence idiom: **A/B slots** — write each config to its own
path and flip an atomic pointer (symlink or one-line file) as the last step
before exit. Same semantics as "file swap," but a crash between persist and
restart can never leave an ambiguous operative config, and last-known-good
is crash-safe by construction.

### Apply engine is kernel surface

The central plugin is **transport only**: pull, ETag bookkeeping, auth. It
hands a downloaded document to a narrow kernel facade (shape TBD at
implementation, e.g. `ctx.configControl.stage(document)`); the **kernel**
owns validate → install pinned plugins → persist last-known-good → swap →
restart, and the rollback bookkeeping. Recorded in
[LLP 0003](./0003-core-vs-plugin-surface.spec.md#core-owns).

Why kernel-side: rollback state must survive the restart and pairs with the
kernel-owned config file; the apply engine is testable without HTTP (rollback
is exactly the code that must not be discovered broken in production); and a
future second management channel reuses it. Consequently
**last-known-good config and the remembered bad etag live in kernel-managed
state** ([LLP 0004](./0004-activation-and-paths.spec.md#state-directories)),
not the central plugin's state dir.

The `config-etag.json` sidecar must transition **atomically with the
operative config, in both directions**: it carries the etag of the *running*
config, so apply moves it forward and rollback reverts it (otherwise a
rolled-back gateway would present a converged etag while running
last-known-good). Since every sidecar change coincides with an apply or
rollback, the facade takes the etag alongside the document and the **apply
engine stages the sidecar with the swap**; the central plugin only reads it
(at boot, to populate `If-None-Match`).

Identity state (`identity.json`, JWT, gateway id) is **not config** and is
never touched by config application.

## Install-on-config (hash-pinned)

A pulled config may name plugins not installed on the machine. The client
installs them through the **existing
[LLP 0007](./0007-plugin-install-and-locking.decision.md) install path**
(prebuilt git artifact, never `npm install` —
[LLP 0008](./0008-plugin-runtime-dependencies.decision.md) — recorded in the
plugin lock file). Served configs always pin **version + artifact content
hash** (the server's save pipeline guarantees this); the client must verify
the artifact hash and treat a mismatch as an apply failure (→ rollback,
below). The config names exactly one artifact; nothing may substitute code
after authoring.

### Bundled first-party plugins

First-party plugins ship bundled in the kernel package
([LLP 0002](./0002-v1-scope.decision.md#plugin-packaging-divergence)) and are
never fetched at apply time. For a pinned plugin that is bundled with the
running kernel:

- The bundled copy satisfies the pin; the **artifact hash is not checked**.
  Bundled code is inside the existing trust boundary — it ships in the same
  npm package as the kernel performing the verification, and the server's
  hash refers to a git release artifact that legitimately differs from the
  npm-bundled tree.
- The pinned **version is checked strictly**: a mismatch between the pinned
  version and the bundled version is an apply failure (→ rollback, below).

Version-strictness means a fleet with mixed kernel versions (e.g. mid
rolling upgrade) can only converge on a config whose first-party pins match
every gateway's bundled versions — see open questions.

## Last-known-good rollback

If an applied config fails validation, a pinned install fails its hash check,
or the post-apply probation window (below) expires unsatisfied, revert to the
previous operative config (file swap + staged restart — cheap by
construction). Remember the failed revision's etag and **back off re-apply
attempts for that etag until the etag changes** — re-polling is fine, an
apply-crash loop is not. One remembered bad-etag value, no persistent
denylist. The client records a **structured rollback reason** (validation
failure / hash mismatch / probation expiry, plus the offending etag) from day
one — the server only sees non-convergence via `If-None-Match` and cannot
distinguish "rolled back" from "never applied," so if a rollback column is
ever added to the `gateways` dataset, the data must already exist
client-side. For V1 it surfaces in client logs and in `hypaware status`
([LLP 0009](./0009-cli-registry.spec.md#core-rendered-status)): probation
state, last rollback + reason, and the remembered bad etag — an operator at
the machine must not need log spelunking to learn the gateway rejected a
config.

Rollback restores the config, **not the install root**: plugin trees and
lock-file entries installed for the failed config stay on disk. The lock
file records what is installed, not what is active — the operative config
defines the active set — and keeping the artifacts makes re-apply after a
fixed revision cheaper.

### Post-apply probation

Because apply is a process restart, the apply engine writes a **probation
marker to kernel-managed state before restarting** ("revision X applied at T,
probation until T+W"); the relaunched daemon reads it at boot. Probation is
cleared by the **first successful authenticated config poll** (200 or 304 on
`GET /v1/config`) after the restart — that one request proves identity
survived, the server is reachable, and the new config's central sink runs,
and its `If-None-Match` is simultaneously the server-side convergence signal,
so client probation and fleet convergence clear on the same packet. An ingest
POST is deliberately *not* the signal: an idle gateway with nothing to export
must still be able to clear probation. If the window expires unsatisfied, the
kernel rolls back: staged restart onto last-known-good, bad etag remembered.

The **kernel owns the probation timer and the rollback decision,
independently of the central plugin functioning** — a wedged or
wrongly-pointed central sink is precisely a case probation must catch. The
plugin reports a successful poll through the apply facade (a confirmation
call); **it never touches probation state directly**. Probation expiry is
also evaluated **at boot, before plugin activation**: a
kernel-killing-but-valid config that crashloops under the service manager's
relaunch policy may never live long enough for a running timer to fire, so
each relaunch checks the marker first and rolls back from boot if the window
has passed.

A probation-clearing poll may itself return 200 with a newer revision; that
triggers an immediate next apply, with its own probation. This chaining is
correct — do not serialize or suppress it.

W must comfortably exceed one poll interval plus retry backoff (e.g.
`max(3 × poll_interval_seconds, floor)` rather than a fixed constant), so a
slow operator-chosen poll cadence cannot make every apply roll back.

Rollback from the **first** applied config lands back on the seed config —
fine by construction: seed-config mode is a legitimate polling steady state,
and the bad-etag backoff prevents a re-apply loop.

## Wire contract amendments (`proto.md`)

`hypaware-core/plugins-workspace/central/proto.md` is the authoritative wire
reference and is amended by this spec:

- Served configs pin plugins by version + artifact content hash.
- `If-None-Match` reflects the running config (convergence semantics).
- 404 ("operator has not registered a config") is demoted to a legacy-only
  branch: every token now references a config at mint, so gateways enrolled
  under server LLP 0009 always resolve. Keep the polite backoff for
  conformance.
- The "bootstrap tokens are single-use" sentence is replaced by the
  policy-token amendment (server LLP 0008); both changes fold in together.

## Server-side guarantees the client relies on

- Every gateway enrolled through a policy token resolves to a config —
  join-time 404 is structurally impossible for new enrollments.
- The served document passed the server's save pipeline: schema-valid,
  plugins hash-pinned, and **always contains a central sink targeting the
  server's own external URL** (so a config that would disconnect the fleet
  can't be authored). The rollback backstop covers the residue
  (wrong-but-present URL, kernel-killing-but-valid configs).
- ETag changes exactly when the served bytes change (revision content hash).
  No push channel in V1: propagation latency = the poll cadence.

## Sequencing

Server lands first (registry, revisions, admin authoring endpoints,
mint-requires-config, serving, convergence columns) and ships dark.
`GET /v1/config` has existed since V1, so no capability handshake is needed.
Nothing server-side is blocked on the client; nothing client-side is blocked
on the server except end-to-end testing.

## Open questions

- Exact poll cadence default (the spec says "minutes"; pick a number when
  wiring the timer).
- Maximum accepted config document size. Wholesale-replace means an
  authenticated 200 of arbitrary size goes straight into memory and onto
  disk; a stated cap is one line of defense-in-depth. Pick a generous bound
  when wiring the pull.
- Exact probation window formula (the *signal* and the
  `max(3 × poll_interval_seconds, floor)` shape are decided; pick the floor
  when wiring).
- **Strict version pins for bundled plugins vs rolling kernel upgrades.**
  The strict check (above) means a kernel upgrade that bumps bundled plugin
  versions de-converges the fleet until the central config's pins are
  updated, and a mixed-version fleet cannot fully converge on one config.
  Considered alternative: treat the pin as enforced only for fetched
  artifacts and let config *validation* gate apply for bundled plugins,
  reporting the bundled version upward. Deliberately deferred — strict now,
  relax if upgrade thrash shows up in practice.

## References

- hypaware-server LLP 0009 (`0009-remote-config.spec.md`) — design authority
- hypaware-server LLP 0008 — policy tokens
- [`proto.md`](../hypaware-core/plugins-workspace/central/proto.md) — wire reference
- [LLP 0007](./0007-plugin-install-and-locking.decision.md), [LLP 0008](./0008-plugin-runtime-dependencies.decision.md), [LLP 0010](./0010-config-model.spec.md), [LLP 0014](./0014-sinks.spec.md)
