# LLP 0411: Offer GitHub login during onboarding

**Type:** Spec
**Status:** Draft
**Systems:** Onboarding, CLI, Plugins
**Author:** Phil / Codex
**Date:** 2026-09-16
**Extends:** LLP 0011, LLP 0201, LLP 0360, LLP 0409

## Request

Ask during onboarding whether to collect GitHub information from AI sessions
so HypAware can query repositories, pull requests, and related information.
An affirmative answer runs GitHub login and opens its browser page.

## Offer {#offer}

Attended local and team setup ask a separate GitHub yes/no question after the
upload/sync offer, before the closing skill suggestion. Express setup
still asks: accepting recording defaults does not authorize GitHub collection.
This extends LLP 0201's express-question scope. The optional offer is outside
the existing numbered recording steps. Enter accepts, EOF declines, and prompt
cancellation skips GitHub and preserves the completed setup. It offers no back-navigation.
Non-interactive and dry-run setup never ask or log in. A config that already
includes a local GitHub selection is not re-authorized by this offer. A team's
central activation does not stand in for this machine's login.

The accept option names the access the login will request: the `repo` scope,
which reaches private repositories and which GitHub grants with write. LLP 0409
already makes `hyp github login` disclose that, but the login runs only after
this yes, so the widest fact about the grant has to precede the answer rather
than follow it.

## Activation {#activation}

Yes composes the existing `@hypaware/github` plugin and its context-graph
dependency into a fresh read of the saved local config, without duplicates.
The guarded write keeps a backup and preserves changes made during setup. No leaves the
selection unchanged. This is explicit opt-in under LLP 0360, not a new default
plugin. Existing inventory and withholding rules apply: OAuth access does not
expand the session-derived repository inventory. No new config key is needed.

## Login {#login}

After the upload offer and a successful GitHub config update, run
`hyp github login` through the existing in-process command seam. Its fresh
config activation (LLP 0139) loads the newly enabled plugin. Reuse LLP 0409's device flow, scope
disclosure, browser opening, bounded polling, cancellation, and private token
storage. Setup neither implements OAuth nor reads credentials.

An incomplete login leaves the explicitly enabled plugin in place, prints
`hyp github login` as the retry, and continues setup. The existing source
reports missing authentication until login succeeds. Refusing the config
overwrite starts no login. If the finale successfully started the daemon,
restart it after login so it loads GitHub; a failure prints the restart command.
An intentionally skipped or unsuccessful daemon start is not retried here.
Offer, configuration, and login emit secret-free outcome spans.

## Verification

Traditional tests cover consent, EOF, skipped runs, committed activation,
command ordering, login failure, and reconfiguration. The GitHub capture smoke
checks the onboarding spans alongside existing session inventory and capture.
Real browser authorization is only checked by hand.
