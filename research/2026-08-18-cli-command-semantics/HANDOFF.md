# HypAware CLI rollover handoff

**Snapshot date:** 2026-08-18
**Workspace:** `/Users/phil/.codex/worktrees/9209/hypaware`
**Branch:** `codex/cli-reorg`
**HEAD:** `ec3361bbeb29b354247db02332a70083b859e71d`
**Source-of-truth plan:** `/private/tmp/architecture-review-20260818-110404.html`

## Outcome at this checkpoint

The task-oriented CLI rollover is implemented and all automatable gates are
green. The remaining release boundary is the manual real-Claude acceptance
procedure described below. The work has not been committed, the intentional
staged and unstaged layers have not been flattened, and the rollover safety
stash has not been dropped.

If implementation changes after this checkpoint, rerun the proportionate
focused tests plus the full gates. Do not repeat the historical investigation
unless a regression points back to it.

## Start safely

Before editing:

1. Read `AGENTS.md` in full.
2. Read the relevant design records:
   - `llp/0000-hypaware.explainer.md`
   - `llp/0002-v1-scope.decision.md`
   - `llp/0009-cli-registry.spec.md`
   - `llp/0011-setup-and-onboarding.decision.md`
   - `llp/0248-task-oriented-cli-rollover.decision.md`
   - `llp/0249-cli-compatibility-rollover.plan.md`
   - `llp/0256-session-ignore-reaches-the-listener.decision.md`
   - `llp/0257-claude-telemetry-listener-source.spec.md`
   - `llp/0258-attach-injects-telemetry-via-settings-env.decision.md`
   - `llp/0262-otel-attach-replaces-proxy.rfc.md`
3. Use the `domain-modeling` skill for LLP or domain changes, the
   `log-driven-development` skill and its self-test loop for workflow or smoke
   changes, and `writing-for-agents` for agent-facing instruction changes.
4. Audit the live state before making an edit:

   ```sh
   git branch --show-current
   git rev-parse HEAD
   git status --short
   git stash list
   git diff --stat
   git diff --cached --stat
   ```

Explain any difference from this checkpoint before discarding or restaging
anything.

## Settled interface

There is no `admin` namespace and no `fleet` namespace.

Primary help is organized in this order:

```text
Getting started:
  setup
  status

Explore and share:
  ask
  query
  report

Control capture and movement:
  client
  privacy
  session
  join
  leave
  sync

Additional commands:
  daemon, config, cache, sink, plugin, remote, mcp, graph, vector,
  enrichment, source, version, dev
```

The Additional commands line is availability-aware. Core operations always
appear. Plugin-owned names such as `vector` and `enrichment` appear only while
their plugin is config-active. `source` remains absent while the Gas City
canonical routes are withheld. This is why bare help in an arbitrary checkout
can be a subset of the conceptual list in the HTML plan.

The canonical journey tree includes:

```text
setup [preset] [flags]
status [--json]
ask [question] [--list]
query overview|sql|schema
query graph neighbors
query vector search
report render|publish|list|get|delete
sync
session status|ignore|unignore
client status|attach|detach
client history import|plan|providers
client skills install
client claude-account login|logout|status
client claude-desktop install|status|verify|profile|install-helper
privacy show|set|unset|list|ignore|unignore|client|folders|purge
join
leave
dev plugin new|doctor
dev smoke
```

Direct operational families remain top-level:

```text
daemon install|uninstall|run|start|status|stop|restart
config validate
cache status|refresh|maintain
sink maintain
plugin install|list|info|outdated|update|remove
remote add|login|list|remove
mcp serve
graph project|compact
vector status
enrichment propose|curate|backfill|status
version
```

Changed public spellings remain hidden compatibility aliases and resolve to
the same registration and runner as their canonical spellings. This includes
`init`, `attach`, `detach`, `unattach`, `backfill`, `skills install`, `policy`,
`ignore`, `unignore`, `purge`, old graph/vector query placements, `plugin
new|doctor`, `smoke`, bare `mcp`, and `enrich`.

These hidden machine contracts remain exact, callable, and absent from help:

```text
claude-account credential
claude-hook session-context
claude-hook classify-cwd
codex-hook classify-cwd
```

`claude-account credential` must continue to emit exactly one secret JSON line
to stdout.

Semantic boot profiles are:

- bare `hyp` and `setup`: `all-available`
- `status`, every `daemon` command, `version`, and `dev smoke`: no activation
- all other commands: config-active
- aliases inherit the canonical command's profile

## Deliberately deferred

The following setup lifecycle commands remain documentation-only future work:

```text
setup update [--check] [--to VERSION] [--dry-run] [--yes]
             [--accept-breaking]
setup repair [--dry-run] [--resume] [--version VERSION]
setup rollback [snapshot-id] [--dry-run]
```

Do not register partial implementations. They require a durable operation
journal, snapshots, daemon coordination, migrations, managed-client
reconciliation, health verification, and rollback. Generic `--yes` must never
imply acceptance of a breaking version.

The `source gascity attach|detach|list` canonical routes are also withheld.
Current Gas City attach and detach only change process memory, so publishing
those names would promise persistence they do not provide. The old Gas City
surface remains available as before.

Alias removal is a future major-version decision. Vector search remains local
until its remote contract is modeled as a typed verb.

## What was implemented

- Registry and manifest metadata for help category, audience, group state,
  hidden state, aliases, invoked name, and semantic boot profile.
