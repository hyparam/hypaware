# WP2: Query, reports, sync, and remote execution

Status: complete.

## Findings that affect the proposal

- `query` should remain read-oriented. Moving status, forced refresh, and
  maintenance to `admin cache` matches their actual mutation and operator
  posture.
- `graph neighbors` is already a typed verb, so a canonical `query graph
  neighbors` alias can keep local/remote execution and the `graph_neighbors`
  MCP tool without duplicating logic.
- `vector search` is a bespoke plugin command, not a typed verb. It currently
  has no `--remote`, no `--output`, and no local-only visibility control.
  Moving it under `query vector` is only a naming alias unless it is first
  converted to a verb.
- Reports combine one local build command with four server-only commands. That
  is coherent as a workflow, but the local/remote boundary must be explicit.
- `sync` is more than "run sinks now": it is the attended consent surface that
  can end the first-sync review window.

## Shared verb behavior

`query sql` and `graph neighbors` use the typed verb adapter. The adapter strips
kernel controls before parsing operation parameters:

- `--format table|json|jsonl|markdown`
- `--json` as a friendly JSON shorthand where the verb honors it
- `--output`/`-o`, `--max-cell`, and `--max-bytes`
- `--refresh never|auto|always`
- `--remote [target]`

Bare `--remote` selects `query.default_remote`, then the shipped default.
`--remote <name>` selects that target. Local execution receives the caller cwd
for privacy filtering. Remote execution calls the matching MCP tool with the
stored credential, but uses the same renderer. Explicit `--refresh` with
`--remote` is rejected because freshness belongs to the server. Usage errors
exit 2, operation/transport/render/write failures exit 1 unless the remote
client supplies a more specific exit code. Server result caps and client
display-budget truncation are reported separately on stderr.

Evidence: `src/core/cli/verb_command.js`, `src/core/cli/verb_codec.js`,
`src/core/mcp/remote_verb.js`, LLP 0033, LLP 0034, LLP 0062, and LLP 0105.

## Canonical command semantics

### `hyp query overview [--days <n>] [--json] [--sql] [--include-local-only]`

- **Reads:** local `ai_gateway_messages` only. It summarizes token volume by
  provider/model, sessions and tokens per day, repositories, and tools.
- **Window:** automatically narrows to fit the query budget and always reports
  the chosen window. `--days` pins a positive window. `--sql` prints the
  underlying teaching queries. `--include-local-only` is the explicit
  transcript-exposure override.
- **Output:** human tables or one JSON object. Freshness and withheld-row
  notices go to stderr.
- **Requirements and failures:** the gateway dataset must be registered;
  otherwise exits 1 with setup guidance. Parse errors exit 2 and query/budget
  failures exit 1. The command is deliberately local-only and does not accept
  remote execution.
- **Evidence:** `src/core/commands/query.js`, `src/core/query/overview.js`, LLP
  0056, LLP 0105, and LLP 0135.

### `hyp query sql <select...> [controls] [--include-local-only]`

- **Reads:** a single read-only SELECT over registered local datasets, or the
  remote server's `query_sql` tool when `--remote` is present.
- **Freshness:** local default is auto refresh; `--refresh` can select never or
  always. Remote refresh is server-owned.
- **Privacy:** caller cwd is classified and local-only rows are filtered or
  content-suppressed at the shared query seam. The count is never silent.
  `--include-local-only` opts into their content and warns that a captured
  session can forward the resulting transcript.
- **Output:** bounded table by default, plus JSON, JSONL, Markdown, or a file.
  `--max-cell 0` and `--max-bytes 0` lift the respective inline caps.
- **Failures:** non-SELECT, multiple statements, unknown datasets, budget
  refusal, remote auth/transport errors, bad flags, and output write failures.
  Usage errors exit 2; execution/render failures exit 1.
- **Evidence:** `src/core/query/verb.js`, `src/core/query/sql.js`,
  `src/core/query/format.js`, LLP 0003, LLP 0056, and LLP 0105.

### `hyp query schema <dataset>`

- **Reads only:** the registered dataset schema. It does not inspect table
  files or refresh data.
