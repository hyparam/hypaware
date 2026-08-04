# LLP 0180: The wizard finale attaches OpenClaw

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Config
**Author:** Brendan / Claude
**Date:** 2026-08-03
**Related:** LLP 0177 (the issue this resolves), LLP 0169 (OpenClaw attach surface), LLP 0174 (manual-path sibling; its non-goal), LLP 0170 (sweep consent stance), LLP 0130 (manifest-sourced picker), LLP 0011 (init finale), LLP 0135 (wizard orchestration)

> Picking OpenClaw in `hyp init` enables the adapter and then drops it
> from the finale: no attach, no import, a `client_attach_missing` limbo
> (LLP 0177). The fix derives the finale's client list from what the
> picked rows' plugins contribute instead of a hardcoded pair, and keeps
> the backfill-consent question honest for a sweep-backed provider by
> replacing its question with a disclosure plus an immediate first import.

## Context {#context}

The finale's attach lane is already generic: it iterates `clientsPicked`,
resolves each client's adapter from the live gateway registry, and calls
`adapter.attach()`. OpenClaw's adapter registers into exactly that
registry (LLP 0169). The defect is upstream: `clientsPicked` is built by
checking for the literal names `claude` and `codex`, in two places
(`src/core/cli/walkthrough.js` and `src/core/cli/wizard/pick.js`), so a
picked OpenClaw never reaches the lane. LLP 0177 records the resulting
limbo and its cost; LLP 0174 closed the manual-attach route into the same
state and deferred this picker route as a non-goal.

One consent wrinkle is specific to OpenClaw. The finale's backfill prompt
offers "No - skip for now. You can import later with hyp backfill." For
Claude and Codex that is true: their contributions carry no `sweep`
field, so declining really does leave history unimported. OpenClaw's
contribution declares a sweep schedule (LLP 0170), so once the pick has
enabled the plugin, the daemon imports the existing `~/.openclaw` session
history within the sweep interval regardless of any answer. Asking the
question as-is would promise a control the wizard does not have.

## Options considered {#options}

1. **Derive `clientsPicked` from manifest client contributions.** A
   picked row is a client pick iff its owning plugin contributes a
   client (`contributes.client`); the finale list is those clients'
   names. LLP 0177's preferred direction: the living-list posture the
   picker itself already took in LLP 0130.
2. **Add `openclaw` to both hardcodes.** Rejected by LLP 0177 as the
   endpoint: it mints a third copy of the list whose staleness is the
   defect being fixed.
3. **For the backfill question**: (a) include OpenClaw in the consent
   prompt as written; (b) exclude it from the prompt, disclose the
   sweep, and run the first import in the finale; (c) exclude it and
   leave the first import to the sweep. (a) is dishonest per
   {#context}. (c) is honest but makes the walkthrough's first query
   race a timer for no benefit.

## Decision {#decision}

- **Derivation, not enumeration (option 1).** Both sites build
  `clientsPicked` through one shared helper: picked source ids resolve
  through the picker descriptors to their owning plugins, and every
  client descriptor whose plugin is in that set contributes its client
  name. The `('claude'|'codex')` unions widen to `string[]`; client
  names are data from manifests, not a closed type. A future adapter
  joins the finale by declaring `contributes.client`, with no CLI edit.
- **Sweep-backed providers get a disclosure, not a question (3b).** The
  finale partitions picked backfill providers by whether their
  contribution declares `sweep` (exposed on the runner as `sweeping`).
  Only non-sweep providers appear in the consent prompt; a sweep-backed
  provider prints a one-line disclosure that the enabled sweep imports
  its history on schedule, and runs the first import immediately
  (dry-run aware). This is the same import the sweep would perform
  within the interval, brought forward so first queries see data;
  consent for it was the pick itself, whose row summary discloses the
  sweep (mirroring LLP 0174#openclaw's disclosure posture for the
  manual path). A cancelled consent prompt still cancels the whole
  backfill step, sweep-backed providers included: cancel means "stop
  the wizard", not "skip the question".
- **No wizard copy of the restart instruction.** The finale dispatches
  to the adapter's `attach()`, and LLP 0169 already requires both
  attach surfaces to print the `openclaw gateway restart` instruction;
  the wizard inherits it by calling the same code.
- **Failure handling is already correct.** The attach lane's
  warn-and-continue catch covers OpenClaw's refuse-on-existing and
  not-installed hard failures; a refusal warns and the wizard proceeds,
  as a join-time refusal does (LLP 0169).

## Consequences {#consequences}

- LLP 0177 is resolved; together with LLP 0174 every route into
  enabled-but-not-attached that the user did not explicitly choose is
  closed. `hyp status`'s `client_attach_missing` warning remains the
  backstop for deliberate states and older installs.
- LLP 0174's non-goal bullet gains a forward-ref to this decision
  (mechanical edit).
- `PickerBackfillRunner` gains `sweeping: string[]`. Existing fake
  runners in tests that omit it behave as before (nothing sweep-backed,
  every provider asked).
- The consent prompt's provider list can now be empty while backfill
  still runs (an OpenClaw-only pick): no question is asked, the
  disclosure and import still happen.
- Verification per LLP 0177: unit tests assert a picked OpenClaw
  reaches the attach lane and the sweep-disclosure path, and the
  `walkthrough_picker_to_first_query` smoke stays green.

## References

- LLP 0177 (issue), LLP 0169, LLP 0174, LLP 0170, LLP 0130, LLP 0011,
  LLP 0135
- `src/core/cli/walkthrough.js`, `src/core/cli/wizard/pick.js` (the two
  derivation sites), `src/core/commands/init.js` (the backfill runner)
