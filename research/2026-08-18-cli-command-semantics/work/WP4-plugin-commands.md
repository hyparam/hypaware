# WP4: Plugin-contributed command semantics

Status: complete.

## Registration inventory

Bundled manifests declare human commands for these active-config plugins:

| Plugin | Declared current commands |
|---|---|
| `@hypaware/ai-gateway` | `session ignore`, `session unignore`, `session status` |
| `@hypaware/claude-account` | `claude-account credential`, `login`, `logout`, `status` |
| `@hypaware/claude-desktop` | `claude-desktop profile`, `install-helper`, `status`, `install`, `verify` |
| `@hypaware/context-graph` | `graph project`, `compact`, `neighbors` |
| `@hypaware/context-graph-enrich` | `enrich`, `propose`, `curate`, `backfill`, `status` |
| `@hypaware/vector-search` | `vector`, `search`, `status` |
| `@hypaware/gascity` | `gascity attach`, `detach`, `list` |

Runtime also registers hidden `claude-hook session-context` and `claude-hook
classify-cwd`; they are intentionally absent from the Claude manifest command
list and from help. Context graph registers group metadata for `graph`, while
`graph neighbors` is projected from a typed verb. All other bundled plugins
contribute datasets, sources, sinks, capabilities, presets, or assets but no
CLI commands.

## Findings that affect the proposal

- Every plugin command is present only when its plugin is effective-config
  active. Canonical aliases must retain the owning plugin metadata so help and
  inactive-command repairs keep working.
- `claude-account credential` is not hidden today: its manifest declares it and
  its runtime registration lacks `hidden: true`. The proposal's hidden-machine
  exception therefore requires a real manifest/runtime help change, while
  keeping the current spelling and stdout contract callable.
- `gascity attach` and `detach` mutate only the activation context in the
  current one-shot process. They do not write config, and dispatch stops sources
  after the command. Presenting them as durable `admin source gascity` controls
  would overpromise until persistence is implemented.
- `vector search` is not a typed verb. Its canonical query alias cannot gain
  remote transport merely by moving names.
- Enrichment backfill help in the manifest/registration omits implemented
  `--since` and `--dry-run` flags. The reorganized help should correct this.

## Canonical command semantics

### `hyp client claude-account login`

- **Current implementation:** `hyp claude-account login`, available only when
  `@hypaware/claude-account` is active.
- **Mode:** in `org_key` mode it refuses with exit 1 because no user sign-in is
  needed. In subscription mode it requires an interactive input stream.
- **Effects:** creates an OAuth PKCE/state attempt, starts a best-effort
  loopback callback listener, prints and best-effort opens the Claude sign-in
  URL, races browser callback with pasted code, exchanges the code, and writes
  the refreshable credential under a lock in plugin state.
- **Output:** fingerprints, never prints, the stored access token. Browser
  opener failure is nonfatal because the URL remains visible.
- **Failures:** noninteractive use, callback/state/exchange, storage lock, or
  write failure exits 1.
- **Evidence:** `hypaware-core/plugins-workspace/claude-account/src/index.js`,
  `src/oauth.js`, `src/store.js`, LLP 0117, and plugin tests.

### `hyp client claude-account logout`

- **Current implementation:** `hyp claude-account logout`.
- **Effect:** under the credential lock, removes the stored subscription
  credential. It does not revoke it server-side and does not change org-key
  config or environment variables. The current function is idempotent and
  reports signed out.
- **Evidence:** same Claude account sources and LLP 0117.

### `hyp client claude-account status`

- **Current implementation:** `hyp claude-account status`.
- **Reads only:** effective credential mode and either org-key config/env
  presence or the stored subscription record.
- **Output and exits:** in org-key mode reports configured fingerprint or env
  presence; missing key exits 1. In subscription mode reports token fingerprint
  and expiry; signed out or malformed store exits 1. Healthy state exits 0.
- **Evidence:** same Claude account sources.

### Hidden `hyp claude-account credential`

- **Machine contract:** resolves configured org-key or subscription credential,
  including refresh, then writes exactly one JSON line `{ token, headers,
  ttlSec }` to stdout. All diagnostics go to stderr and failure leaves stdout
  empty with exit 1.
- **Consumer:** generated Claude Desktop helper scripts append exactly
  `claude-account credential` to the HypAware binary. Renaming or adding prose
  would break Desktop authentication.
- **Security:** stdout is secret-bearing. It should remain callable but be
  removed from primary/group help. Current code does not hide it, so both the
  manifest declaration and runtime visibility need adjustment.
- **Evidence:** `hypaware-core/plugins-workspace/claude-account/src/index.js`,
  `src/credential.js`, LLP 0116, and LLP 0117.

### `hyp client claude-desktop install [--yes] [--print-commands]`

- **Current implementation:** `hyp claude-desktop install`.
- **Requirements:** macOS for wet application, active gateway plus Anthropic
  credential capabilities, and a stable non-ephemeral gateway endpoint.
  `--print-commands` is allowed off-platform because it changes nothing.
