# LLP 0098: A dispatch miss on a known-but-inactive plugin command is "unavailable", not "unknown"

**Type:** decision
**Status:** Accepted
**Systems:** CLI
**Generated-by:** neutral
**Date:** 2026-07-10
**Related:** LLP 0009, LLP 0031

> When `hyp <cmd>` names a command that a bundled/installed plugin declares
> but the effective config does not activate, the dispatcher used to print
> the generic `hyp: unknown command '<cmd>'`
> ([issue #294](https://github.com/hyparam/hypaware/issues/294)). The command
> is not unknown, it is *unavailable*: the process already knows which plugin
> provides it (the same manifest catalog `--help` synthesis reads) and knows
> it was left inactive. This settles that the miss path reports that state
> plus a repair line, and why the match is deliberately narrow.

## Decision

On a top-level dispatch miss (no command and no group prefix matched), before
emitting the generic unknown-command error, exact-match the first argv token
against the leading word of every command declared by a plugin that is in the
boot pool but NOT selected by a `config`-profile boot (bundled-excluded, or
installed but absent from the active config). On a hit, emit two lines and
keep exit code 2:

```
hyp: 'graph' is provided by @hypaware/context-graph, which is not in the active config
  repair: add {"name": "@hypaware/context-graph"} to plugins[] in ~/.hyp/hypaware-config.json
```

Constraints that make this choice narrow and safe:

- **Exact match only.** The token must equal the first word of a declared
  command name (`graph` for `graph project`). A genuine typo matches nothing
  and still gets the generic `unknown command` message. This keeps the new
  path from swallowing real mistakes.
- **Inactive plugins only.** Active plugins register their commands during
  boot, so their tokens matched `registry.match`/group help earlier and never
  reach the miss path. The lookup therefore only ever fires for commands that
  are genuinely present-but-not-enabled.
- **Reuse of the boot selection, not a second catalog.** The check calls the
  same `selectBootPlugins` computation `--help` synthesis uses, split into
  `selected` vs the rest of the `pool`, so "inactive" means exactly what boot
  would leave inactive - including the shadow and excluded-skeleton rules.
- **The repair targets the local config layer.** The additive merge model
  (@ref LLP 0031 [constrained-by] - central locks only the plugin names it
  declares) means adding a plugin name to the user-owned local
  `plugins[]` is legitimate even on a fleet-locked host, so the repair line is
  safe to print unconditionally.

## Rejected alternatives

- **Keep the generic message.** Rejected: on fleet-joined hosts with no local
  `hyp init` walkthrough, "unknown command" reads as "this feature does not
  exist" when the true state is two additive config lines from working.
- **Fuzzy/prefix suggestion ("did you mean graph?").** Rejected: it would fire
  on typos too, blurring the deterministic boundary between a real mistake and
  a deactivated feature. Exact match keeps the two outcomes crisp.