- **Output:** rendered columns when registered. An unregistered dataset prints
  an explanatory placeholder and currently exits 0, which is friendly for
  discovery but weak for scripts.
- **Failures:** missing dataset exits 2.
- **Evidence:** `src/core/commands/query.js` and `src/core/query/schema.js`.

### `hyp query graph neighbors <node> [flags]`

- **Current implementation:** `hyp graph neighbors`; typed MCP tool name stays
  `graph_neighbors`.
- **Inputs:** required seed, `--type`, positive `--depth` (default 1),
  `--direction out|in|both` (default both), repeatable/comma-separated
  `--edge-type`, positive `--limit` (default 100), `--json`,
  `--include-local-only`, and shared remote/render controls.
- **Resolution and reads:** resolves the seed by node ID, then natural key,
  then label; `--type` narrows ambiguity. It breadth-first walks the published
  `node` and `edge` datasets. It does not project or compact them.
- **Output:** BFS-ordered neighbors, edge direction, hop, and truncation. JSON
  carries full IDs; shortened text IDs are display-only. Ambiguity and not
  found go to stderr. Empty graph guidance names the projection command.
- **Privacy and remote:** uses the shared local-only filter and typed verb
  remote path. `--include-local-only` has the same transcript warning as SQL.
- **Failures:** unresolved/ambiguous seed exits 1; usage errors exit 2; normal
  empty-neighbor result succeeds.
- **Evidence:** `hypaware-core/plugins-workspace/context-graph/src/verb.js`,
  `hypaware-core/plugins-workspace/context-graph/src/query.js`, LLP 0034, LLP
  0064, LLP 0105, and LLP 0214.

### `hyp query vector search <query> [flags]`

- **Current implementation:** `hyp vector search`, contributed by active
  `@hypaware/vector-search`.
- **Inputs:** greedy query text, optional `--index`, `--dataset`, positive
  `--top-k`/`-k` (default 10), `--no-refresh`, format, `--max-cell`, and
  `--max-bytes`.
- **Reads and effects:** searches configured vector shards. Default auto
  refresh can update stale/missing local indexes and invoke the configured
  embedder, which may make a network call. `--no-refresh` prevents rebuild.
- **Output:** score, index, partition, id, and text with the same inline display
  budgets as SQL. Progress and truncation notices go to stderr.
- **Requirements:** active vector plugin, valid index config, a
  `hypaware.embedder` capability, and local cache partitions.
- **Important gap:** not a typed verb, so no `--remote`, `--output`, or
  caller-context local-only filtering exists today. The proposed help must not
  imply those capabilities until implementation changes.
- **Failures:** no configured indexes is currently treated as usage exit 2;
  other search/embed/index failures exit 1.
- **Evidence:** `hypaware-core/plugins-workspace/vector-search/src/commands.js`,
  `src/search.js`, and LLP 0024.

### `hyp report render [dir] [--no-refresh-assets]`

- **Local only:** defaults to `~/hypaware-reports`, discovers top-level report
  Markdown, and deterministically rebuilds derived `html/` pages and
  command-owned assets. It never changes source Markdown or the user-owned
  `assets/theme.css`.
- **Destructive boundary:** rebuilding wipes and regenerates derived `html/`,
  but refuses an empty report tree before doing so. `--no-refresh-assets`
  preserves the command-owned asset copies.
- **Output and failures:** prints report count and destination. Missing/non-dir
  input exits 2, no reports or build failure exits 1.
- **Evidence:** `src/core/cli/report_commands.js`, `src/core/reports/render.js`,
  and LLP 0196.

### `hyp report publish <file-or-dir> --kind <kind> --period <period> [flags]`

- **Server only:** resolves `--remote <target>` or the effective default and
  requires a write-capable stored/env credential. `--org` is for an operator
  credential; a scoped token pins its own org.
- **Validation and reads:** requires explicit validated kind and period. A
  single file must be HTML or Markdown. A directory must contain root
  `report.html` or `report.md` and is packaged as a gzip ustar bundle using the
  system `tar`.