- **Consent:** if not already converged, explains credential custody, helper,
  dialog residue, root-owned managed plist, and restart. It asks once unless
  `--yes`; declining changes nothing and exits 1. Print-only skips consent.
- **Ordered effects:** verifies or runs Claude account login, writes the
  executable credential wrapper, backs up and removes stale Desktop 3P dialog
  residue, writes `/Library/Managed Preferences/com.anthropic.claudefordesktop.plist`
  through an inline sudo sequence, then offers to restart Desktop.
- **Idempotency:** every step rechecks state; a partial/sudo-declined run is
  resumable. `--print-commands` prints all actions without login, file writes,
  sudo, or restart.
- **Failures:** unsupported platform, ephemeral endpoint, declined consent, or
  any incomplete step exits 1 and prints the rerun path.
- **Evidence:** `hypaware-core/plugins-workspace/claude-desktop/src/install.js`,
  `src/consent.js`, LLP 0131, LLP 0133, and LLP 0139.

### `hyp client claude-desktop status`

- **Current implementation:** `hyp claude-desktop status`.
- **Reads only:** resolved base URL, credential mode/auth scheme, helper path
  and existence, model list, and bundle ID. It points to Claude account status
  for credential health.
- **Exit:** helper present is 0; absent or input-resolution failure is 1. It
  does not check the root-owned plist or dialog residue.
- **Evidence:** `hypaware-core/plugins-workspace/claude-desktop/src/index.js`.

### `hyp client claude-desktop verify`

- **Current implementation:** `hyp claude-desktop verify`.
- **Reads only:** on macOS, compares the managed plist with current desired
  content and checks that dialog residue is absent.
- **Output and exit:** these automatic checks drive exit 0/1. It also prints a
  human in-app test: restart Desktop, send a message, and check recent gateway
  entrypoints via overall status. That step is advisory and never automated.
- **Failures:** non-macOS and input/read errors exit 1.
- **Evidence:** `hypaware-core/plugins-workspace/claude-desktop/src/verify.js`,
  LLP 0131, LLP 0133, and LLP 0164.

### `hyp admin client claude-desktop profile [--plist] [--out <path>]`

- **Current implementation:** `hyp claude-desktop profile`.
- **Reads and output:** resolves endpoint, model, bundle, credential mode, and
  helper path, then renders secret-free JSON by default or a managed-preference
  plist dict with `--plist`. With `--out`, writes the rendered profile;
  otherwise stdout is the artifact.
- **Boundary:** warns but succeeds when the helper is missing. It does not
  install the root plist or helper itself.
- **Failures:** missing out value or resolution/write error currently exits 1,
  not usage exit 2.
- **Evidence:** `hypaware-core/plugins-workspace/claude-desktop/src/index.js`,
  `src/profile.js`, and LLP 0116.

### `hyp admin client claude-desktop install-helper [--path <path>]`

- **Current implementation:** `hyp claude-desktop install-helper`.
- **Writes:** renders a no-argument executable shell wrapper that invokes the
  current Node binary and HypAware binary with `claude-account credential`.
  Defaults outside TCC-protected paths under plugin state; creates parent dirs
  and sets mode 0755.
- **Output and failures:** prints wrapper path and profile guidance. Missing
  path value or filesystem error exits 1.
- **Evidence:** `hypaware-core/plugins-workspace/claude-desktop/src/index.js`
  and LLP 0116.

### `hyp admin graph project [--source <dataset>] [--dry-run]`

- **Current implementation:** `hyp graph project`.
- **Reads and writes:** runs every registered deterministic projection contract,
  or contracts for one exact source dataset, over recorded datasets into the
  derived `node` and `edge` tables. It is idempotent. Dry-run reports counts
  and commits nothing.
- **Output:** source with no contract and globally empty contract registry are
  successful informational outcomes. Wet success reports projected and newly
  written node/edge counts.
- **Failures:** malformed/unknown flags and positionals exit 2; projection/cache
  failure exits 1.
- **Evidence:** `hypaware-core/plugins-workspace/context-graph/src/command.js`,
  `src/project.js`, LLP 0023, and LLP 0214.

### `hyp admin graph compact [--dry-run]`

- **Current implementation:** `hyp graph compact`.
- **Writes:** merges duplicate node/edge rows and rewrites affected partitions
  into sorted replacement tables. It is performance maintenance, not required
  for correctness and not a projection.
- **Output and exit:** dry-run reports duplicates/partitions without writes.
  Concurrent-write skips are retry-later success; unreadable cursor skips or a
  thrown compaction failure exit 1.
- **Parser caveat:** current runner checks only for `--dry-run`; other tokens are
  silently ignored. Canonical implementation should validate argv.
- **Evidence:** same context graph command/maintenance sources and LLP 0064.

### `hyp admin vector status [--json]`

- **Current implementation:** `hyp vector status`.
- **Reads only:** configured vector indexes and every local shard's partition,
  state, rows, dimension, model, and build time. It does not refresh.
- **Requirements:** active vector plugin, valid config, and embedder capability
  because activation resolves them before command dispatch.
- **Output and failures:** no indexes or no partitions is success. Runtime/status
  failure exits 1. Current parser treats any presence of `--json` as JSON and
  ignores unknown extra arguments.
