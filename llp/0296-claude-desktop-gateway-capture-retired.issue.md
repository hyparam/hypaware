# LLP 0296: Retire Claude Desktop gateway capture

**Type:** Issue
**Status:** Active
**Systems:** Plugins, Gateway, Onboarding, Config
**Author:** Brendan / Codex
**Date:** 2026-08-19
**Related:** LLP 0115, LLP 0133, LLP 0139, LLP 0140, LLP 0188, LLP 0192, LLP 0202, LLP 0224

> Retires the accepted Claude Desktop gateway decisions. The
> third-party-inference route changes Claude Desktop's account context,
> making the user's normal account and its data appear gone until they
> switch back. That user impact is not acceptable for capture.

## Problem {#problem}

HypAware's Claude Desktop adapter writes a managed-preferences plist that
selects Claude Desktop's third-party gateway inference mode. Although the
gateway can capture traffic, enabling that mode moves the app into a
different account context. The user's regular account data is then absent
from the UI until they manually return to that account. Setup therefore
violates the basic requirement that observability must not change the
product being observed.

## The route is removed, not flagged off {#kill-switch}

Claude Desktop gateway capture is **deleted** while a transparent capture
lane is investigated, such as OTEL or another log-based integration. The
enabling code does not ship.

A first pass disabled the route in place: it kept the picker row with
`hidden: true`, kept `install` / `profile` / `install-helper` / `verify`
registered as commands that refuse, and left the plist renderer, the
consent gate, the helper writer and the verifier in the package. That is
not a kill switch. Re-enabling it is one flag and four `run:` swaps, the
six commands still render in `hyp help client`, and `npm test` still
carried 61 green tests asserting the managed-plist install path works
correctly. A repo that certifies a route in CI has not retired it.

So:

