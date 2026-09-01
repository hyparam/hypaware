# LLP 0188: On an enrolled machine, sources sync by default, with a per-client opt-out

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, Usage-Policy, Config, Onboarding, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-04
**Related:** LLP 0132 (superseded), LLP 0070 (export seam), LLP 0031 (layered config), LLP 0100/0101 (first-sync review window), LLP 0135 (export-seam design, extended), LLP 0120 (hermes rows), LLP 0147 (CLI-backend attribution), LLP 0175 (live-capture misattribution, open)
**Extended-by:** [LLP 0190](./0190-wizard-defaults-gate.decision.md) (§never-silent below: the step's prompt shape changes - a defaults gate first, the menu's checkboxes now mark what syncs rather than what stays local, and locked sources appear read-only instead of not at all; the policy, store, and seam enforcement here are unchanged); [LLP 0345](./0345-explicit-client-history-replay.decision.md) (`#no-retroactive-ship`: the standing policy flip remains future-only, and an explicit consent-gated sync mode replays retained history)

> Supersedes [LLP 0132](./0132-managed-local-additions-local-only.decision.md).
> The org-visibility default flips: sources the user adds beside the org's
> config now sync to the org server unless the user opts them out, and the
> per-item toggle LLP 0132 rejected becomes the mechanism. Central-config
> sources remain always-sync and cannot be opted out.

## Context {#context}

