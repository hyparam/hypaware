# LLP 0111: `hyp policy`, the class-neutral machine-local marking verb

**Type:** design
**Status:** Active
**Systems:** CLI, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-16
**Generated-by:** neutral
**Related:** LLP 0110, LLP 0103, LLP 0049, LLP 0106

> Machine-local usage-class markings move from flags on `hyp ignore` to a
> dedicated `hyp policy` command group: `set` / `show` / `unset` / `list`.
> The verb names the subsystem (Usage-Policy) instead of misnaming the action
> ("ignore" to opt INTO syncing). `hyp ignore` / `hyp unignore` keep their
> honest LLP 0049 dotfile meaning; the `--sync` / `--local-only` / `--private`
> / `--check` flags survive as deprecated compatibility aliases that delegate
> to the `policy` code paths. The store format, the shared resolver, and the
> three-class lattice are untouched.
>
> @ref LLP 0110 [implements] - retires the `hyp ignore --sync` misnomer behind a class-neutral `hyp policy` verb, exactly the surface the issue settled with the author
> @ref LLP 0103#cli [constrained-by] - extends its CLI paragraph; store format, resolver, and class lattice untouched
> @ref LLP 0049#cli [constrained-by] - `hyp ignore` / `hyp unignore` keep their settled dotfile meaning unchanged

## Scope and non-goals

This is a verb-surface change only. Explicitly out of scope:

- The machine-local store (version-2 class-per-entry JSON, LLP 0103) and its
  read/write helpers (`readLocalOnlyEntries` / `writeLocalOnlyEntries`): no
  format or migration change.
- The shared resolver (`createUsagePolicyResolver`), the class lattice
  (`ignore` > `local-only` > `full`, most-restrictive-wins), and every
  enforcement seam: unchanged.
- The `.hypignore` dotfile semantics (LLP 0049): unchanged, including the
  bare `hyp ignore [path]` / `hyp unignore [path]` verbs that author it.
- `hyp purge` (LLP 0104): unchanged; marking stays non-destructive.

## The command surface {#surface}

A new `policy` command group in the kernel CLI registry (LLP 0009), using the
existing `makeGroupCommand` + two-word command pattern (`daemon start`,
`skills install`) in `src/core/cli/core_commands.js`:

```
hyp policy set <path> sync|local-only|ignore   # write a machine-local marking
hyp policy show [path] [--json]                # report the governing class and source
hyp policy unset <path> [sync|local-only|ignore]  # remove the marking (back to default)
hyp policy list [--json]                       # enumerate machine-local entries
```

### Class tokens {#tokens}

