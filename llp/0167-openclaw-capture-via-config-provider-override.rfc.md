# LLP 0167: OpenClaw capture via config provider override

**Type:** RFC
**Status:** Accepted
**Systems:** Plugins, Gateway, Config, Sources
**Author:** Phil / Claude
**Date:** 2026-07-31
**Related:** LLP 0109, LLP 0143, LLP 0144, LLP 0145, LLP 0146, LLP 0148, LLP 0149, LLP 0152, LLP 0157, LLP 0161, LLP 0162; issues #539, #543, #544
**Spawned:** LLP 0168 (override replaces steering), LLP 0169 (attach surface returns), LLP 0170 (scheduled sweep), LLP 0171 (requirements spec), accepted 2026-07-31

> Proposal: replace the OpenClaw steering plugin with two lanes that need
> nothing installed on the OpenClaw side. **Lane A (live wire)**:
> `hyp attach --client openclaw` writes a `baseUrl` override for the
> `anthropic` and `openai` providers in `~/.openclaw/openclaw.json`,
> pointing them at the local AI gateway and carrying the
> `x-hypaware-upstream` header as a static config value. **Lane B
> (transcript sweep)**: the existing session-file backfill runs on a
> 5-minute schedule, so every OpenClaw turn on every provider is captured
> at transcript fidelity, and `part_id` dedupe nets the overlap with lane
> A to zero. The steering plugin package and everything that exists only
> to serve it (credential borrowing, the wire-parity mirror, the live
> warning ledger) are deleted, roughly 2,100 lines. The gateway,
> projector, settlement, and backfill projection are unchanged.

## Summary {#summary}

OpenClaw supports a per-provider config override: an explicit
`models.providers.<id>` entry merges over the built-in catalog entry,
including `baseUrl` and `headers`
(`openclaw` repo, `src/agents/models-config.plan.ts`
`resolveProvidersFromConfig` / `mergeProviders`, explicit wins;
`src/config/types.models.ts` `ModelProviderConfig` carries
`baseUrl` and `headers`). Overriding `anthropic` and `openai` steers every
model ref on those providers, primary, fallbacks, per-agent overrides, the
auxiliary model slots, and runtime `/model` switches within the provider,
because they all resolve through the same provider entry.

That is the same two-provider coverage the steering plugin delivers
(LLP 0144 restricts steering to the canonical vendors anyway), obtained
through a documented config seam instead of an OpenClaw-side npm package
that is opt-in and not yet published.

## Motivation {#motivation}

- **Distribution.** The steering plugin only works where someone ran
  `openclaw plugins install`. It is not on npm. Most installs will never
  have it, so the live lane of LLP 0157's coverage statement is
  aspirational on a typical machine. A config write ships with
  `hyp attach` and needs nothing from the user's side.
- **This option was never considered.** LLP 0152 rejected "widen the
  settings-file edit", meaning rewriting every `provider/model` ref, which
  is unbounded and goes stale per ref. A per-provider `baseUrl` override
  was not among its options. It does not share the fatal flaw: it steers at
  the provider level, so refs never need rewriting and new refs on an
  overridden provider are covered from birth.
- **Two whole decision surfaces become unnecessary.** The shadow providers
  had no credentials and no vendor-specific header shaping, so LLP 0145
  (credential borrowing) and LLP 0148 (the `wrapStreamFn` wire-parity
  mirror) exist to reconstruct what the real provider already does. With
  the real provider overridden, its own auth (API key or pasted OAuth
  setup-token) and its own header shaping apply natively. The mirror was
  the most drift-prone code in the plugin; it is deleted, not ported.