- **Remote effect:** POSTs the artifact to the org reports plane. A SHA-256
  content hash provides retry idempotency; identical content returns the
  existing report rather than adding a duplicate.
- **Output:** distinguishes newly published from already present and prints the
  canonical kind/period/id locator.
- **Failures:** input/target validation exits 2; filesystem, packing, auth,
  transport, refresh, or server rejection exits 1 or the remote credential
  helper's specific code.
- **Evidence:** `src/core/cli/report_commands.js`,
  `src/core/remote/credentials.js`, and LLP 0155.

### `hyp report list [filters] [--json] [--remote <target>]`

- **Server only and read-only:** GETs newest-first org reports with optional
  kind, period, limit, before cursor, org, and target filters.
- **Output:** a JSON array or tabular publishedAt, kind/period, id, bytes, and
  title. Empty results are success with publish guidance.
- **Failures:** target/flag problems exit 2; auth, transport, or server errors
  exit nonzero.
- **Evidence:** `src/core/cli/report_commands.js` and LLP 0155.

### `hyp report get <kind> <period> <id> [path] [--output <file>] [flags]`

- **Server only and read-only:** fetches the entry document by default or one
  named artifact. Path segments are encoded without collapsing separators.
- **Output:** exact bytes to stdout, including binary artifacts, or to the
  requested file. A file write confirmation goes to stderr so stdout remains
  clean.
- **Failures:** missing locator/output value/target exits 2; auth, transport,
  server, and local write failures exit nonzero.
- **Evidence:** `src/core/cli/report_commands.js` and LLP 0155.

### `hyp report delete <kind> <period> <id> [--yes] [flags]`

- **Destructive remote effect:** tombstones the org report and deletes its
  artifacts. A publish-scope holder can delete any report in its org; this is
  unrecoverable.
- **Confirmation:** asks on a TTY and requires `--yes` without one. Declining
  succeeds. Non-TTY without `--yes` exits 2.
- **Output and failures:** success names the deleted locator. Target/usage
  errors exit 2; auth, transport, and server rejection are nonzero.
- **Evidence:** `src/core/cli/report_commands.js` and LLP 0155.

### `hyp sync [sink-instance] [--yes|-y] [--dry-run]`

- **Reads:** instantiated sinks, their destination configuration, local-only
  directory/client exclusions, and the first-sync hold marker.
- **Plan:** always prints every destination in scope, whether it appears to
  leave the machine, and the exclusions that will not travel. Destination
  server URLs are rendered by configured name with a pointer to remote list.
- **Confirmation and effect:** every wet run confirms unless `--yes`, then
  performs a forced manual sink-driver tick. `--dry-run` prints the plan and
  sends nothing.
- **First-sync rules:** while the review hold exists, a wet run cannot name one
  sink and cannot use `--yes`. Only an interactive all-destination confirmation
  can remove the hold early. The marker is removed before the tick; a later
  export failure does not restore the review window.
- **Output:** one result per sink with status, partitions, bytes, and error.
  No sinks is success. Unknown instance exits 1. Parse/confirmation posture
  errors exit 2. Hold removal, driver hold, or any sink failure exits 1.
- **Evidence:** `src/core/commands/sync.js`, `src/core/sinks/driver.js`, LLP
  0100, LLP 0101, and LLP 0188.

## Remote execution boundary

The normal local command boot activates only config-selected plugins. Plugin
verbs exist only when their owner is active. Top-level help reads manifest
declarations without activation, but still filters to effective-config-active
plugins. A request for a known inactive plugin command reports which plugin
owns it and prints a layer-aware repair instead of saying "unknown".

Query/report remote calls use named targets from config plus shipped defaults.
Target credentials live in the state directory's permission-restricted store
or target-specific environment variables, never in config. Static tokens and
refreshable OIDC sessions share that resolution path. The server remains
authoritative for credential scope and org access.

Evidence: `src/core/cli/dispatch.js`, `src/core/cli/remote_commands.js`,
`src/core/remote/credentials.js`, LLP 0033, LLP 0058, LLP 0062, LLP 0153, and
LLP 0154.
