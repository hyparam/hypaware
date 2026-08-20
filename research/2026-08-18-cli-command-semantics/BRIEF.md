# Research brief: HypAware CLI command semantics

## Seed topic

Research and explain exactly what every command in the proposed HypAware CLI
reorganization does. Keep `join` and `leave` as top-level commands.

## Primary research question

For every proposed canonical CLI command and subcommand, what behavior does the
current HypAware implementation actually provide, and how should that behavior
be described accurately in the reorganized CLI interface?

## Purpose

Produce an evidence-backed command reference that can be used to judge and
refine the proposed CLI organization before implementation. The immediate
decision is whether each proposed command name and group truthfully represents
the behavior hidden behind its interface.

## Audience and deliverables

Primary audience: HypAware maintainers designing the CLI.

Deliverables:

1. `REPORT.md`, a complete command-semantics reference.
2. An updated temporary HTML architecture report containing the researched
   command descriptions and the decision to keep `join` and `leave` top-level.
3. A migration appendix mapping every current spelling to its proposed
   canonical spelling or intentional hidden/internal status.

## Subquestions

For each command:

1. What inputs and flags does it accept?
2. What does it read?
3. What local or remote state can it write or delete?
4. What external side effects can it trigger?
5. Which plugins, configuration, credentials, daemon state, TTY state, or
   platform capabilities does it require?
6. What does success output mean?
7. What are the important failure modes and exit-code semantics?
8. Which LLPs, tests, and implementation files establish the contract?
9. Does the proposed canonical name accurately describe that contract?

## In scope

- All proposed canonical top-level commands: `setup`, `status`, `ask`, `query`,
  `report`, `sync`, `session`, `client`, `privacy`, `join`, `leave`, `admin`,
  and `dev`.
- Every proposed subcommand, including commands contributed by bundled plugins.
- Current aliases and proposed compatibility aliases.
- Hidden machine commands such as `claude-account credential` where needed to
  explain why they should stay outside the human-facing interface.
- Core dispatch, boot-profile, plugin-activation, and remote-routing behavior
  that materially changes command semantics.
- Relevant LLPs and deterministic tests.

## Out of scope

- Implementing the CLI reorganization.
- Editing accepted LLP decisions or `CONTEXT.md`.
- Exercising destructive commands against real user state.
- Running enrollment, OAuth, daemon installation, client attachment, sync,
  purge, report publication/deletion, or plugin installation/removal.
- Auditing the out-of-tree HypAware server implementation beyond the client
  contracts recorded in this repository.
- Re-documenting every internal helper function when it does not affect the
  command interface.

## Evidence bar

- Implementation code is the primary source for current behavior.
- LLPs establish settled rationale and invariants.
- Tests cross-check important edge cases, destructive behavior, compatibility,
  and output contracts.
- Help strings and manifests are supporting evidence, not sufficient by
  themselves when implementation differs.
- Important claims should have at least implementation plus either an LLP or a
  test where such evidence exists.
- Any mismatch between code, help, tests, and LLPs must be reported explicitly.

## Constraints and side effects

- Repository guidance and no-em-dash style apply to all durable artifacts.
- Research is local and read-only except for files under this study directory
  and the temporary HTML report.
- No network access is needed.
- No command may mutate HypAware configuration, daemon state, clients, cached
  data, plugins, remote credentials, or reports.
- The checkout currently lacks at least one runtime dependency (`hyparquet`),
  so static inspection is the default and any executable validation must remain
  dependency-free and read-only.

## Success criteria

- Every proposed canonical subcommand has an exact, concise semantic record.
- Every current registered core and bundled-plugin command is accounted for.
- Side effects and destructive behavior are unmistakable.
- Top-level `join` and `leave` appear in the proposed help and command tree.
- The HTML report and Markdown report agree.
- Uncertainties and contract mismatches are visible rather than silently
  resolved.

## Known unknowns

- Whether some proposed groupings, especially plugin operations beneath
  `admin`, require a new typed registry extension point.
- Whether `client status` can be projected cleanly from existing overall status
  without creating a second state calculation.
- Whether all current commands have stable exit-code contracts or only
  human-readable error behavior.
