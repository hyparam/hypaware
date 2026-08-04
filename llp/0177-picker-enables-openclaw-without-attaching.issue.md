# LLP 0177: The init picker enables OpenClaw but never attaches it

**Type:** Issue
**Status:** Accepted
**Systems:** Onboarding, CLI, Config
**Author:** Brendan / Claude
**Date:** 2026-08-03
**Related:** LLP 0011, LLP 0135, LLP 0174, LLP 0175, LLP 0169
**Extended-by:** LLP 0180 (the fix decision)

## Summary

The walkthrough/wizard finale has a fully generic attach lane: it iterates
`clientsPicked`, resolves each client's adapter from the live gateway
registry, calls `adapter.attach()`, and asks the backfill-consent question.
OpenClaw's client registration and attach surface exist precisely so this
loop covers it like Claude and Codex (LLP 0169). But the list feeding the
loop is a hardcoded pair, in two places:

- `src/core/cli/walkthrough.js` (~477):
  ```js
  const clientsPicked = []
  if (picks.sources.includes('claude')) clientsPicked.push('claude')
  if (picks.sources.includes('codex')) clientsPicked.push('codex')
  ```
- `src/core/cli/wizard/pick.js` (~237): the same pair against
  `clientCandidates`.

Picking OpenClaw therefore enables the adapter plugin and then silently
drops it from the finale: no attach, no backfill consent, no client assets.
The install lands in "configured, not attached" limbo with a
`client_attach_missing` warning the user must notice and repair by hand.

## Why the limbo is worse for OpenClaw than it would be for the others

For Claude and Codex, enable-without-attach was never reachable from the
picker (the hardcode includes them), and enabling alone imports nothing.
OpenClaw's backfill contribution carries a `sweep` field (LLP 0170), so
mere enablement starts the 5-minute transcript sweep. The resulting half
state - sweep recording, live capture dead, status warning - is exactly the
condition observed on a real install on 2026-08-03, and it cost a full
diagnostic session to unwind (see LLP 0175's evidence trail, which begins
from this limbo).

## Root cause

Client-ness is decided by a name list copied into two call sites instead of
being read from what the picked entries contribute. The authoritative fact
already exists per adapter: the manifest's `contributes.client.name`
(OpenClaw's declares `openclaw`), and the finale already builds a
client-descriptor map for its skills/agents leg, so the source of truth is
present in the flow that mishandles it.

## Fix direction

1. Preferred: derive `clientsPicked` from the picked entries' client
   contributions (manifest `contributes.client`, or the existing
   walkthrough client-descriptor map), removing the name list from both
   sites. A future client adapter then joins the finale by declaring
   itself, with no CLI edits - the same living-list posture LLP 0161/0162
   take elsewhere.
2. Minimal fallback: add `openclaw` to both hardcodes. Rejected as the
   endpoint (it is the third copy of the list and this issue is the list
   biting), but acceptable as a hotfix if the derivation is delayed.
3. Verification: wizard/walkthrough unit tests asserting a picked
   openclaw reaches the finale attach loop and the backfill-consent list,
   plus the `walkthrough_picker_to_first_query` smoke staying green.

## Relationship to LLP 0174

LLP 0174 (accepted) closes the MANUAL path into the same limbo: a
`hyp attach` against a not-enabled adapter stops dead-ending and prompts to
enable. This issue closes the PICKER path: an enabled-by-pick adapter must
not skip attach. Together they remove every route into
enabled-but-not-attached that the user did not explicitly choose.
`hyp status`'s `client_attach_missing` warning remains the backstop for
states created deliberately (or by older installs), not the primary UX.

## Non-goals

- The capture-layer defects the limbo exposed (misattribution, settlement,
  Responses decoding) are LLP 0175 / LLP 0176, fixed separately.
- Attach verification semantics ("attached" meaning settings written, not
  traffic observed) stay with LLP 0175/0176's open questions.

## References

- LLP 0011 (init finale), LLP 0135 (wizard orchestration): the flow that
  owns the hardcode.
- LLP 0169: the OpenClaw attach surface the finale should be calling.
- LLP 0174: the sibling consent design for the manual path.
- LLP 0175: the live investigation that started from this limbo.