LLP 0132 decided that on a machine with a central layer, locally added
sources (OpenClaw, Hermes, anything the org's fleet config does not name)
are collected but never forwarded, with no per-item toggle. Operating
experience reversed the priority: fleets want the server to see the whole
picture of AI usage by default, including agents the org has not gotten
around to naming, and the machine owner, not the absence of an org config
entry, should be the one deciding what stays local. The server side needs
no change: its ingest path is deliberately policy-free (it accepts any
registered dataset from an authenticated gateway), so which rows ship has
always been a capture-side decision.

## Decision {#decision}

<a id="rule"></a>**Everything configured syncs by default.** On an
enrolled machine (one with a central layer), every configured source
forwards to the org server, whether the source came from the central
layer or the local layer. The org's config is the floor of what syncs,
not the ceiling.

<a id="opt-out"></a>**Per-client opt-out, enforced at the seam.** A
machine-local store, `<state>/usage-policy/client-sync.json`
(`{ version: 1, entries: [{ source, class: 'local-only' }] }`, keyed by
picker source id), lists sources the user keeps local. The LLP 0070/0132
export seam withholds their rows; the wizard step and CLI only edit the
store. As with directory classes, a UI marking is not a policy: the seam,
not the picker, enforces. The withheld set is read lazily (TTL-cached) so
an opt-out takes effect in a running daemon without restart. A corrupt
store fails the export closed, exactly as the directory list does.

> **Extended-by: [LLP 0346](./0346-aliased-client-optout-enforced-by-entrypoint.issue.md).**
> One shipped picker id, `claude-desktop`, stamps another client's
> `client_name` by design (LLP 0133 #attribution), so its store entry could
> never match a row at the seam. LLP 0346 adds an entrypoint-keyed
> enforcement path for that case; the store, its keying, and the rules
> above are unchanged.

<a id="locked"></a>**Central sources always sync.** A source classified
`'central'` (present in the org's config document) cannot be opted out:
the CLI refuses to write such an entry, and any stale entry for a source
that later becomes central is inert at resolver build, never an error.
The org's authored config remains the one part of the picture the machine
owner cannot subtract from.

<a id="migration"></a>**Upgrade materializes the old withheld set.**
Pre-0188 the withheld set was derived, not stored: every picker id
classified `'local'` on an enrolled machine. On the first boot where a
central layer exists and `client-sync.json` does not, that derived set is
written into the store, so data the machine was told "stays on this
machine" never starts shipping because of an upgrade. Store absence is
the migration marker; enrollment under this decision therefore seeds an
empty store before it writes the central seed, marking the machine as
new-era so fresh picks default to sync. If seeding fails, the failure
direction is under-sync (the next boot migrates picks into opt-outs),
which is the safe direction.

<a id="never-silent"></a>**Never a silent state.** The wizard's enrolled
runs (the team pathway, and any run on a managed machine) gain a
sync-scope step after the picker ("All of these will sync to your
server - check any to keep local-only"; locked sources do not appear).
`hyp status` keeps its syncing/local-only split, now driven by the store.
`hyp sync`'s pre-send plan names opted-out clients alongside local-only
directories. `hyp policy client` shows and edits the store after
onboarding.

The returning-gate consequence of this flip - a managed machine's re-run
has the same real choices a solo machine's does, so the gate's scoped
re-entry and the `scoped` pathway are retired in favor of one
`Reconfigure` - is settled by its own decision,
[LLP 0182](./0182-one-reconfigure-for-every-machine.decision.md). Here
`managed` gates the sync-scope step: it runs on every enrolled run,
whichever pathway the fork picks.

<a id="no-retroactive-ship"></a>**Opting back in ships only future
rows.** Withholding is drop-but-advance (LLP 0070#incremental): a
withheld row moves the sink watermark past itself. Flipping a client from
local-only to sync therefore does not upload its history; rows dropped
while opted out are gone from the forward stream. The CLI states this
when flipping, so it reads as a property, not a bug.

<a id="enforcement-scope"></a>**Enforcement scope is attribution-bound.**
Per-row withholding requires the dataset's declared `attribution_column`
(LLP 0135#export-seam); today only `ai_gateway_messages` declares one. A
dataset with no attribution column whose contributing sources are all
opted out is withheld wholesale (dataset-scoped withholding), which
covers single-owner datasets such as the otel signals. Residuals, stated
rather than hidden: rows derived from an opted-out client's messages into
multi-source datasets without attribution (context-graph nodes and edges)
still sync; OpenClaw turns delegated to the claude/codex CLI backends are
attributed to those clients by design (LLP 0147) and sync as such; and
live-capture misattribution (LLP 0175) makes an opt-out only as good as
the `client_name` on the row.

> **Extended-by: [LLP 0192](./0192-unattributed-rows-escape-optout.issue.md).**
> The `client_name` residual is systematic for the raw picker rows, not
> incidental: a null-attribution row falls between both rules above and
> always ships. LLP 0192 adds an interim fail-closed seam rule for
> unattributed rows and defers the capture-side attribution fix.

Rejected: keeping LLP 0132's local-only default with an opt-in toggle.
The fleets asking for this change want coverage of new agents without a
config chase; an opt-in default recreates the chase. The BYOD
volunteer-data concern LLP 0132 cited is now carried by the first-sync
review window (LLP 0100/0101), the sync-scope step, and the standing
`hyp policy client` control, all of which act before or between exports.

## Consequences {#consequences}

- "What does my org see" is again one sentence: everything this machine
  captures, minus directories and clients you keep local.
- LLP 0132's warning stands: walking back from a permissive default takes
  data you cannot unship. The migration rule exists so the walk *to* the
  permissive default ships nothing that was withheld without the user
  acting.
- The wizard's enrolled runs gain a step; the picker's "stays on this
  machine" annotation is retired as no longer true. The returning gate's
  own reshaping is LLP 0182's.
- `hyp status`'s clientSync split widens from attach-probed clients to
  all configured picker sources, so a hermes opt-out is visible.
- A join that times out waiting for the org config still shows the
  sync-scope step over all picked sources; entries for sources that later
  classify central are inert per {#locked}.

## References

- LLP 0132, LLP 0070, LLP 0031, LLP 0100, LLP 0101, LLP 0135, LLP 0120,
  LLP 0147, LLP 0175
- `src/core/usage-policy/client_sync.js` (store),
  `src/core/runtime/source_withhold.js` (resolver build + migration),
  `src/core/cache/source-withhold.js` and `src/core/cache/storage.js`
  (seam), `src/core/cli/wizard/sync_scope.js` (wizard step),
  `src/core/commands/policy.js` (`hyp policy client`),
  `src/core/commands/central.js` (enrollment seeding)
