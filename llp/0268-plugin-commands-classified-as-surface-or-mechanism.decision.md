# LLP 0268: Plugin commands are classified as CLI surface or internal mechanism

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins
**Author:** neutral / Claude
**Date:** 2026-08-18
**Related:** LLP 0009 (#core-owns-dispatch, #layered-help: the help system this narrows), LLP 0005 (#declarative: manifests list commands before any plugin loads), LLP 0202 (#hidden-rows: the display-filter-not-catalog-deletion rule this reuses), LLP 0153 (#unavailable-not-unknown: what a manifest declaration buys the miss path), LLP 0116 (#helper-contract: the one command this classifies as a mechanism), LLP 0139 (#macos-only: why the Desktop staging commands are surface, not plumbing), LLP 0214 (#d2: long help for plugin-owned commands)

> Extends [LLP 0009 #layered-help](./0009-cli-registry.spec.md#layered-help),
> replacing the mechanism it named in passing. 0009 said a hidden command
> "stays out of help by being omitted from the manifest". That is the one
> option a manifest-first CLI cannot afford, for the reason LLP 0202 already
> found on the picker side. A declared command gains a `hidden` flag instead.

## Context {#context}

`hyp --help` renders before `bootKernel`, so the plugin rows it prints come
from manifests, not from the activated registry
([LLP 0009 #top-level-help-lists-plugin-commands-without-booting](./0009-cli-registry.spec.md)).
A plugin's `contributes.commands` array is therefore two things at once: the
list of what the plugin registers, and the advertisement of what a user may
run. Nothing in the manifest separated them, so every command a plugin
registered became a public promise the moment its plugin was config-active.

The audit in issue #838 asked whether that is right for four commands in the
Claude Desktop pair. Answering it needs a classification for all of them, not
only those four.

## The classification {#classification}

Every manifest-declared first-party command falls into one of four classes.
The first three are **CLI surface**: they appear in help and are covered by
the usual compatibility expectations. The fourth is not.

1. **Public workflow.** A person runs it to get something done.
2. **Public diagnostic.** A person runs it to find out what is going on.
   Visible, and it earns long help ([LLP 0214](./0214-verbs-and-plugin-groups-carry-long-help.decision.md)),
   because a diagnostic that does not say what its output means is not one.
3. **Compatibility surface.** A person runs it directly, but the audience is
   narrower than the plugin's own: a fleet admin staging an MDM push rather
   than the machine's owner. Visible, for the same reason - an audience that
   cannot discover the command cannot use it.
4. **Internal mechanism.** The caller is a program, not a person: a wrapper
   script, or an in-process orchestration step another command drives. It
   must stay dispatchable and it must not be advertised.

Applied to the current first-party set:

| Command | Class |
| --- | --- |
| `session ignore` / `session unignore` | public workflow |
| `session status` | public diagnostic |
| `claude-account login` / `claude-account logout` | public workflow |
| `claude-account status` | public diagnostic |
| `claude-account credential` | **internal mechanism** |
| `claude-desktop install` / `claude-desktop verify` | public workflow |
| `claude-desktop status` | public diagnostic |
| `claude-desktop profile` / `claude-desktop install-helper` | compatibility surface |
| `graph project` / `graph compact` / `graph neighbors` | public workflow |
| `enrich` (+ `propose`, `curate`, `backfill`) | public workflow |
| `enrich status` | public diagnostic |
| `vector` / `vector search` | public workflow |
| `vector status` | public diagnostic |
| `gascity attach` / `gascity detach` | public workflow |
| `gascity list` | public diagnostic |

<a id="internal"></a>**Exactly one command is an internal mechanism:
`claude-account credential`.** Its caller is the no-arg wrapper Claude
Desktop `exec`s, and its contract is that stdout is a live credential and
nothing else ([LLP 0116 #helper-contract](./0116-desktop-credential-client-presented.decision.md)).
Both halves argue against advertising it. A machine-to-machine contract
listed beside `login` and `status` reads as a third thing a person might
try, and the thing they get for trying is a token on their terminal, in
their scrollback, and plausibly in a bug report.

<a id="staging-is-surface"></a>**The three Desktop staging commands are
surface, not plumbing, and this decision says so rather than hiding them.**
Issue #838 proposed `claude-desktop profile`, `install-helper`, and `status`
as internal on the grounds that `install` drives all three. It does, but
that is not the whole audience:
[LLP 0139 #macos-only](./0139-desktop-picker-consent.decision.md) already
settled that these three stay runnable off a Mac because rendering the MDM
payload or staging the helper "is legitimately useful on a non-Mac admin box
preparing a fleet push". A command an Accepted LLP keeps working for an
audience is not one to make undiscoverable for them. They stay declared and
visible; what they get instead is the honest label above, and, for `status`,
the long help a diagnostic owes its reader.

## The field {#field}

A `contributes.commands` entry may set `hidden: true`. A hidden command:

- does not appear in `hyp --help`, nor in its group's subcommand table;
- still dispatches, by name, exactly as before;
- still declares itself, so `findInactivePluginForCommand` can answer a
  miss on an inactive plugin with "unavailable, here is the plugin"
  rather than "unknown" ([LLP 0153](./0153-inactive-not-unknown-dispatch-miss.decision.md));
- must set `hidden: true` on its runtime `ctx.commands.register` call too.

Both sides are required because they cover different renderers. The manifest
field governs pre-boot top-level help, which never sees the registry; the
registration field governs group help and synthesized group rows, which are
rendered after activation and never see the manifest. Setting one and not
the other hides the command from half of help, which is worse than either
consistent answer. The parity test in
`test/core/plugin-command-visibility.test.js` is what holds the two together.

<a id="not-deletion"></a>**Hiding is a display filter, never a catalog
deletion** - the same rule [LLP 0202](./0202-hidden-picker-rows.decision.md)
set for picker rows, and for the same class of reason. LLP 0009 named
omission from the manifest as the way to hide a command. Omission also
deletes the only pre-boot record that the command exists, and two things
read that record: the dispatch-miss path that turns "unknown command" into
"unavailable, enable `@hypaware/x`", and the manifest/registration parity
tests that catch summary drift. An internal command is the *most* likely to
be typed by someone who does not know which plugin owns it, so it is the
worst one to make unattributable. It stays declared, and it is marked.

## Consequences {#consequences}

- `PluginCommandManifest` gains `hidden?: boolean`.
  `validateCommandContributions` (`src/core/manifest.js`) now validates the
  `contributes.commands` array instead of passing it through opaquely, and
  rejects a non-boolean `hidden` - a manifest spelling it `"true"` would
  otherwise advertise an internal mechanism with nothing to say so.
- `collectPluginHelpCommands` (`src/core/cli/dispatch.js`) skips hidden
  entries. The registry-side filters (`renderHelp`, `listGroupChildren`)
  already existed and are unchanged.
- `claude-account credential` is hidden on both sides. Nothing else is.
- `claude-desktop status` and `claude-account status` gain long help, and
  both state in it that they print no secret and where sign-in state
  actually lives.
- The class names above are the vocabulary for future plugin commands: a
  new command picks one, and only class 4 may set `hidden`.

## References

- LLP 0009, LLP 0005, LLP 0202, LLP 0153, LLP 0116, LLP 0139, LLP 0214
- `hypaware-plugin-kernel-types.d.ts` (`PluginCommandManifest`,
  `CommandRegistration`), `src/core/manifest.js`
  (`validateCommandContributions`), `src/core/cli/dispatch.js`
  (`collectPluginHelpCommands`), `src/core/cli/group_help.js`
  (`listGroupChildren`),
  `hypaware-core/plugins-workspace/claude-account/`,
  `hypaware-core/plugins-workspace/claude-desktop/`,
  `test/core/plugin-command-visibility.test.js`
- [issue #838](https://github.com/hyparam/hypaware/issues/838)