- Semantic command resolution before boot selection.
- Journey-oriented top-level help with a compact, availability-aware
  Additional commands line.
- Canonical `setup`, `client`, `privacy`, `dev`, `cache`, `mcp serve`, and
  `enrichment` routes, plus graph and vector query placements.
- Config-active-only plugin command and alias discovery without plugin
  activation during help.
- Hidden machine command preservation.
- `client status` as a projection of the one overall status snapshot. Claude
  rows expose OTEL attach mode, configured telemetry endpoint, live listener
  endpoint, endpoint drift, recorder/capture health, and relevant timestamps.
  Filtering one client cannot leak another client's health.
- Claude OTEL-aware status repairs and canonical user-facing command teaching.
- Session status aggregation across advertised gateway and Claude OTEL
  recorders before claiming a session is ignored.
- Canonical command teaching in walkthroughs, diagnostics, privacy material,
  acceptance steps, and bundled Claude/Codex HypAware skills.
- Cache `status|refresh|maintain`, setup/client/privacy/dev help, and plugin
  manifest/runtime consistency coverage.
- Gateway test isolation from the real machine's proxy CA and `HYP_HOME`.
- Central-layer recovery that unlinks a damaged `active` symlink before
  reseeding.
- Walkthrough smoke fixture precedence so the test cannot fall through to the
  real Anthropic preset.
- Removal of the superseded base-URL proxy migration test and tracked test log
  artifacts.

Draft rationale and rollout documents are untracked at this checkpoint:

```text
llp/0248-task-oriented-cli-rollover.decision.md
llp/0249-cli-compatibility-rollover.plan.md
```

Research and this handoff are under:

```text
research/2026-08-18-cli-command-semantics/
```

## Evidence already green

Latest full verification on 2026-08-18:

```text
npm run typecheck
  passed

npm test
  4507 tests
  4505 passed
  2 skipped
  0 failed

node --test test/core/cli-consistency-gate.test.js \
  test/core/group-and-verb-help.test.js
  33 passed
  0 failed

git diff --check
  passed

git diff --cached --check
  passed

U+2014 scan over src, hypaware-core, docs, llp, research, and test
  no matches
```

The focused repaired regression set was also green: 399 passed and 1 skipped.
An earlier focused CLI, status, privacy, and Claude set passed 247 tests.

Required hermetic smokes completed successfully:

```text
cli_bundled_plugins_activated
walkthrough_picker_to_first_query
client_attach_idempotent
status_diagnostics
package_bin_boot
claude_telemetry_capture
claude_telemetry_hypignore_drop
claude_telemetry_session_ignore
status_capture_health
```

Additional successful smokes:

```text
claude_attach_detach
walkthrough_backfill_client_history
source_optout_export_withhold
walkthrough_to_first_query
```

The final `walkthrough_to_first_query` run used:

```text
DEV_RUN_ID=smoke-walkthrough_to_first_query-2026-08-18T21-31-23-993Z-46216
```

Rerun the full suite and affected smokes if code changes. For smoke failures,
use that run's `DEV_RUN_ID` to inspect run-specific logs and spans before
editing, following `AGENTS.md` and the log-driven self-test loop.

## HTML comparison notes

The implementation matches the HTML's command organization, aliases, semantic
boot model, hidden contracts, canonical teaching, and deferral boundaries.

Some HTML table rows still call OTEL work a `New gap` because the document was
written as a proposal. In this checkout, `client status`, multi-recorder
`session status`, OTEL attach/capture projection, canonical repairs, attach
dry-run preflight, and manifest/picker wording have been implemented and
tested. Treat those labels as historical proposal status, not missing code.

The conceptual Additional commands list names all possible config-active
plugin families. Runtime help intentionally filters plugin-owned families by
the active config, and intentionally omits `source` while Gas City routes are
withheld.

## Git safety and current worktree shape

Preserve this stash unless Phil explicitly approves dropping it after final
rollover review:

```text
stash@{0}: On (no branch): codex-cli-reorg-before-otel-rollover
```

The worktree intentionally has a large mixed state:

- staged CLI changes reapplied from the safety stash
- additional unstaged OTEL reconciliation, test repairs, smoke repairs, and
  documentation teaching changes
- files marked `MM`, including
  `src/core/usage-policy/classification.js`, where staged and unstaged layers
  must both be preserved
- staged deletion of `test/core/attach-proxy-migration.test.js`
- staged deletions of `x/npm-test.log` and `x/typecheck.log`
- untracked LLP drafts, research material,
  `test/core/cli-consistency-gate.test.js`, and
  `test/core/client-status-otel.test.js`

Do not run `git reset`, `git restore`, `git checkout --`, or `git add -A` as a
cleanup shortcut. Inspect staged and unstaged diffs separately and stage only
with deliberate file or hunk selection.

## Remaining release boundary

The manual `claude_otel_shape_check` in `docs/ACCEPTANCE.md` remains pending.
It requires a real Claude Code 2.1.214 or newer and cannot be substituted with
the hermetic fixture smoke. Before releasing Claude adapter changes, run it and
record the observed Claude version and complete event-name list in the release
notes.

The safety stash can be considered for removal only after:

1. the final staged and unstaged diff is reviewed,
2. the desired commit boundary is settled,
3. any code changes made after this checkpoint are reverified,
4. the manual release acceptance item is either completed or explicitly
   carried as a release blocker, and
5. Phil explicitly authorizes dropping `stash@{0}`.