- **No picker row.** Deleting `contributes.picker` is what actually closes
  the door. `hidden` does not: [LLP 0202 #hidden-rows](./0202-hidden-picker-rows.decision.md#hidden-rows)
  defines a hidden row as a fully functional source that is merely not a
  first-run question, and states in terms that `hyp init --source <id>`
  still composes it. `runWizardPick` bears this out, taking
  `opts.picks.sources` verbatim; only the interactive path filters by
  `descriptors.has`. Reusing `hidden` to mean "unavailable" would overload
  an Accepted decision with a second, contradictory meaning.
- **No enabling code.** `install.js`, `profile.js`, `consent.js`,
  `verify.js` and `inputs.js` are deleted with their tests. All of them
  exist to *create* the state being retired, and the replacement lane will
  not render managed preferences. Git history is the archive.
- **No visible commands.** Only `client claude-desktop disable` is
  registered, and it sets `hidden: true` so it is absent from `hyp help`
  and `hyp help client`. It runs if typed.
- **No config section.** The `claude_desktop` section is profile-render
  inputs (`models`, `endpoint`, `helper_path`, `bundle_id`) for the retired
  route. Its validator and manifest declaration are removed. Existing
  configs carrying the section stay valid: the root schema rejects no
  unknown section, and a section with no registered validator is simply
  not validated.

To a machine that never ran the old route, Claude Desktop does not exist.

## What must not be deleted, and why {#attribution-stub}

`contributes.client` stays, in particular
`transcript_entrypoints: ["claude-desktop", "claude-desktop-3p"]`.

This is not cosmetic metadata. Claude Desktop writes its sessions into
`~/.claude/projects`, the same tree Claude Code uses.
`resolveEntrypointOwners` builds the owner map from this manifest field,
and `classifyTranscriptEntrypoint` **fails open** on an entrypoint no
installed plugin claims: an unknown session is imported and attributed to
the scanning client. Delete the manifest and the `@hypaware/claude`
backfill starts importing Desktop conversations and filing them under
`claude`.

Removing the plugin outright would therefore make Desktop capture *more*
likely and silently mislabelled. The stub exists to keep the gate closed.
See [LLP 0140 #gate-before-projection](./0140-transcript-entrypoint-ownership.decision.md#gate-before-projection).

The gate closes on an entrypoint an installed plugin claims **while not
being configured**, so the stub does its job precisely because nothing
composes it into a config any more.

### The picker row was not load-bearing for privacy {#picker-not-privacy}

An earlier draft kept the picker row on the grounds that it preserved "the
privacy ownership catalog". It does not, and the distinction matters
because [LLP 0202 #hidden-rows](./0202-hidden-picker-rows.decision.md#hidden-rows)
correctly warns that deleting a picker block can disarm
[LLP 0192 #fail-closed](./0192-unattributed-rows-escape-optout.issue.md#fail-closed)'s fail-closed
withholding.

That warning is about `raw-anthropic` / `raw-openai`, and does not
transfer:

- `datasetOwnedSourceIdsFromCatalog` folds picker ids only for plugins
  that declare `contributes.datasets`. `@hypaware/claude-desktop` declares
  none, so its row contributes zero entries. Only `@hypaware/ai-gateway`
  declares `ai_gateway_messages`, which is why the raw rows are different.
- Real withholding is `shouldWithhold(attributionValue)`, a string match of
  the `client_name` column against the opt-out store. Desktop rows are
  stamped `client_name: 'claude-desktop'` by the *claude* plugin off the
  User-Agent, with no descriptor involved.
- A standing opt-out survives the row's removal: the sync-scope write has
  editor semantics over shown candidates only and keeps entries for
  sources it does not render.

## Existing installs {#existing-installs}

An upgrade cannot silently repair an already-configured Mac. The managed
plist is root-owned, and removing it automatically would either fail or
raise an unexpected sudo prompt from a daemon or unrelated CLI command.

Recovery is one attended command, `hyp client claude-desktop disable`:
it removes exactly
`/Library/Managed Preferences/com.anthropic.claudefordesktop.plist`,
flushes the preferences cache, and tells the user to quit and reopen
Desktop. `--print-commands` prints the recovery commands without applying
them.

The helper and credential state are left alone. They do not redirect
Desktop without the plist, and may be shared with other Anthropic capture
paths.

Existing generated configs may still list the gateway and credential
plugins. Reconfiguration cannot always distinguish the old
Desktop-generated Anthropic upstream from an explicitly selected raw
Anthropic source, because those compositions are byte-identical. It
therefore does not guess and delete the shared gateway. The residual
gateway does not change Desktop's account once the managed plist is
absent.

## Status reports residue, not incompleteness {#status-surface}

A retired client is `configured && !attached` forever, so the existing
`client_attach_missing` diagnostic would fire on every `hyp status` for
every machine that ever configured Desktop, saying "settings show no
HypAware marker" - which is now the *desired* state - and prescribing a
repair that writes no marker and so never clears itself.

[LLP 0224 #repair-surface](./0224-desktop-setup-second-pass.decision.md#repair-surface)
accepted an unclearable prompt on the reasoning that it "beats no surface
at all" while setup was something a user might still complete. With setup
gone that trade is inverted: the prompt points at nothing to finish.

So `contributes.client` carries the retirement declaratively, beside the
`transcript_entrypoints` it already declares:

```json
"retired": { "residue_path": "/Library/Managed Preferences/com.anthropic.claudefordesktop.plist" }
```

One field rather than a core special-case, for the reason
`resolveEntrypointOwners` gives for the owner map: three hardcoded lists in
that area have already drifted from the manifests. `residue_path` is the
plugin's own knowledge, and `hyp status` reads static catalog data without
booting plugins, so core cannot ask the plugin at status time.

Status then:

- emits no `client_attach_missing` for a retired client, and
- emits a residue diagnostic **only when the managed plist is actually on
  disk and the plugin is in the config**, naming
  `hyp client claude-desktop disable` as the repair, which genuinely clears
  it.

The second half of that gate is load-bearing, not tidiness.
[LLP 0133 #one-surface](./0133-desktop-solo-sudo-plist.decision.md#one-surface)
put solo and fleet on the *same* file: an MDM push and HypAware's own sudo
write land at one path and differ only in the placer. The file's existence
therefore does not identify it as ours, and an ungated check would tell a
user whose IT department manages that profile to delete it. The config
listing the plugin is the available evidence that HypAware is the placer on
this machine.

That gate has a cost, and it is not recoverable for the installs this issue
exists for. Someone who removes `@hypaware/claude-desktop` from their config
while the plist is still on disk keeps a redirected Desktop and gets no
warning, which is close to the worst outcome: dropping the plugin is exactly
what "uninstall Desktop capture" looks like from the outside. A marker
written at placement time would separate our plist from an MDM's and let the
check stand on evidence rather than on the config, but no release ever wrote
one, so existing installs cannot be told apart retroactively. A replacement
capture lane should write such a marker from the start.

A clean machine is silent. An affected machine is the one case where
silence would strand a user whose Claude Desktop is in the wrong account
context and who has no reason to type a hidden command.

> **LLP 0224's named follow-up is withdrawn.** It proposed giving Desktop
> a plist-reading *attach probe* so a finished setup quiets the warning by
> observation. That is now the wrong mechanism: `attachProbe` is the
> attach-eligibility gate in `action_attach.js` `desired()`, so declaring
> one re-opens the reconciler's attach-on-join path. The residue check must
> not be an attach probe.

## Re-enable gate {#reenable}

Claude Desktop support must not be re-enabled by restoring the deleted
files or re-adding a picker row. A replacement needs a new LLP and an
acceptance procedure proving all of the following on a real app build:

1. Capture does not change account, organization, model, or conversation
   visibility.
2. Enabling, disabling, daemon restart, and HypAware uninstall leave
   Desktop behavior unchanged.
3. The capture lane has stable attribution and secret-safe observability.
4. Failure degrades to no capture, not to a different product experience.

This issue supersedes the enabling behavior in LLP 0115, LLP 0133 and
LLP 0139. Their findings remain useful history, but they are not
authorization to ship or run the gateway route while this issue is Active.
