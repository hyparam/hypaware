# LLP 0602: Repair legacy Codex provider identities with backups

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Config, Backfill
**Author:** Phil / Codex
**Date:** 2026-11-03
**Related:** LLP 0429, LLP 0432, LLP 0150

## Offline repair {#repair}

Codex 0.166.0 requires a saved chat's provider to equal the active provider,
even when an unselected compatibility provider routes to the same native
OpenAI endpoint. An alias alone no longer preserves resumability.

The repair is a one-time, offline operation, also available explicitly as
`hyp codex repair`. It changes
only `hypaware` provider identities to `openai` in native rollout metadata
and the corresponding `threads.model_provider` cells. It preserves thread
IDs, history, titles, timestamps, permissions, and the user's configuration.
Both active and archived rollouts are eligible, including compressed
rollouts when the running Node has built-in Zstandard support. The automatic
upgrade path below reuses this same operation and its backups.

The command asks Codex's own parser to read a private temporary copy of the
configuration, without copying auth files or inheriting credentials. Native
state and logs are redirected to that temporary directory. Repair is admitted
only for the default OpenAI selection and HypAware's unchanged direct
OpenAI compatibility alias, validated by parsed settings without depending on
a comment marker. The alias name must remain `OpenAI`, since Codex gives that
name native OpenAI endpoint and authentication behavior. Custom endpoints, profiles, managed custom
providers, and remote thread stores are refused. The native `sqlite_home` and
`CODEX_SQLITE_HOME` locations are respected. The source config hash is checked
again before mutation; configuration and credentials are never rewritten.

## Automatic upgrade migration {#automatic}

The first scheduled transcript sweep after the upgraded HypAware daemon
starts attempts the repair, after the existing gateway-route cleanup. It does
not run from npm install scripts, plugin activation, queries, manual imports,
dry runs, or gateway capture. The runner's recording switch still applies:
detached clients are not reattached or scanned by this migration. A customer
without a running daemon can use the explicit command.

While any Codex Desktop or CLI process is running, the migration defers before
config parsing or history discovery and checks again on the next scheduled
sweep (normally one minute). It never closes a customer's app or interrupts a
turn. A client can start after a process check, so the offline requirement is
also checked before publication, alongside source hashes and SQLite locks;
this is not a native lock preventing a new Codex process from starting.

Success, including no affected chats, writes a private durable
`codex-provider-repair.json` receipt in the plugin state directory, bound to
the canonical Codex home. Later sweeps and daemon restarts skip native config
parsing and history discovery. An explicit restore does not remove that receipt,
so the automatic migration never immediately reverses the customer's undo.

Automatic repair admits at most 1 GiB of affected rollout bytes plus native
database and WAL bytes, and uses a cooperative 30-second cancellation deadline.
Streaming reads and writes observe cancellation; individual filesystem calls
and synchronous SQLite operations must finish before it can be observed. Native
configuration RPCs have their own 15-second request timeout.
Cancellation during publication uses the same rollback as other failures.
Large histories remain repairable with the manual command. A non-running-client
failure stops further automatic attempts for that daemon lifetime, emits a
secret-safe warning pointing at the manual command, and does not stop capture.
A restarted daemon can retry. Repeated unchanged running-client deferrals are
logged once per daemon lifetime.

## Backups and failure recovery {#backups}

Applying repair or restore requires all Codex CLI and Desktop processes to be
closed. Process discovery fails closed if it cannot run. An exclusive repair
lock prevents overlapping repairs. SQLite write transactions and repeated
source checks protect the publication phase from concurrent changes.

Before any original is replaced, the repair writes private, durable backups
under `CODEX_HOME/hypaware-provider-repair/backup-*`: complete original
rollouts, SQLite snapshots including committed WAL frames, and a hash-checked
manifest recording original identities and publication status. All replacement
rollouts are staged and synced before publication. The repair streams history
and changes only its first metadata record; the remaining decoded bytes are
preserved. Metadata updates leave every other native column untouched.

A reported publication failure reverses changed files and provider cells.
A reported failure before publication removes that attempt's backup
instead, since nothing it protects was changed.
After a crash, an incomplete receipt requires explicit restoration before
another repair. `--restore <backup-path>` restores unchanged repaired files
and the affected metadata cells. It refuses a rollout with newly appended
content and never replaces an entire live database over later customer work.
The full database snapshot remains available for disaster recovery. A normal
successful rerun finds no affected identities and creates no new backup.

## Cost and validation {#validation}

This is one-time maintenance, outside per-record capture hot paths. Discovery streams at
most 100,000 directory entries, retains at most 10,000 affected rollouts and
10,000 metadata rows, and opens at most 16 state databases. Provider selection
uses the native index and rollout matches use a map, avoiding a cross-product
scan. Header parsing is bounded to 1 MiB. Full history copies, hashes, and
rewrites stream one file at a time. A manifest is limited to 8 MiB. No runtime
dependency, configuration key, database column, or uptime-dependent map is
introduced.

Regression coverage must prove WAL-aware backups, restoration, failure
rollback, later-message protection, compressed archives, unchanged custom
routes, idempotence, automatic deferral, completion across restarts, cancellation,
and the command and automatic migration telemetry. The installed-client
check uses synthetic history and real native metadata, reproduces the 0.166
mismatch, runs the automatic repair, and resumes the same thread on `openai` with no
provider override. A follow-up turn completes against a synthetic local
Responses endpoint. Both checks also run against Desktop's bundled app server.

A bundled app-server test is not visible Desktop UI acceptance. The computer
use tool refuses access to this host's `com.openai.codex` app, so reopening
and continuing a repaired chat in the actual Desktop interface remains a
human verification step. No real customer history is changed by the automated
acceptance check.
