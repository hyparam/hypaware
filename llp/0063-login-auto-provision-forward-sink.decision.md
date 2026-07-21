# LLP 0063: Login-initiated enrollment — auto-provision the central sink

**Type:** Decision
**Status:** Active
**Systems:** CLI, Onboarding, Sinks, Gateway
**Author:** Kenny / Claude
**Date:** 2026-07-04
**Related:** LLP 0061, LLP 0025, LLP 0031, LLP 0036, LLP 0037, LLP 0044, LLP 0058, LLP 0033, LLP 0041/0043; hypaware-server LLP 0017 (domain→org, design authority), LLP 0020 (login-minted gateway)

> The goal: a member of a domain-claimed org runs **one** command — `hyp remote
> login` — and the host starts forwarding logs to the org's central server with no
> second command, no bootstrap token, and no hand-edited config. This is the client
> half. The org-authorization half (which verified email domains map to which org,
> and how a domain is claimed) is owned by hypaware-server LLP 0017 and is out of
> tree here.

## Summary

LLP 0061 taught `hyp remote login` to capture a login-minted **gateway credential**
and seed it into the `@hypaware/central` forward sink's persisted identity — but
only into a sink that **already exists**. On a fresh, login-first box no such sink
is configured, so the credential lands nowhere and the command prints the dead-end
note:

```
note: the server issued a forwarding credential, but no '@hypaware/central'
sink targets this server - configure one to forward logs
```

This directly contradicts LLP 0061's own headline consequence ("a user who runs
`hyp remote login` can forward immediately"). This document closes that gap: when
the login response carries a gateway credential and no `@hypaware/central` sink
targets the server's origin, `hyp remote login` **enrolls the machine**: it provisions the
sink block `hyp join` already writes (`runJoin`, `src/core/cli/core_commands.js:3273`),
seeds its identity via the LLP 0061 path, and finishes with join's daemon install
— making login the attended sibling of join (D6). The presence of the gateway
credential is the server's assertion that this human's org is entitled to
forward; the client acts on that assertion, after warning the user pre-auth (D3).

## Implementation status (client half)

<a id="impl-status"></a>
**Implemented 2026-07-04.** `hyp remote login` now provisions the
`@hypaware/central` sink and forwards from one command:

- **`enrollCentralSink`** (`src/core/cli/core_commands.js`) writes join's sink
  block — minus the bootstrap token, with `identity: {}` (the plugin validator
  requires an identity object; the login-minted gateway seeded into
  `identity.json` is the credential) at the server **origin**, not the
  `<origin>/mcp` query target — to the central-seed layer, inherits join's #139
  reset, seeds the identity via LLP 0061, and finishes with join's
  `runDaemonInstall` (D2, D5).
- **`runBrowserLogin`** (`src/core/cli/remote_commands.js`) runs the D4 pre-auth
  exclusivity gate (`readCentralSinkOrigins`), prints the D3 pre-auth consent
  notice, honors `--no-forward` (query-only) and `--no-daemon`, and replaces the
  old dead-end note with the `provisioned … forwarding to …` line plus the
  interim `run 'hyp attach <client>'` hint.

