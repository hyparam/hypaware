# LLP 0112: hyp policy verb implementation plan

**Type:** plan
**Status:** Active
**Systems:** CLI, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-16
**Related:** LLP 0111
**Generated-by:** neutral

> Task breakdown for the `hyp policy set/show/unset/list` command group and
> the migration of every surface that taught the `hyp ignore --sync` misnomer.
>
> @ref LLP 0111 [implements] - refines its "Implementable pieces" section into ordered, independently-mergeable tasks
> @ref LLP 0110 [implements] - each task keeps the issue's exit criteria: aliases output-identical, no consent surface prints an ignore-spelled command for a non-ignore class

## Framing

LLP 0111 fixes the shape of the change: a new `policy` command group that
owns machine-local usage-class markings, with the existing `hyp ignore` /
`hyp unignore` flags surviving as delegating compatibility aliases, and
every teaching surface (classification hook, hypaware-privacy skill, status
and help copy) moved to the new spelling. The store, resolver, and class
lattice are untouched.

The tasks below follow the design's ordering rule: hoist shared internals
first so both spellings can call one implementation, register the verb, then
rewire aliases and teaching copy, and finish with ref hygiene. Every task
lands with `npm test` green on its own; nothing depends on an unmerged
sibling except where `deps` says so.

Key code locations: the marking internals (`runMarkMachineLocal`,
`runUnmarkMachineLocal`, `runIgnoreCheck`) live in
`src/core/commands/clients.js`; command registration and the
`makeGroupCommand` pattern live in `src/core/cli/core_commands.js`; the
consent hook copy lives in `src/core/usage-policy/classification.js` with
pinned tests in `test/core/usage-policy-classification.test.js`; the skill
bodies are `hypaware-core/plugins-workspace/{claude,codex}/skills/hypaware-privacy/SKILL.md`.

## Tasks

- id: T1  branch: task/hyp-policy-verb/T1  deps: []            complexity: 3  -- Hoist the marking internals out of the flag branches: extract runMarkMachineLocal, runUnmarkMachineLocal, and runIgnoreCheck in src/core/commands/clients.js into verb-agnostic shared implementations (explicit target-resolution rule, class, output writer) that both the flag forms and the future policy runners can call. Pure refactor, zero behavior change; all existing ignore/unignore tests stay green unchanged. Carry the existing @ref LLP 0103#cli annotations along with the moved code (gloss updates come in T6).
- id: T2  branch: task/hyp-policy-verb/T2  deps: [T1]          complexity: 3  -- Register the policy command group: makeGroupCommand entry plus policy set / show / unset / list registrations in src/core/cli/core_commands.js and thin runners in src/core/commands/ delegating to the T1 internals. Includes positional parsing (required path for set, optional for show, required path plus optional trailing class for unset), the sync->full token mapping at the CLI edge with unknown-token usage errors (exit 2) naming the three valid tokens, class-neutral unset, the new list enumeration over the machine-local store with --json {entries, path}, and show --json byte-compatible with today's --check --json fields. New tests mirroring test/core/ignore-private-sync-command.test.js for the new spellings plus list and class-neutral unset coverage. Annotate the new verb code with // @ref LLP 0110 [implements], // @ref LLP 0111#surface [implements], and // @ref LLP 0103#cli [constrained-by] where the store-and-classes rationale applies.
- id: T3  branch: task/hyp-policy-verb/T3  deps: [T2]          complexity: 4  -- Turn the ignore/unignore flags into delegating aliases: the --sync/--local-only/--private/--check branches in runIgnore/runUnignore call exactly the T1 hoisted implementations the policy runners call, with the flag forms' optional-path repo-root defaulting preserved at the alias edge. Registry help for hyp ignore/hyp unignore gains "deprecated: use hyp policy ..." wording; no runtime stderr warning. The hard part is proving zero behavior change: every existing alias test must pass unchanged (stdout, stderr, exit codes, JSON fields, usage_policy.mark log event) as the compatibility proof required by LLP 0110's exit criteria. Add // @ref LLP 0111#aliases [implements] on the delegation seam.
- id: T4  branch: task/hyp-policy-verb/T4  deps: [T2]          complexity: 4  -- Migrate the classification hook copy (LLP 0106): in src/core/usage-policy/classification.js swap CLASSIFICATION_CHOICES flag fields for class tokens, make verbArgvForClass return ['policy','set',targetPath,token], and update buildClassificationPrompt to print hyp policy set <cwd> <token>. This is consent-sensitive copy: the pinned consent-copy tests in test/core/usage-policy-classification.test.js update in the same commit, and the hook must dispatch the new argv against the registry's two-word policy set path (present since T2). Update the file's @ref glosses to cite LLP 0111#teaching for the verb surface. Exit criterion: the hook never prints an ignore-spelled command for a non-ignore class.
- id: T5  branch: task/hyp-policy-verb/T5  deps: [T2]          complexity: 4  -- Migrate the skill and status/help teaching copy: in both hypaware-privacy SKILL.md bodies (claude and codex plugins-workspace trees) replace every hyp ignore --sync/--local-only/--private and hyp unignore --<class> occurrence with the matching hyp policy set / hyp policy unset form, while leaving the dotfile bare hyp ignore/hyp unignore mentions untouched; sweep hyp status output and any remaining help strings that point users at the marking flags. Consent-sensitive judgment call per occurrence (which mentions are class markings vs dotfile authorship); the literal exit criterion is that no product surface teaches an ignore-spelled command for a non-ignore class. Keep both SKILL.md bodies consistent with each other.
- id: T6  branch: task/hyp-policy-verb/T6  deps: [T3, T4, T5]  complexity: 2  -- Ref and doc hygiene sweep: update @ref glosses on all moved and new code so the verb surface cites LLP 0111 (and LLP 0110 where the issue's boundary is the point) while the store-and-classes rationale keeps citing LLP 0103#cli; verify LLP 0103's Extended-by: LLP 0110 forward-ref still reads correctly; run /ref-check across the touched files and fix any dangling anchors. No behavior change; npm test and ref-check both green.

## Notes for implementers

- Repo prose style applies everywhere, including help text and SKILL.md
  edits: no em dashes; runtime strings prefer "-".
- Idempotence and no-op rules (already-governed no-op success naming the
  governor, sync idempotent only against an explicit machine-local full
  entry) are behavior carried by the T1 internals; T2 and T3 must not
  reimplement them at the edges.
- policy unset shares the existing isEqualOrDescendant predicate; do not
  re-derive the ancestor check.
- The usage_policy.mark structured event keeps its shape; only the component
  attribute names the dispatching verb (T2 for policy, unchanged for the
  aliases in T3).