- **Attach state becomes observable again.** A config entry is a probeable
  artifact, so `hyp status` can report OpenClaw attach state truthfully,
  resolving the misleading permanent `attach openclaw [pending]` (#544).

## Design {#design}

### The override entries {#override-entries}

Attach writes (or merges into) two entries in `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "http://127.0.0.1:18521",
        "headers": { "x-hypaware-upstream": "anthropic" },
        "models": []
      },
      "openai": {
        "baseUrl": "http://127.0.0.1:18521/v1",
        "headers": { "x-hypaware-upstream": "openai" },
        "models": []
      }
    }
  }
}
```

(Shape verified live; see the results under {#verify}. The gateway port
is the fixed default of LLP 0114. `models: []` is mandatory: OpenClaw's
config schema types `models` as a required array and hard-refuses CLI
commands on a schema-invalid config; an empty array passes validation
and does not empty the built-in catalog. The `/v1` on the `openai`
entry is also mandatory: the OpenAI client appends `/responses` or
`/chat/completions` to `baseUrl`, so a bare origin would produce paths
outside the gateway's `/v1` prefix, while the Anthropic client appends
`/v1/messages` itself and wants the bare origin.)

The static `x-hypaware-upstream` header is the load-bearing trick: it is
the same header the steering plugin attached per request, so the gateway's
upstream precedence rung and the projector's shape/attribution gate
(`projector.js`, LLP 0161#upstream-presets and #projector-shape) keep
working byte-for-byte. **No gateway or projector change is part of this
proposal.**

### Attach, detach, undo {#attach-detach}

- **Attach is refuse + create-only.** If the user already declares
  `models.providers.anthropic` or `.openai`, attach refuses with an
  explanation: those keys are purely user-authored (verified: no OpenClaw
  code writes them; a default install has none), so their presence means
  the user deliberately routed that provider somewhere, and silently
  rerouting a deliberate override is the surprise this design family
  refuses to allow. Otherwise attach creates the two entries whole.
  Detach deletes an entry only when its `baseUrl` is the gateway's; a
  present-but-not-ours or mangled entry is backed up, never discarded
  (LLP 0163 precedent). Create-only means there is no prior state to
  restore, so no undo record exists anywhere: deletion is the whole undo.
- **The marker is the entry itself.** The `x-hypaware-upstream` header
  inside the created entry is the probeable marker. The manifest regains
  `contributes.client.attach_probe` in the `json_path` format, and core
  restores the `json_path` branches #510 deleted
  (`src/core/config/client_detach_disk.js`, `src/core/daemon/status.js`),
  reversing that half of LLP 0143. A plain top-level `json` marker key is
  NOT usable: OpenClaw's config is strictly validated and an unknown
  top-level key stops its gateway from starting, the verified LLP 0109
  finding that motivated `json_path` in the first place.
- **Attach-on-join returns, full symmetry** (settled at grill,
  2026-07-31): the plugin registers the runtime clients adapter so the
  LLP 0044 loop covers OpenClaw exactly as it covers Claude/Codex,
  governed by the already-declared `attach.on_join` policy. A
  refuse-on-existing hit during join surfaces as a warning and never
  fails the join.
- **Detach rewrites the per-agent caches; they do not self-heal**
  (verified live, {#verify} item 3). Once a provider entry has been
  written into `~/.openclaw/agents/<id>/agent/models.json`, removing the
  config entry does not remove it: the models.json plan runs in `merge`
  mode and carries every existing cache provider forward wholesale
  (`mergeWithExistingProviderSecrets` in
  `src/agents/models-config.merge.ts`), so the gateway URL survives
  regeneration indefinitely and remains live for routing (a stale entry
  kept steering turns in the live test). Detach must delete the entries
  it wrote from every agent's `models.json`, not just the default
  agent's; deleting the provider key from the cache file is sufficient
  and verified not to resurrect on the next regeneration.
- **Attach and detach print a restart instruction.** On the installed
  OpenClaw (2026.3.13), a running gateway does not apply
  `models.providers` changes to subsequent turns; turns kept using the
  old `baseUrl` until restart ({#verify} item 4). Attach and detach must
  end with "restart the OpenClaw gateway (`openclaw gateway restart`)
  to apply".

### The transcript sweep lane {#sweep-lane}

Settled at grill (2026-07-31): the session-file backfill provider runs
on a daemon schedule, **every 5 minutes** by default, tunable in the
plugin's existing `backfill` config section. The daemon already runs
cron-matched periodic work (the sink driver,
`src/core/sinks/driver.js`), so this is scheduling an existing job, not
a new primitive. Re-runs are cheap no-ops through the existing `part_id`
dedupe.

The sweep is what makes "lane A is not recording" a self-healing state
rather than a detectable one. It silently covers, with no mode switch
and no detection logic:

- machines never attached (or where refuse-on-existing fired);
- the restart-pending gap ({#verify-results} item 4): override written,
  `openclaw gateway restart` not yet run, turns flowing direct;
- **every provider outside the big two**: the LLP 0146 families
  (Bedrock, Vertex, Google, per-account-URL gateways), ollama, and any
  future provider all land in the session file identically, so they are
  captured at transcript fidelity. The LLP 0146 deferral list stops
  describing a coverage hole and starts describing only which lane
  serves a provider;
- pre-attach history and any missed window (backfill's original job).

When both lanes capture a turn, flush-time settlement upgrades the live
row to the file's native message id, the sweep's twin lands on the same
`part_id`, and dedupe resolves it to zero writes: the wire-fidelity row
survives. This is why the settlement/match-key machinery is **kept**,
not deleted; it is the hinge the hybrid turns on.

**Settlement race and quiesce window.** A sweep that imports a turn
before the live row's settlement has flushed would land the native id
first and collide instead of deduping. The sweep therefore skips
session files whose mtime is within a quiesce window (default: the
settlement flush interval plus margin). The cost is nothing: a
recently-active session is exactly the one lane A is capturing in real
time, and on unattached machines there is no live twin to race.

The live pass-through warnings (LLP 0149) die with the plugin, and no
replacement measurement is needed (settled at grill, 2026-07-31): with
the sweep, essentially nothing escapes, and what each lane covers is
clear from config inspection alone. The backfill's `excluded_backend`
events remain, but as the LLP 0147 sibling-territory boundary marker
(claude-cli / codex turns belong to the transcript adapters), not as a
coverage ledger.

The coverage statement becomes: **every OpenClaw turn is captured at
least at transcript fidelity within the sweep interval; `anthropic/*`
and `openai/*` turns are additionally captured live at wire fidelity
when attached.**

### Deletion inventory {#deletion-inventory}

The cleanup is part of the change, not a follow-up. In the same change
set:

- **Delete the `openclaw-steering-plugin/` package** entirely: `src/`
  (`steering.js`, `runtime_auth.js`, `wire_parity.js`,
  `warning_ledger.js`, `gateway_endpoint.js`, `index.js`, the `.d.ts`
  files), `test/`, `openclaw.plugin.json`, `package.json`. 2,080 lines.
- **Delete `test/plugins/openclaw-steering-plugin.test.js`** (the suite
  wrapper, 24 lines).
- **Rewrite `docs/ACCEPTANCE.md` `openclaw_capture`**: the
  `openclaw plugins install --link` / `plugins enable` steps become
  `hyp attach --client openclaw` plus a config-content check; the
  "shadow providers registered and steering" assertion becomes "override
  entries present and turns route through the gateway". A sweep step is
  added: a turn on a non-overridden provider must land via the scheduled
  sweep within the interval, with zero duplicate rows for a turn both
  lanes captured.
- **Rewrite the picker and manifest copy** in
  `hypaware-core/plugins-workspace/openclaw/hypaware.plugin.json`: no
  more "install the @hypaware/openclaw-steering-plugin package";
  see {#onboarding}.
- **Corpus updates** (spawn shape settled at grill, 2026-07-31;
  spawned on acceptance, same day): **LLP 0168** (config override
  replaces plugin steering; supersedes LLP 0152, moots LLP 0145 and
  LLP 0148), **LLP 0169** (the attach surface returns; supersedes
  LLP 0143: `json_path` revival, refuse + create-only, cache rewrite
  on detach, attach-on-join symmetry), **LLP 0170** (the scheduled
  transcript sweep; the 5-minute lane, the quiesce window, retires
  LLP 0149's ledger), and **LLP 0171** (the R-numbered requirements
  spec replacing 0157's dead half, the role 0157 played for #510).
  Each superseded doc carries its forward ref; LLP 0157/0161/0162
  carry `Extended-by` notes. LLP 0144's shape/canonical-vendor analysis and
  LLP 0146's deferral list carry over unchanged as live-lane
  rationale.
- **Spec 0157 requirement disposition**, so the amendment is
  requirement-precise rather than section-vague: R1-R6 die with the
  steering plugin (they specify its providers, steering, auth, mirror,
  pass-through, and header plumbing; the header now arrives from config).
  R7 is reversed outright (an `attach_probe` returns and core regains
  `json_path`). R8, R9, R11, R14 survive untouched (projector shapes,
  shared reader, route-identity dedupe, settlement policy drop). R10
  survives untouched (backfill policy gate and CLI-backend exclusion).
  R12 survives with the acceptance procedure rewritten per this RFC.
  R13 is retired with the ledger: the sweep makes the coverage
  statement of {#sweep-lane} and no escaped-traffic measurement is
  maintained.
- **Keep, unchanged**: everything under
  `hypaware-core/plugins-workspace/openclaw/src/` (projector including
  the header gate, settlement, match key, session-file reader, backfill,
  config), and the gateway presets with their `x-hypaware-upstream`
  rungs. Issue #543's reader fix proceeds independently of this RFC.

Net effect: roughly 2,100 lines deleted. The additions are one
create-only settings-write module (no undo record; deletion is the
undo, {#attach-detach}) plus the cache rewrite on detach, and the
5-minute schedule with its quiesce window around the existing backfill
provider ({#sweep-lane}); no new capture lane is implemented.

### Onboarding copy {#onboarding}

Two picker line items change:

- **Claude**: state plainly that it captures anything that runs the
  Claude Code CLI / Claude Agent SDK, and name the OpenClaw case
  explicitly: an OpenClaw configured with a `claude-cli/<model>` backend
  (the default on a subscription machine) is captured here, as `claude`,
  with no OpenClaw-side setup.
- **OpenClaw**: enumerates what the adapter collects, and states it in
  two clear tiers: ALL OpenClaw conversations are captured from the
  local session transcripts (every provider, within the sweep
  interval), and `anthropic/<model>` and `openai/<model>` turns are
  additionally captured live at wire fidelity through the gateway via
  the config override that attach writes.

## Non-goals and future lanes {#future}

- Overriding any provider beyond `anthropic` and `openai`. When HypAware
  adds gateway support for another provider family, or a user installs
  an OpenClaw provider plugin, the follow-up is a prompt to add that
  provider's override to the config. This is now purely a fidelity
  upgrade (live wire capture instead of the sweep's transcript capture),
  never a coverage gap: the sweep already records those providers'
  turns. The LLP 0146 deferrals stand unchanged as live-lane deferrals.
- An `fs.watch`-based live tail of the session files, as a latency
  upgrade behind the same LLP 0158 reader, if the 5-minute sweep
  interval ever matters. Out of scope now; the repo has no watcher
  primitive and the sweep needs none.
- The `*.trajectory.jsonl` files and the probe-session question, tracked
  in #543's adjacent-decisions list.
- A refuse-instead-of-capture-nothing mode (unchanged non-goal from
  LLP 0149/0157).
- Correlating an OpenClaw session with the child CLI session it spawned
  (unchanged non-goal, LLP 0147).

## Verify before build {#verify}

Load-bearing facts to confirm against a live OpenClaw before
implementation; each maps to an acceptance step:

1. **Merge keeps the catalog's models and auth.** An explicit
   `models.providers.anthropic` entry that sets only `baseUrl` and
   `headers` must inherit the built-in model list and auth modes rather
   than clobber them. (`ModelProviderConfig.models` is typed required;
   confirm a partial entry merges rather than replaces, and if a minimal
   `models: []` is needed, confirm that does not empty the catalog.)
2. **URL shape per provider.** What path the anthropic and openai clients
   append to `baseUrl` (`/v1/messages`, `/chat/completions`, with or
   without a `/v1` base segment), so the override URL lands on the
   gateway's path prefixes.
3. **Cache self-heal on detach.** Remove the override, regenerate, and
   confirm no agent `models.json` retains the gateway URL.
4. **Config reload semantics.** Whether a running OpenClaw picks up the
   override without a restart, and what attach should print if not
   (the acceptance procedure currently restarts the OpenClaw gateway
   after plugin changes).
5. **OAuth setup-token profiles ride through.** A pasted subscription
   token on the `anthropic` provider authenticates through the gateway
   unchanged (native shaping, no mirror).
6. **Interaction with a configured `openai` gateway upstream (#539).**
   With the header now arriving from config, confirm routing behavior
   when an operator declares their own `openai` upstream, and whether
   #539 is mooted, narrowed, or unchanged for OpenClaw traffic.

### Verification results (2026-07-31, live install) {#verify-results}

All six items were executed against the real install on this machine
(binary 2026.3.13, source checkout 2026.4.2 for code reading; note
`docs/ACCEPTANCE.md` floors `openclaw_capture` at 2026.4.24+, so the
acceptance run must re-confirm items 1, 3, and 4 on a current binary).
Method: config edits on the live `~/.openclaw/openclaw.json` (backed up
and restored), one-turn probes against a local logging listener, an
isolated `--profile` install for gateway tests, and a hermetic
workspace-build gateway (temp `HYP_HOME`, no daemon install) for
item 6.

1. **Merges, but only with `models: []` - CONFIRMED with a caveat.**
   A partial entry with only `baseUrl` + `headers` is rejected by
   schema validation (`models.providers.anthropic.models: Invalid
   input: expected array, received undefined`) and a schema-invalid
   config makes the CLI hard-refuse (`Config invalid ... Run: openclaw
   doctor --fix`). With `models: []` the entry validates, the full
   built-in anthropic catalog survives in `models list --all`, and auth
   still resolves. Attach MUST write `models: []`. Cosmetic side
   effect: a loopback `baseUrl` flips the models' `Local` column to
   `yes` in `openclaw models list`.
2. **URL shape is asymmetric - CONFIRMED live.** The anthropic client
   (official Anthropic SDK via pi-ai) appends `/v1/messages` to a
   bare-origin `baseUrl`; the openai client appends `/responses` (or
   `/chat/completions`) to a `baseUrl` that must already carry `/v1`.
   So: anthropic override = `http://127.0.0.1:18521`, openai override
   = `http://127.0.0.1:18521/v1`. Both observed at a local listener;
   the config-sourced `x-hypaware-upstream` header rode on every
   request. Failure-mode note: against an erroring endpoint the
   embedded runtime retried the turn about 12 times before surfacing
   the error.
3. **No self-heal - FALSIFIED, design amended.** See the amended
   {#attach-detach}: the cache carries stale entries forward
   indefinitely and they stay live for routing. Detach rewrites every
   agent's `models.json`.
4. **No pickup without restart - CONFIRMED (restart required).** With
   a running gateway, `models.providers` baseUrl changes were not
   applied to subsequent turns (tested with both file-replace and
   in-place writes; no reload event logged). The source checkout
   (2026.4.2) has a chokidar config reloader whose plan marks `models`
   as hot-reloadable, so newer binaries may pick it up, but attach must
   not rely on it: it prints the restart instruction
   ({#attach-detach}).
5. **Setup-token rides through - CONFIRMED.** The machine's
   `anthropic:default` auth profile (type `token`, a pasted
   subscription setup token) authenticated a turn against the
   overridden `baseUrl` natively: the request carried `authorization`
   plus `anthropic-beta` headers (names verified at the listener,
   values never logged) and the run log shows the profile applied.
   Native shaping, no mirror, exactly as {#motivation} argues.
6. **#539 is mooted for OpenClaw traffic - CONFIRMED hermetically.**
   Workspace-build gateway with an operator-configured `openai`
   upstream (no `match()`, so the steering rung is gone, the #539
   seam): an RFC-shaped turn (`/v1/responses`, `/v1/chat/completions`)
   still routes to the configured upstream by path prefix and the turn
   succeeds; the old steering-plugin shape (`/chat/completions`, bare
   origin) 404s with `no upstream matches path`, reproducing #539's
   failure mode. The header is stripped before the request leaves the
   gateway on the config-upstream route too, so nothing leaks to the
   operator's endpoint, and capture attribution is unaffected because
   the projector gate reads the header from the recorded inbound
   request. #539 remains open only as a steering-plugin-era concern;
   this design does not hit it, provided the `/v1` shape from
   {#override-entries}.

Incidental finding, evidence for the {#open-questions} stranded-attach
residual: this machine still carried a dead shadow-provider attach from
2026-07-24 (a `models.providers.hypaware` entry pointing at the
uninstalled gateway, plus the rewritten primary model ref). Because it
used string entries in `models`, it also made the whole config
schema-invalid, which hard-blocked `openclaw models list` wholesale.
The RFC's entries validate cleanly (`models: []`), so a stranded RFC
attach degrades to connection-refused turns only, not a bricked CLI
surface. The stale attach was undone during verification per its own
managed marker.

## Open questions {#open-questions}

- ~~Refuse or merge-with-undo on a pre-existing provider entry?~~
  Settled (grill, 2026-07-31): refuse + create-only; see
  {#attach-detach}.
- ~~Does `hyp leave` / uninstall need to force-detach OpenClaw?~~
  Settled (grill, 2026-07-31): no new machinery. `hyp leave` and manual
  detach both route through the one probe-driven core undo
  (`src/core/commands/clients.js`, LLP 0138#marker-undo), so a probed
  OpenClaw is covered by the shared path automatically. The residual, a
  user removing HypAware without ever detaching, strands a dead gateway
  URL and turns fail loudly at connection time; that exposure is
  identical to Claude's stranded attach block today and is accepted as
  the same class, not new hazard.

## References

- LLP 0152 (the mechanism this replaces), LLP 0143 (the no-attach posture
  this reverses), LLP 0145 / 0148 / 0149 (machinery mooted or re-laned)
- LLP 0144 (shape and canonical-vendor analysis, carried over), LLP 0146
  (deferrals, carried over), LLP 0157 / 0161 / 0162 (the shipped change
  set this amends)
- `openclaw` repo: `src/agents/models-config.plan.ts`,
  `src/agents/models-config.merge.ts`, `src/config/types.models.ts`
- Issues #539, #543, #544