**The D4 gate keys on the central layer, not the effective (local+central)
config.** A hand-authored `@hypaware/central` sink in the user-owned *local*
layer is not an enrollment — `hyp leave` refuses to touch it (#111) — so it must
not count as "connected"; otherwise the gate would block login to a different
server with `hyp leave` advice that cannot clear a local sink. The gate and
`hyp leave` share one definition of "connected": the central layer.
Provisioning is atomic against partial failure — if seeding the identity into
the just-written sink fails, the seed is rolled back so no credential-less sink
lingers (which would otherwise make the daemon demand a bootstrap token the
login user never had). And `--no-forward` on an already-enrolled machine reports
the truth ("stays enrolled") rather than a false "not enrolled".

Deferred, named follow-ups: D4's seed-time recheck is not yet under the LLP 0065
lock ([§D4](#d4)); the D2 attach cascade still needs server LLP 0043
([§login-config-pull](#login-config-pull)); `hyp remote logout` and the README
connection-levels table remain ([§Prerequisites](#prerequisites)).

## Motivation

Two enrollment paths exist today and only one of them actually forwards:

- **`hyp join <url> <token>`** (LLP 0025) — unattended / MDM. Writes a
  `@hypaware/central` sink seed to the central-config layer, exchanges a
  bootstrap token, and forwards. Requires an out-of-band bootstrap token.
- **`hyp remote login`** (LLP 0033/0058/0061) — attended, human OIDC login. Attaches
  for queries; *opportunistically* arms forwarding **iff a sink already exists**.

The product intent — "log in, logs flow" — is served by neither on a fresh box: join
needs a distributed token, and login needs a pre-existing sink it never creates. The
server already mints the forwarding credential during login (server LLP 0020) and
already resolves the user's org from a claimed, verified email domain (server LLP
0017). The only missing link is on the client: nothing turns that credential into a
running sink.

## Context: what exists today

- **LLP 0061 seeds, never creates.** `seedLoginGateway`
  (`src/core/remote/gateway_seed.js`) walks the effective config, matches
  `@hypaware/central` sinks by URL **origin** to the login target, and pre-populates
  each match's `identity.json`. `seeded.length === 0` → the note. D2/D5 scoped the
  chunk to *"the persisted identity pre-populated"*; sink creation was explicitly
  left out.
- **`hyp join` already writes the exact sink block we need.** `runJoin` builds a
  seed `{ version: 2, plugins: [{name: '@hypaware/central'}], sinks: { central: {
  plugin: '@hypaware/central', config: { url, identity: { bootstrap_token } } } } }`,
  validates it, and writes it to the **central-seed file** under `config-control/`,
  never to the user-owned `hypaware-config.json` (LLP 0031 physical-layout; the #111
  augment-don't-destroy fix). This is the precedent to reuse — the only differences
  are the credential source (login-minted gateway vs. bootstrap token) and the
  trigger (attended login vs. seed).
- **The server owns the entitlement.** Server LLP 0017 Q2: a verified human's email
  domain maps to an org only when an admin has claimed and proven the domain
  (hand-onboarded today; self-serve DNS-TXT `_hypaware-challenge.<domain>` is a
  planned follow-up — server chunk 5). The org label is server-assigned, forge-proof
  (LLP 0014). Server LLP 0020 mints the gateway credential on that same authenticated
  login. So `session.gateway` present == "this org member may forward."

## Options considered

- **A. Status quo — print the note only.** Rejected: breaks the one-command
  promise; the note is a dead end that doesn't even name the fix.
- **B. Make the note actionable** (point at `hyp join`). Rejected as insufficient:
  still two commands and still requires a bootstrap token the attended user
  doesn't have.
- **C. Login auto-provisions the sink (chosen).** When the login response carries a
  gateway credential and no matching-origin `@hypaware/central` sink exists, write
  one — reusing join's seed shape and central-seed layer — then seed its identity
  (LLP 0061). One command, no token.
- **D. Server pushes the sink via central config after login.** Deferred: requires
  the daemon to already be an enrolled central-config poller (the join path we're
  trying to avoid). Login is attended and local; it should not depend on a running
  reconcile loop to become operational. C does not preclude D later.

## Connection levels and verbs

<a id="connection-levels"></a>
The frame D4 and D6 live in. The CLI has four connection levels, each with a
symmetric enter/exit pair, each verb severing exactly what its counterpart
established:

| Level | What it connects | Enter | Exit |
|---|---|---|---|
| **1. Client routing** (local) | a client (Claude/Codex) → the local gateway; controls *capture* | `hyp attach <client>` | `hyp detach <client>` |
| **2. Query session** (per-server) | *a human credential* → a server, for querying | `hyp remote login <t>` | `hyp remote logout <t>` *(gap — see Prerequisites)* |
| **3. Fleet enrollment** (machine) | *this machine* → an org's central server: forwarding, config pull, org-driven attach | `hyp join`, or an enrolling `login` (this doc) | `hyp leave` *(gap — see Prerequisites)* |
| **4. Service** (infrastructure) | the daemon → the OS | `hyp daemon install` | `hyp daemon uninstall` |

Rules that keep the ladder non-confusing:

- **Each level exits with its own verb.** No verb reaches across levels, with one
  deliberate exception: **`leave` cascades down, never up** — leaving reverses
  what the fleet did to the machine (org-driven attaches undo via the reconciler,
  LLP 0044) but does not log the human out (the query session is theirs, not the
  fleet's) and does not uninstall the daemon (local-only capture keeps working —
  local-first, LLP 0062 D1).
- **`login` is a level-2 verb that can create level-3 state** (when the org
  claimed the domain — D1). That asymmetry is the feature; the resolution is that
  however level 3 was *entered* (join or login), the *exit* is always and only
  `hyp leave`. A `logout` after an enrolling login ends the query session while
  the machine keeps forwarding — correct, the org owns that connection now (same
  as an MDM join), and precisely why the D3 pre-auth notice exists.

**Once implemented, this table and the rules above go in the README** — it is the
user-facing mental model, not just design rationale.

## Decisions

### D1: The gateway credential is the trigger, not a flag

<a id="d1"></a>
Auto-provisioning keys on `session.gateway` being present in the login response.
That field is the server asserting this authenticated identity's org is entitled to
forward (server LLP 0017 domain claim + LLP 0020 mint). No new client flag *enables*
forwarding — the server decides eligibility, the client honors it. A server without
login-gateway support returns no `gateway_*` fields (LLP 0061: "captures nothing and
login still completes"), so this whole path is inert and behavior is unchanged —
**backward compatible by construction**.

### D2: Provision exactly join's sink block — fully enabled, in the central-seed layer

<a id="d2"></a>
The auto-written block is **the same seed `runJoin` writes** (`plugins: [{ name:
'@hypaware/central' }]` + the `central` sink), written to the **same central-seed
file** (`config-control/`, LLP 0031), differing only in the credential source: no
`identity.bootstrap_token` — the login-minted gateway seed (LLP 0061) is the
identity. Rationale for the layer: this is **server-authored** config
(server-minted credential, server-owned org), so the central layer is the honest
home for it; it keeps the local layer untouched (#111 invariant); and a later real
central-config pull supersedes a seed cleanly rather than colliding with a user
edit.

**Fully enabled means the whole cascade, deliberately.** The central sink, once the
daemon materializes it, unconditionally starts the config-pull loop
(`central/index.js`, `@ref LLP 0025#config-pull-loop`). A pulled central config
that names a client adapter **auto-attaches** the client (LLP 0044, no prompt) and
**backfills** its history (LLP 0037, default-on). This is not a side effect to
mitigate — it is *how the product goal is met*: on a fresh box nothing is attached,
so a forward-only sink would forward nothing (the #126 silent gap, reincarnated in
the login lane). Login-provisioning the full sink makes `hyp remote login` deliver
capture **and** forward through machinery three Accepted decisions already specify.
A forward-only variant (a `config_pull` gate on the central plugin) was considered
and rejected: it adds a mode LLP 0025 doesn't have, creates a third half-enrolled
machine state, and fails the one-command goal anyway.

*Caveat (verified 2026-07-04):* the cascade currently fires only for
token-joined gateways — a login-origin gateway pulls `404` because config
resolution is token-derived, so completing the cascade for login enrollees
depends on the server-side per-org default config follow-up; see
[§login-config-pull](#login-config-pull) for the verification and the interim
behavior this doc binds.

*Tension resolved (layer):* `join` is unattended/MDM and central-seed is
unambiguously right for it. Login is **attended** — an argument exists that
anything a human triggers interactively belongs in the local layer. Counter, and
the deciding one: the human is not *authoring* this sink, they are *accepting a
server-granted* one; provenance, not who typed the command, picks the layer.

### D3: Default-on; consent is a pre-auth warning, never a prompt

<a id="d3"></a>
Enrollment is **default-on** and login never prompts `y/n`. The consent surface is
a **warning printed before the browser opens**: the user reads what a successful
login will do *before* they authenticate; completing the auth is the accepting
act, and aborting (Ctrl-C, or simply not finishing the browser flow) declines.
This sits inside the LLP 0036 §Consent doctrine (per-instance defaults, sized to
blast radius) as the attended counterpart of LLP 0044's join-implies-consent: here
the operator consented by claiming the domain (server LLP 0017) and the human
consents by authenticating *after being told*.

Mechanics:

1. **Pre-auth notice.** Before opening the browser, login prints a warning that a
   successful sign-in may enroll this machine in the org's fleet — forwarding
   captured logs to the server, applying org config (which can attach clients,
   LLP 0044), and installing the background service (D5). Phrased conditionally ("if your org has enabled forwarding…")
   because the client cannot know pre-auth whether the server will mint a gateway
   credential; suppressed when `--no-forward` is passed or when a matching-origin
   central sink already exists (already enrolled — the notice would be noise).
2. **Post-login announcement.** Provisioning prints exactly what it did —
   `provisioned '@hypaware/central' sink 'central' — forwarding logs to <url>` —
   replacing today's dead-end note (LLP 0061 D4 never-silent, upheld).
3. **`hyp remote login --no-forward`** logs in for queries only: the gateway
   credential is discarded unseeded and no sink is written. The flag keeps its
   LLP 0061-era name deliberately; because the name undersells its scope, the
   help text must carry the load — it declines *enrollment* (config pull, attach
   cascade, service install), not merely forwarding. The pre-auth notice copy is
   likewise load-bearing (it is the consent surface) and should be pinned
   verbatim by a test, as the dead-end note is today. Declining at login is *not joining*; it does
   not contradict LLP 0037's "no local opt-out" doctrine, which governs a machine
   that **is** enrolled overriding locked fleet policy. Post-enrollment, LLP
   0037/0044 rules apply unchanged.

Rejected: default-off + `--forward` (fails the one-command product goal);
first-login interactive confirm (a prompt in the one-command story, a TTY edge in
piped flows, and it second-guesses the consent the operator already gave at
domain-claim time — the pre-auth notice delivers the same informed-consent moment
without blocking).

An unclaimed or shared domain (gmail/outlook) maps to no org (server LLP 0017),
so no gateway credential is minted, D1 never fires, and none of this applies —
the domain whitelist is itself the gate.

### D4: One enrollment per machine; login to a different server is rejected

<a id="d4"></a>
A machine's server connection is **exclusive**. When the machine is already
connected to server A (a `@hypaware/central` sink targets A's origin) and the user
runs `hyp remote login` against a different origin B, the login is **rejected up
front** — before the browser opens, so no auth is wasted:

```
hyp remote login: this machine is connected to <A>
  disconnect first ('hyp leave'), then log in to the new server
```

Switching servers is two deliberate acts — disconnect, then login — never one
command; there is no `--switch` escape hatch. This extends LLP 0061's
origin-scoping ("a login against server A cannot disturb the forwarder for server
B") from *don't touch the other forwarder* to *don't create a second one*: the
central-seed file is a single slot (LLP 0031), and two config-pull loops would
mean two operators reconciling one machine (two LLP 0044 attach reconcilers
fighting over one `~/.claude/settings.json`).

**The gate is total: at most one server per machine.** While connected to A,
`hyp remote login` against any other origin is rejected — **including with
`--no-forward`**, even though a `--no-forward` login could not technically
re-enroll. The rationale is deliberately *not* just re-enrollment risk; it is
model simplicity: one machine, one server, one mental model (review round 1,
concern 1, resolved 2026-07-04). A rule with a "query-only logins are exempt"
carve-out is a rule users have to think about; this one they don't.

**Scope: the machine's connection, not the session store.** A machine that is
*not* connected (no domain claim matched, or `--no-forward` on a first login)
still holds multiple per-target OIDC sessions freely — LLP 0033 §credentials /
LLP 0058 / LLP 0062 are unchanged for the query-only population. While connected
to A, querying B via a **static token** (`--token-file`,
`HYP_REMOTE_TOKEN_<NAME>`) remains possible: those paths mint no gateway
credential, cannot disturb the enrollment, and env access is unenforceable
regardless — they are the documented escape for the enrolled-consultant case,
not a hole in the gate. LLP 0033 §credentials gains one sentence pointing here;
no supersede.

**The gate is re-checked at seed time.** The pre-auth check is advisory (fail
fast, no wasted auth); an authoritative check re-runs just before the seed
write, and "a sink for another origin appeared since the pre-auth check" is a
D4 rejection at seed time, so two concurrent first logins against different
servers cannot both provision — the loser is told the machine connected
elsewhere mid-flight. *As shipped (2026-07-04): this re-check is a plain
re-resolve of the effective config immediately before the write, not yet taken
under the cross-process credentials lock (LLP 0065). It closes the common race;
holding the recheck+write under that lock to close the last interleaving is a
named follow-up.*

Naming falls out: the provisioned sink is always join's instance name `central`;
no origin-suffixed second sink exists. Idempotency: same-origin re-login finds the
sink present and falls through to plain identity re-seeding (LLP 0061, idempotent
via server gateway dedup). `hyp join` keeps its current overwrite semantics —
operator re-pointing via join is deliberate MDM context; the guard is for the
attended accidental case.

### D5: An enrolling login finishes the way join finishes — daemon install included

<a id="d5"></a>
Writing a sink block forwards nothing until a daemon materializes it, so a login
that **provisions** (this login created the seed) completes with **join parity**:

- **No daemon installed** → run the same daemon install `runJoin` runs
  (`runDaemonInstall`), honoring a `--no-daemon` opt-out that prints the
  finish-by-hand command, exactly as join's does.
- **Daemon already installed/running** → do not reinstall; trigger the
  restart/staged reconcile so the new sink materializes without manual action.
- **Re-login (sink already present)** → touch neither the service nor the config;
  fall through to plain identity re-seeding (LLP 0061, D4 idempotency).

An enrolling login also inherits join's #139 fix (`resetCentralLayerToSeed`): a
re-enrollment after a broken identity must supersede a stale active config slot so
the fresh credential is honored rather than silently shadowed
(`@ref LLP 0031#physical-layout`).

Consequence stated plainly: `hyp remote login` on a fresh box now writes a
launchd/systemd user service. That is further than any previous login behavior; it
is exactly what `join` does, D6 makes them siblings, and the D3 pre-auth notice
names it before the user authenticates — no new consent surface is needed.

### D6: Login is attended enrollment — join's sibling, not a weaker mode

<a id="d6"></a>
With D2, the two paths produce the **same enrolled machine**; they differ only in
who proves what to whom:

- **`hyp join`** — unattended / zero-touch / MDM. The *machine* presents a
  server-distributed bootstrap token; no human present.
- **`hyp remote login`** — attended. The *human* proves identity via OIDC; org
  resolves from the claimed domain (server LLP 0017); the gateway credential
  replaces the bootstrap token (LLP 0061's original thesis, now completed).

Neither is deprecated, and there is no third state between "not enrolled" and
"enrolled": a logged-in-with-gateway machine is a fleet machine, subject to the
same central config, the same LLP 0044 attach, the same LLP 0037 backfill, and the
same `hyp leave` reversal.

## Consequences

- **One command forwards** for a member of a domain-claimed org — the stated goal.
- **Login's authority widens.** Before this, `hyp remote login` only *read* config
  and wrote credential stores; it now *writes a config block*. This is the notable
  change and the main thing review should scrutinize (see D2/D3).
- **The dead-end note disappears**, replaced by a positive "provisioned … forwarding
  to …" line (D3).
- **Backward compatible.** No gateway credential → no provisioning → today's
  behavior (D1).
- **The forward path itself is unchanged.** This adds a config writer on the login
  side; `IdentityClient`, refresh, the 401 loop, and materialization are reused
  verbatim (as in LLP 0061).
- **BYOD, stated plainly.** A *personal* machine enrolls into an org's fleet
  because a claimed email domain matched — and post-enrollment, LLP 0037 backfill
  is default-on with no local opt-out, so pre-existing local history can ship to
  the org's server. The pre-auth notice (D3) is the one moment the user can
  decline, which is why its copy is load-bearing and must name backfill
  explicitly. A tenant that wants login-enrollment off for unmanaged machines is
  a server-side policy concern (an org `login_enrollment` knob would surface to
  this client as the absence of `gateway_*` — zero client change); recorded here
  as a named follow-up, not silently emergent.
- **A dead credential must not be a silent state.** If the login-minted gateway
  is revoked or refresh permanently fails (server LLP 0020 D5), the machine is
  locally enrolled but cannot forward or pull. `hyp status` must distinguish
  "enrolled, forwarding" from "enrolled, credential dead — re-run `hyp remote
  login`", or the #126 silent gap returns in a new costume.

## Prerequisites

<a id="prerequisites"></a>
Two exit verbs referenced by this design do not exist yet; the first is a hard
prerequisite (D4's rejection message names it), the second a sibling gap made
conspicuous by the ladder:

- **Minimal `hyp leave`** *(implemented 2026-07-04: `runLeave`,
  `src/core/cli/core_commands.js`)*. The vocabulary is already load-bearing in LLP 0041/0044/0045.
  Scope: (1) remove the central seed /
  supersede the active central-config slot (inverse of join's write, reusing the
  #139 reset machinery); (2) run the action reconciler's `reverse()` pass so
  centrally-attached clients detach and prior settings restore (the LLP 0044
  contract — its first exercise; the CLI routes through the same single core
  disk undo as `hyp detach`, so manual attaches — which carry no marker — stay);
  (3) stop the central sink (daemon service restart, never uninstall) and drop
  the forward identity (`identity.json`). It does **not** touch the query
  session store, the local layer, or the daemon service (ladder rules above).
  **Best-effort and idempotent (self-healing).** Every step force-deletes what
  it can and tolerates already-gone state, so a plain re-run of `hyp leave`
  finishes whatever a partial failure left behind — no resume bookkeeping.
  "Connected" is central layer present **or** an org-attach marker still on
  disk (the marker is its own unfinished-teardown signal), so a leave that
  died mid-reversal still has work on re-run rather than short-circuiting to
  "not connected". One corollary: an org attach whose plugin is no longer
  installed cannot be reversed, so leave **drops its marker** (a lingering
  `done` marker would block the next join's re-attach, #217) and prints a
  manual-revert hint rather than wedging.
- **`hyp remote logout <target>`.** The level-2 exit: drop the stored credential
  for one target without removing the target entry (`remote remove` is the
  heavier target-deletion verb). Not blocking for this doc, but the ladder is
  incomplete without it.

## Out of scope

- **Domain→org mapping and domain claiming** (server LLP 0017; self-serve DNS-TXT is
  server chunk 5). This doc *consumes* the entitlement signal; it does not define who
  is entitled.
- **A global forwarding-consent policy / fleet-level forward toggle.** D3 gives a
  per-login `--no-forward`; a broader policy model is a later concern.
- **Zero-touch device-cert enrollment** (server LLP 0017 Q9) — remains the join lane.

## Config pull for login-enrolled machines (review concern 2, resolved 2026-07-04)

<a id="login-config-pull"></a>
Verified against both repos; the clobber scenario is **impossible** and the doc's
cascade claim needed the opposite correction.

- **No clobber, three independent guards.** (1) A login-minted gateway has
  `tokenId: ''` (server `identity/store.js` `enrollLoginGateway`), and
  `GET /v1/config` resolution is strictly token-derived, so a login-origin
  gateway pulls **`404 config_not_registered`** — the server never serves a
  document that could replace the seed (server `routes-ingest.js`,
  `@ref` server LLP 0001#config-pull-404). (2) The central-sink guard is
  implemented (server `configs/save-pipeline.js`, server LLP
  0009#central-sink-guard): no servable config can lack a central sink targeting
  the server. (3) The client pull loop treats 404 as a polite-backoff
  **legitimate steady state** (`central/src/config_client.js`,
  `LEGACY_404_BACKOFF_SECONDS`); the seed stays and forwarding continues.
  Identity cannot wedge either: `identity.json` is state, not config —
  `acquire()` prefers the persisted identity over any configured
  `bootstrap_token`.
- **But the D2 cascade does not fire for login enrollees today.** 404-forever
  means no org config is ever pulled, so the LLP 0044 attach cascade never runs;
  a fresh login-enrolled box forwards but captures nothing until someone runs
  `hyp attach <client>` by hand. D2's cascade rationale is therefore
  **conditional on a server-side follow-up**:
- **Server follow-up (out of tree): org default config, implicit when
  unambiguous — drafted as server LLP 0043
  (`../hypaware-server/llp/0043-org-default-config.decision.md`).** Resolution
  becomes gateway → enrolling token → config, **else
  `gateway.org` → org default config**, else 404. The default is
  convention-first: **exactly one config in the org's scope → it is the
  default, no admin step**; multiple configs → explicit designation required
  (never guess — "newest wins" would let saving an experimental config silently
  retarget every login-enrolled machine); zero configs → 404, today's minimal
  enrollment. Prerequisite discovered in verification: `ConfigRecord` has no
  org field (flat global namespace), so multi-tenant servers need org-scoped
  configs before *any* default rule — otherwise an implicit default would serve
  one tenant's config to another tenant's login users. Client change: zero —
  the 200 path is the existing apply engine, the 404 path is the existing
  steady state. This keeps the operator in the LLP 0044 consent loop (the
  default config is authored and central-sink-guarded), and makes the BYOD knob
  emergent: an org that publishes no config gets *minimal* login enrollment —
  forwarding only, no dotfile touches. Rejected alternatives: inject-at-serve
  (violates server LLP 0009's authored-config philosophy), client-side
  auto-attach fallback (removes the operator from the consent loop),
  config-bound-at-mint (static; strands early enrollees).
- **Interim client behavior (this doc, binding).** Until the server follow-up
  ships — and permanently, for orgs that never publish a default config — an
  enrolling login that leaves the machine with no attached client prints one
  hint: `nothing is captured yet — run 'hyp attach <client>' to start`. Never
  silent (LLP 0061 D4), and `hyp status` shows "enrolled; no org config
  published" for the 404 steady state.
  - **Note (2026-07-06): the server follow-up shipped, so the interim hint was
    replaced by waiting on the real reconcile.** Org default config (server LLP
    0043) is live and deployed, which makes auto-attach (LLP 0044) the primary
    path for orgs that publish a config. The old hint printed unconditionally
    and synchronously, *before* the daemon's first config pull, so it asserted a
    stale "nothing captured" as terminal and pushed a manual `hyp attach` the
    daemon was about to make unnecessary. `runRemoteLogin` now installs the
    daemon, then **waits for its first reconcile** (polling the on-disk attach
    markers, a cross-process read) and reports the
    ground truth: `capturing <clients>` when a client attaches, or, on timeout
    (no org config, or a slow pull), `no clients attached yet - check 'hyp
    status', ...`. Still never silent (LLP 0061 D4); the manual `hyp attach`
    stays the escape hatch, not the headline. The interim text above stands as
    the record of what shipped before the follow-up; the code is current.

## Open questions

- ~~Does `hyp leave` best-effort revoke the server-side gateway row, or is
  teardown local-only?~~ **Resolved (2026-07-04, with the leave
  implementation): teardown is local-only.** The credential expires on its own,
  revocation is the operator's server-side act (server LLP 0020 D5), and a
  best-effort revoke would make `leave` depend on the very connection — and
  possibly the very credential — it is severing. Stated in `runLeave`'s doc
  comment so the next agent doesn't "helpfully" add the call.

Everything else — consent default, config layer, enablement scope, daemon
install, exclusivity, rejection scope (total gate, at most one server per
machine) — was resolved in the 2026-07-04 grilling session and review round 1,
captured as D1–D6 above. (Host-label interplay with LLP 0061 D6 resolved by
inspection: the label rides the token exchange, upstream of provisioning, so
0061 D6 applies unchanged.)

## References

- LLP 0061 (login-minted gateway credential on the client) — the seed-existing-sink
  predecessor this completes.
- LLP 0025 (remote config & join flow), LLP 0031 (config physical layout / central
  seed), LLP 0058 (remote targets, origin mapping), LLP 0033 (remote query attach),
  LLP 0041/0043 (central-config-driven client actions / reconciler).
- Server: LLP 0017 (multi-tenant OAuth, domain→org, DNS-TXT follow-up), LLP 0020
  (login-minted gateway; D7 client obligation).
- `src/core/cli/core_commands.js:3228` (`runJoin`, the sink-seed precedent),
  `src/core/remote/gateway_seed.js` (`seedLoginGateway`),
  `src/core/cli/remote_commands.js` (login flow, the seeded/note branch).
