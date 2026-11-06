# LLP 0407: Onboarding copy is plain language

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI
**Author:** Kenny / Claude
**Date:** 2026-09-15
**Related:** LLP 0063 (#d3), LLP 0100 (R1), LLP 0101 (#no-release), LLP 0167 (#onboarding), LLP 0171 (R12)

> Setup, sign-in, and the closing upload prompt are written for someone
> who has never heard of HypAware. Plain words win over completeness.

## Decision {#decision}

<a id="plain-words"></a>Onboarding copy uses short everyday sentences and
no internal terms. Tests pin the side effect a line must admit to, not its
wording. A reviewer who wants a fact back proposes plain wording for it;
a clause required by an older doc is not by itself a blocker.

<a id="dropped"></a>Dropped from the screens, and the older requirement is
relaxed to match:

- LLP 0063 D3: the sign-in notice no longer names the org-config consequence.
- LLP 0100 R1: the upload prompt no longer says the first sync includes imported history.
- LLP 0101 #no-release: the upload prompt no longer says uploads cannot be undone or names the review window.
- LLP 0167 #onboarding and LLP 0171 R12: the Claude and OpenClaw rows no longer name `claude-cli`, the Agent SDK, or the sweep interval.