- **Evidence:** `hypaware-core/plugins-workspace/vector-search/src/commands.js`,
  `src/status.js`, and LLP 0024.

### `hyp admin enrichment propose`

- **Current implementation:** `hyp enrich propose`.
- **Effect:** runs one synchronous T1 ongoing-regime tick over newly settled
  sessions and writes extracted prospect rows plus watermarks. It can call the
  configured completion model, so text may leave the machine according to that
  provider's configuration.
- **Output and failures:** reports candidates, sessions processed, and
  prospects written; errors exit 1. Current runner ignores argv.
- **Evidence:** `hypaware-core/plugins-workspace/context-graph-enrich/src/commands.js`,
  `src/propose.js`, and LLP 0028.

### `hyp admin enrichment curate`

- **Current implementation:** `hyp enrich curate`.
- **Effect:** synchronously clusters pending prospects, calls the completion
  provider, and appends resolution and committed-knowledge rows. Rejected or
  skipped prospects do not reach the graph. A later graph projection is needed.
- **Output and failures:** processed/pending, calls, clusters, and decision
  counts; errors exit 1. Current runner ignores argv.
- **Evidence:** same enrichment command plus `src/curate.js` and LLP 0028.

### `hyp admin enrichment backfill [flags]`

- **Current implementation:** `hyp enrich backfill`.
- **Inputs:** mutually exclusive `--propose-only` and `--curate-only`, optional
  `--since YYYY-MM-DD` for the curate pool, and `--dry-run`. `--since` with
  propose-only is invalid.
- **Effect:** by default proposes over all history, then curates the whole
  pending pool through the provider Batch API and polls to completion. Providers
  without batch support fall back to synchronous curation. The Batch API may
  take up to 24 hours. `--dry-run` prevents batch submission but, unless
  `--curate-only`, the preceding propose phase still writes prospects.
- **Important wording:** this means `--dry-run` is not globally write-free.
  Help should say it is a curate submission dry-run or implementation should
  make it cover proposal writes too.
- **Output and failures:** batch progress and decision totals, then graph
  projection guidance. Usage exits 2; operation/provider failure exits 1.
- **Evidence:** `hypaware-core/plugins-workspace/context-graph-enrich/src/commands.js`,
  `src/batch.js`, and LLP 0028.

### `hyp admin enrichment status`

- **Current implementation:** `hyp enrich status`.
- **Reads only:** session watermark state and counts in prospects, resolutions,
  and committed datasets. Missing datasets count as zero where the helper
  permits it.
- **Output and failures:** reports derived pending count; query/state failure
  exits 1. Current runner ignores argv.
- **Evidence:** enrichment command and state sources.

### `hyp admin source gascity attach <city> [--api-url <url>]`

- **Current implementation:** `hyp gascity attach`.
- **Current effect:** mutates the plugin activation context's in-memory `cities`
  array, then starts or reloads the Gas City subscription source. It does not
  write the local config. Because one-shot dispatch stops started sources on
  return, the attachment is not durable across commands or daemon restarts.
- **Output and failures:** reports attached even for an existing city, updating
  its in-memory API URL. Parse errors exit 2. Source start/reload errors are not
  caught locally and become dispatch failures.
- **Proposal implication:** either rename these as transient run controls or,
  preferably, add a validated local-config write before teaching them as source
  administration.
- **Evidence:** `hypaware-core/plugins-workspace/gascity/src/commands.js`,
  `src/index.js`, and `src/core/cli/dispatch.js` cleanup.

### `hyp admin source gascity detach <city>`

- **Current implementation:** `hyp gascity detach`.
- **Current effect:** removes the city only from the in-memory activation
  config and reloads an already started source. If the source has not started,
  it is an in-memory no-op that still prints detached. Extra arguments are
  currently ignored.
- **Persistence gap:** same as attach; it does not edit config.
- **Evidence:** same Gas City sources.

### `hyp admin source gascity list`

- **Current implementation:** `hyp gascity list`.
- **Reads only:** the current activation context's effective city list and
  optional API URLs. Before a transient change, this reflects loaded config.
  The current runner ignores arguments.
- **Evidence:** same Gas City sources.

## Existing group-only commands

Current `hyp vector` and `hyp enrich` are executable group help commands that
print their subcommands and return 0. `graph` instead registers group metadata,
so dispatch synthesizes group help without a bare runtime command. The proposed
`query vector`, `admin enrichment`, and `admin graph` groups should use one
consistent metadata-driven help model rather than retain executable help-only
commands.

## Hidden internal commands

- `claude-hook session-context --state-file <absolute-path>` appends Claude
  session context for projector attribution.
- `claude-hook classify-cwd` runs the session-start folder classification hook
  for an enrolled machine.

Both are runtime `hidden: true`, generated-hook contracts, and should keep
their current spellings outside the canonical human tree. They must still be
covered by alias/dispatch regression tests because client settings invoke them.

Evidence: `hypaware-core/plugins-workspace/claude/src/index.js`, LLP 0106, and
Claude attach/hook tests.
