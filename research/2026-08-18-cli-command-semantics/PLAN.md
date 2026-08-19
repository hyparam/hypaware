# Research plan: HypAware CLI command semantics

## Work packages

### WP1: Onboarding, clients, privacy, and enrollment

- **Question:** What exactly do setup, status, ask, session, client, privacy,
  join, and leave do?
- **Method:** Inspect core command registrations and runners, wizard modules,
  client integration modules, usage-policy modules, AI gateway session control,
  tests, and relevant LLPs.
- **Primary sources:** `src/core/cli/`, `src/core/commands/`,
  `src/core/cli/wizard/`, `src/core/usage-policy/`, client integration code,
  `hypaware-core/plugins-workspace/ai-gateway/`, LLPs, root tests.
- **Dependencies:** None.
- **Output:** `work/WP1-onboarding-clients-privacy.md`.
- **Completion test:** Every in-scope command has inputs, reads, writes, side
  effects, requirements, output meaning, failures, and sources.
- **Stop condition:** All registered commands and proposed aliases in this
  family are accounted for, or a named uncertainty is recorded.

### WP2: Query, reports, sync, and remote execution

- **Question:** What exactly do query, report, sync, graph query, vector query,
  and remote-routed verbs do?
- **Method:** Inspect verb registrations, render controls, query execution,
  report runners, sink execution, remote MCP routing, tests, and LLPs.
- **Primary sources:** `src/core/query/`, `src/core/cli/verb_command.js`,
  `src/core/cli/report_commands.js`, `src/core/cli/remote_commands.js`,
  sink modules, context-graph and vector-search plugins, LLPs, tests.
- **Dependencies:** None.
- **Output:** `work/WP2-query-report-sync.md`.
- **Completion test:** Local versus remote behavior, visibility filtering,
  output budgets, state changes, credentials, and destructive report behavior
  are explicit.
- **Stop condition:** Every proposed read/share/movement subcommand is covered.

### WP3: Host administration and development

- **Question:** What exactly do daemon, config, cache, sink maintenance,
  plugin management, MCP serving, version, and smoke commands do?
- **Method:** Inspect command registrations and runners, boot profiles, daemon
  installers and lifecycle modules, cache maintenance, plugin-install modules,
  smoke harnesses, tests, and LLPs.
- **Primary sources:** `src/core/commands/`, `src/core/daemon/`,
  `src/core/cache/`, `src/core/plugin_install/`, `src/core/plugin_doctor/`,
  `hypaware-core/smoke/`, LLPs, tests.
- **Dependencies:** None.
- **Output:** `work/WP3-admin-dev.md`.
- **Completion test:** Platform effects, persistent files, subprocesses,
  destructive actions, boot behavior, and error conditions are explicit.
- **Stop condition:** Every proposed core `admin` and `dev` subcommand is
  covered.

### WP4: Plugin-contributed command semantics

- **Question:** What exactly do Claude account/Desktop, graph maintenance,
  vector status, enrichment, and Gas City commands do?
- **Method:** Inspect plugin manifests, activation registrations, command
  runners, plugin-specific tests, and governing LLPs.
- **Primary sources:** Relevant directories under
  `hypaware-core/plugins-workspace/`, plugin tests, and LLPs.
- **Dependencies:** None.
- **Output:** `work/WP4-plugin-commands.md`.
- **Completion test:** Every bundled plugin command is either mapped to a
  canonical command, retained as an alias, or explicitly classified as hidden.
- **Stop condition:** Manifest declarations and runtime registrations reconcile.

### WP5: Cross-check, interface assessment, and synthesis

- **Question:** Does the proposed command tree accurately name the researched
  behavior, and is every current command covered exactly once?
- **Method:** Build a registration inventory, reconcile WP1-WP4, cross-check
  high-impact claims against tests and LLPs, identify mismatches, then update
  the Markdown and HTML reports.
- **Primary sources:** WP1-WP4, complete registration inventory, CLI registry
  and dispatch code, LLP 0009 and extensions.
- **Dependencies:** WP1-WP4.
- **Output:** `work/WP5-cross-check.md`, `REPORT.md`, and updated temporary HTML.
- **Completion test:** Full coverage matrix has no unexplained command; Markdown
  and HTML agree; `join` and `leave` are top-level everywhere.
- **Stop condition:** All success criteria in `BRIEF.md` pass or a genuine
  blocker is recorded.

## Synthesis and cross-checks

1. Inventory every core registration, intrinsic verb, plugin manifest command,
   and runtime plugin registration.
2. Cross-check destructive or credential-bearing commands using implementation,
   LLP, and tests where available.
3. Check proposed aliases for shared implementation rather than duplicated
   behavior.
4. Apply the deletion test to proposed groups that have only one or two
   subcommands.
5. Mark proposed commands with no current implementation, such as a possible
   `client status`, as new projections rather than existing behavior.

## No spikes or external side effects

No runtime spike is planned. Static code, LLP, manifest, and test inspection is
sufficient and avoids changing user state. Read-only dependency-free tests may
be run only if they materially resolve a contract question.

## Expected limitations

- Server-side report and enrollment behavior is represented through the client
  contract in this repository, not an independent server audit.
- Platform-specific daemon behavior can be traced and test-checked but will not
  be exercised on the live service manager.
- Some failure paths may not define stable numeric exit codes beyond success,
  usage error, and general failure.

## Final report outline

1. Revised proposed command tree.
2. Command-by-command semantic reference.
3. Side-effect and risk index.
4. Requirements and availability index.
5. Current-to-canonical migration matrix.
6. Naming/grouping findings and proposed adjustments.
7. Evidence gaps and implementation/doc mismatches.

## Effort range

Five work packages, expected to require a medium-depth repository study. The
largest cost is plugin and LLP cross-checking, not code execution.