The user-facing class vocabulary is the one the classification hook and the
privacy skill already teach: `sync`, `local-only`, `ignore`. At the CLI edge,
`sync` maps to the stored class `full` (LLP 0103's "asked; syncs" marker);
`local-only` and `ignore` map to themselves. The store keeps speaking `full`
internally: no entry rewrite, and `policy show --json` keeps emitting the
resolver vocabulary (`full` / `local-only` / `ignore`) so existing consumers
of the `hyp ignore --check --json` shape see identical fields. An unknown
class token is a usage error (exit 2) that names the three valid tokens.

### `policy set <path> <class>` {#set}

Writes a machine-local marking for `<path>`, delegating to the existing
marking internals (today `runMarkMachineLocal` in
`src/core/commands/clients.js`), hoisted so both the new verb and the aliases
call one implementation:

- `<path>` is **required**. The bare grammar makes it necessary
  (`hyp policy set sync` would be ambiguous between a path and a class), and
  requiring it suits a consent-adjacent surface: say which directory you
  mean. Relative paths resolve against the command-context cwd (`ctx.cwd`),
  matching the sibling verbs, and the resolved directory is marked exactly
  as pointed at (the explicit-path rule the flag forms already apply). The
  target need not exist on disk or be a git repo (LLP 0071 property,
  unchanged). Callers wanting the repo-root default the bare flag forms had
  can pass the repo root; the hook and the skill always pass an explicit
  absolute path already.
- `set <path> ignore` writes a machine-local `ignore` entry (what
  `hyp ignore --private` writes today). It never writes a `.hypignore`
  dotfile; the dotfile author remains bare `hyp ignore` alone. The verb
  split is the point: `policy` is the private, machine-local surface,
  `ignore` is the committable dotfile surface.
- Idempotence and no-op rules carry over verbatim: a target already governed
  at least as restrictively (by either source) is a no-op success naming the
  governor; a `sync` mark is idempotent only against an existing explicit
  machine-local `full` entry, never against the implicit default (LLP 0103).
- Same structured log event (`usage_policy.mark`) with the component
  attribute updated to name the dispatching verb, and the same
  resolver-cache-TTL latency caveat in the output.

### `policy show [path]` {#show}

The successor to `hyp ignore --check`, same behavior, class-neutral name:
resolves `[path]` (default: cwd, preserving `--check`'s ergonomics), prints
the resolved class, the governing source (`dotfile` vs `machine-local` vs
`none`), the governing file, and the residual already-cached row count with
the `hyp purge` hint. Prospective-only reporting, never destructive
(LLP 0049 #prospective-only). `--json` emits the exact field set
`hyp ignore --check --json` emits today, so the check path is a pure rename
plus delegation: `runIgnoreCheck` becomes the shared implementation both
spellings call.

### `policy unset <path> [class]` {#unset}

Removes machine-local markings governing `<path>` (equal to it or an
ancestor, via the shared `isEqualOrDescendant` predicate, not a re-derived
copy). By default it is class-neutral: every machine-local entry governing
the target is removed, "back to the implicit default", which matches the
issue's one-line semantics and the store's one-entry-per-dir shape. An
optional trailing class token scopes removal to that class; this scoped form
is what the `hyp unignore --sync|--local-only|--private` aliases delegate to,
preserving their exact current behavior. `unset` never touches `.hypignore`
dotfiles (that remains bare `hyp unignore`) and never touches cached rows
(LLP 0104 boundary). Idempotent: nothing governing is a no-op success.

### `policy list` {#list}

Enumerates the machine-local store: one line per entry, `dir` and class
(rendering `full` with a `sync` gloss in the human output), plus the store
path, with `--json` emitting `{ entries: [{ dir, class }], path }`. This is
the store's first enumeration surface; `show` answers "what governs this
path", `list` answers "what have I marked on this machine". It deliberately
lists only the machine-local store: `.hypignore` dotfiles are discovered
per-path by the ancestor walk and cannot be enumerated without a filesystem
crawl, and `show` already names them when they govern. An empty store lists
zero entries successfully.

## Compatibility aliases and deprecation posture {#aliases}

`hyp ignore` / `hyp unignore` keep working in every current form, no breaking
release (LLP 0110 boundary):

| old spelling | delegates to |
|---|---|
| `hyp ignore --sync <p>` | `policy set <p> sync` internals |
| `hyp ignore --local-only <p>` | `policy set <p> local-only` internals |
| `hyp ignore --private <p>` | `policy set <p> ignore` internals |
| `hyp ignore --check [p]` | `policy show [p]` internals |
| `hyp unignore --sync\|--local-only\|--private [p]` | class-scoped `policy unset` internals |

- **Delegation, not duplication**: the flag branches in
  `runIgnore` / `runUnignore` call the same hoisted implementations the
  `policy` subcommands call. One behavior, two spellings; the alias behavior
  can never drift from the new verb's.
- **Output-identical**: the aliases keep their exact stdout/stderr and exit
  codes, including the optional-path repo-root defaulting the flag forms
  have today, so every existing test passes unchanged (LLP 0110 exit
  criteria).
- **Deprecation is help-text-only for now**: the `hyp ignore` / `hyp
  unignore` registry help marks the flags "deprecated: use hyp policy ...",
  and no product surface teaches them anymore (see migration below). No
  runtime warning is emitted: the main writers (hook, skill) migrate in this
  same change, and a stderr nag would risk breaking scripted callers for no
  coverage gain. Removal, if ever, is a future breaking-change decision,
  deliberately not scheduled here.
- Bare `hyp ignore [path]`, bare `hyp unignore [path]`: not deprecated at
  all. They are the honest dotfile verbs (LLP 0049 #cli) and stay the only
  authors of `.hypignore`.

## Migrating the teaching surfaces {#teaching}

The issue's trigger was not the flag itself but the surfaces that teach it
during consent-sensitive moments. All of them move to the `policy` spelling:

- **Classification hook copy (LLP 0106)**: `src/core/usage-policy/classification.js`
  is the single shared consent surface. `CLASSIFICATION_CHOICES` swaps its
  `flag` field for the class token, `verbArgvForClass` returns
  `['policy', 'set', targetPath, token]`, and `buildClassificationPrompt`
  prints `hyp policy set <cwd> sync` (etc). Because the hook dispatches the
  argv against the same CLI registry, the two-word `policy set` dispatch
  must be in place first (the existing group-command dispatch already
  handles two-word verbs). The prompt copy is pinned by tests (LLP 0106
  consequences); those pins update in the same commit as the copy.
- **`hypaware-privacy` skill bodies** (claude and codex,
  `hypaware-core/plugins-workspace/*/skills/hypaware-privacy/SKILL.md`):
  every `hyp ignore --sync|--local-only|--private` and
  `hyp unignore --...` occurrence becomes the matching `hyp policy set` /
  `hyp policy unset` form; the dotfile `hyp ignore` mentions stay as they
  are. The exit criterion is literal: neither the hook nor the skill ever
  prints an `ignore`-spelled command for a non-ignore class.
- **`hyp status` and registry help wording**: anywhere status or help output
  points users at the marking flags now points at `hyp policy`.
- **Code `@ref` hygiene**: the `@ref LLP 0103#cli` annotations on the moved
  marking/check/unmark internals keep citing 0103 for the store-and-classes
  rationale, with glosses updated to cite this design for the verb surface
  (LLP 0103 already carries the `Extended-by: LLP 0110` forward-ref).

## Implementable pieces {#pieces}

Ordered so each lands green on its own; this section seeds the plan.

1. **Hoist the marking internals.** Extract the shared implementations
   behind today's flag branches (`runMarkMachineLocal`,
   `runUnmarkMachineLocal`, `runIgnoreCheck`) into verb-agnostic functions
   (target resolution rule, class, output writer) with no behavior change.
   Pure refactor; existing tests stay green.
2. **Register the `policy` group and subcommands.** `makeGroupCommand`
   entry plus `policy set` / `policy show` / `policy unset` / `policy list`
   registrations in `core_commands.js`, arg parsing (positional path and
   class token, token-to-class mapping, mutual-exclusion and usage errors),
   thin runners in `src/core/commands/` delegating to the hoisted
   internals; `policy list` adds the store enumeration read. New tests
   mirror `test/core/ignore-private-sync-command.test.js` for the new
   spellings, plus `list` and class-neutral `unset` coverage.
3. **Turn the flags into delegating aliases.** `runIgnore` / `runUnignore`
   flag branches call the hoisted internals (by construction after piece 1),
   help text gains the deprecation wording, and the existing alias tests run
   unchanged as the compatibility proof.
4. **Migrate the hook copy.** `classification.js` choices, `verbArgvForClass`,
   prompt text, and the pinned consent-copy tests move to
   `hyp policy set <path> <token>`.
5. **Migrate skill and status wording.** Both `hypaware-privacy` SKILL.md
   bodies and any `hyp status` / help strings that teach the flag forms.
6. **Ref and doc hygiene.** Update `@ref` glosses on moved code so the verb
   surface cites this design while the store-and-classes rationale keeps
   citing LLP 0103.

## Risks and edge cases

- **Grammar ambiguity is designed out**: `set` requires the path, so a
  class token can never be mistaken for one; `unset`'s optional trailing
  token is unambiguous because it follows the required path.
- **Alias drift** is prevented structurally (single implementation), not by
  test discipline alone.
- **Hook/CLI version skew**: a session-start hook from this version dispatches
  `policy set` in-process against the same build's registry (the hook and CLI
  ship together), so there is no window where the hook teaches a verb the
  binary lacks.
- **JSON stability**: `policy show --json` keeps the `--check --json` field
  set byte-compatible; `policy list --json` is new and versioned by presence.
