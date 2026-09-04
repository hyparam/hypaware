# Acceptance procedures (manual)

Acceptance checks are the third tier of the test model in `AGENTS.md`. They
cross boundaries the current-code hermetic harness cannot prove. Most use the
packaged CLI, a real daemon, a real user home, and real client traffic. The
`durable_cache_upgrade` procedure instead crosses two consecutive code
versions under a disposable home. A fixture written by the candidate cannot
replace either kind of check because it only proves the current code agrees
with itself.

Each procedure below is run by a human before a release that touched its
boundary. Record the result in the release notes. **Do not mark one passed
unless you ran it.**

---

## `durable_cache_upgrade`

**What it proves:** that one affected stream can cross from the last released
version to the candidate without losing confirmed rows or waiting spool rows;
that the candidate performs its intended cache migration; that writes still
work afterward; and that a blocked automatic refresh leaves confirmed data
queryable while preserving the waiting rows.

**What it does not prove:** migration speed on a production-sized cache,
unaffected streams, every possible crash point, or client capture. Test each
affected stream separately. Use a soak or fault-injection test when the change
also claims one of those properties.

**Required when:** a release changes a spool envelope or label, cache schema or
partition declaration, generation/cursor format, or maintenance/compaction
output. Sidecar-only changes use the same procedure when the sidecar writer can
stop the spool-to-cache or cache-to-compaction path.

**Requires:** the last released tag or package, the candidate checkout or
package, separate dependency installs for both versions, and a unique test root
under the platform temp directory (`${TMPDIR:-/tmp}`: the per-user
`/var/folders/.../T` directory macOS sets, `/tmp` on Linux). The test root
must contain the entire `HYP_HOME`. Never point either version at the
operator's normal `~/.hyp`.

**Related:** [LLP 0013](../llp/0013-local-query-cache.decision.md),
[LLP 0311](../llp/0311-cache-date-partition.decision.md),
[LLP 0321](../llp/0321-auto-refresh-serves-confirmed-cache.decision.md).

### Steps

1. Name the exact boundary before creating data. Record:

   - previous version and candidate commit;
   - affected dataset or stream;
   - old and new durable shapes;
   - the command or scheduled step that performs the migration;
   - any query or sidecar surface that reads the changed files.

   One run covers one stream. If two streams use different declarations or
   migration hooks, they need two runs. This step is complete when every shape
   assertion below has an expected old and new value.

2. Create an isolated root and install both versions with their own exact
   dependencies:

   ```sh
   UPGRADE_TMP="${TMPDIR:-/tmp}"
   UPGRADE_ROOT=$(mktemp -d "${UPGRADE_TMP%/}/hypaware-durable-upgrade.XXXXXX")
   mkdir -p "$UPGRADE_ROOT/previous" "$UPGRADE_ROOT/candidate" "$UPGRADE_ROOT/hyp-home"
   export HYP_HOME="$UPGRADE_ROOT/hyp-home"
   ```

   Before any writer starts, assert that `HYP_HOME` begins with
   `${UPGRADE_TMP%/}/hypaware-durable-upgrade.` and is not under `$HOME`. Keep
   the previous release and candidate in separate directories so one dependency
   tree cannot hide a package change in the other.

3. Using the previous release's real storage writer, create:

   - confirmed rows spanning every old partition or schema case the migration
     must preserve;
   - at least two distinct row identities whose exact values are recorded;
   - at least one newer row left only in the real spool.

   Use the release's dataset declaration and writer. Hand-written cursor,
   metadata, Parquet, or spool files do not pass this procedure. Record the
   confirmed identities, waiting identities, row count, live file count,
   active generation, and old schema/partition metadata. This step is complete
   when the confirmed rows are queryable by the previous release and the
   waiting rows are absent from committed reads but present in the spool.

4. Open the same `HYP_HOME` with the candidate, before running maintenance.
   Force a refresh through the real query path, then query every affected read
   surface. For a searchable dataset, run both SQL and grep.

   Pass condition: the candidate reads every confirmed row, moves every
   waiting row through the real spool-to-cache path, and returns the full
   identity set exactly once. The active layout must still be the old layout
   if migration belongs to maintenance rather than refresh.

5. Run the real migration entrypoint. If the migration is scheduled
   maintenance, call maintenance rather than its private rewrite helper.

   Pass condition: the report says the intended migration ran, the active
   generation changes only after the replacement is ready, the new
   schema/partition/cursor metadata exactly matches the declared shape, and the
   confirmed identity set and row count are unchanged. The previous generation
   must follow the migration's stated retirement or rollback rule. Record live
   file counts before and after. Sidecar generation may affect speed, but a
   missing sidecar must not make the data unreadable.

6. Write one new row with the candidate, force it through the spool, and query
   it through every affected read surface.

   Pass condition: the new identity appears exactly once beside every migrated
   identity, the candidate writes only the new shape, and no migration runs a
   second time after convergence.

7. Exercise the blocked-write case against a readable confirmed cache. Use a
   real incompatible declaration or format to make the spool-to-cache write
   return the failure this release is meant to survive. Add a uniquely named
   waiting row before querying.

   Pass condition:

   - automatic SQL, and grep when the stream supports it, return all confirmed
     rows, omit the waiting row, and show the stale-data warning;
   - forced refresh returns the original write error;
   - the waiting identity remains readable from the spool after both failures;
   - the active cache generation and confirmed row count do not change.

8. Record the result in the release notes: both versions, stream, old and new
   shapes, confirmed rows before and after, file counts before and after,
   post-migration write result, forced error text, and waiting-spool result.
   Remove only the exact `UPGRADE_ROOT` created in step 2.

### Release blockers

Any of these fails the procedure and blocks the release:

- a confirmed identity is missing or duplicated at any stage;
- a waiting identity disappears without becoming confirmed;
- a query loses access to the confirmed cache because refresh failed;
- the active generation changes before the replacement is complete;
- the migration reports success while old layout metadata remains active;
- the first candidate write fails after migration;
- the next maintenance pass repeats a migration that claimed to converge.

---

## `codex_desktop_capture`

**What it proves:** that a conversation held in **Codex Desktop** (not the
Codex CLI) reaches `ai_gateway_messages` on this machine, by both routes the
Codex adapter offers, and that the resulting rows are attributable to Desktop
via `entrypoint`.

**What it does not prove:** anything about the Codex CLI (covered by
`gateway_codex_capture` and the backfill tests), anything about fleet
forwarding, or anything on a machine other than the one you ran it on.

**Requires:** macOS with Codex Desktop installed and signed in, HypAware
installed from the package under test, and a working `~/.codex`.

**Related:** [LLP 0141](../llp/0141-codex-desktop-rides-the-codex-adapter.decision.md),
[LLP 0164](../llp/0164-status-names-recent-clients-from-gateway-entrypoints.decision.md).

### Steps

1. Attach Codex and confirm the marker landed in the file Desktop reads:

   ```sh
   hyp client attach codex
   grep -n 'model_providers.hypaware' "${CODEX_HOME:-$HOME/.codex}/config.toml"
   hyp status
   ```

   `hyp status` must show `codex  [configured, attached]` and a running
   daemon. If the gateway is not running, capture cannot happen and the rest
   of this procedure is meaningless.

2. Note the current row count, so step 4 measures only new traffic:

   ```sh
   hyp query sql "select count(*) from ai_gateway_messages"
   ```

3. **Fully quit and reopen Codex Desktop** (it reads `config.toml` at
   launch), then hold a short conversation in it. Send at least one message
   and let it answer. Do not use the Codex CLI for this step: the whole point
   is Desktop traffic.

4. Confirm the live route captured it. This lists what actually arrived
   rather than asserting a literal, because the `originator` string is
   Codex's to choose and can change between releases:

   ```sh
   TODAY=$(date -u +%Y-%m-%d)
   hyp query sql "
     select entrypoint, client_name, count(*) n, max(message_created_at) last_seen
     from ai_gateway_messages
     where conversation_source = 'codex' and date >= '$TODAY'
     group by 1, 2
     order by last_seen desc"
   ```

   Pass condition: a row whose `entrypoint` names the Desktop app (it will
   differ from the terminal client's `codex-tui`), with `last_seen` inside
   the last few minutes and a row count that grew against step 2. Write the
   `entrypoint` value you observed into the release notes: that string is the
   one every "is Desktop landing?" query keys off.

   Then confirm the same answer without a query, which is the check a user
   who has not learned SQL will actually run:

   ```sh
   hyp status
   hyp status --json | grep -A 6 recent_entrypoints
   ```

   Pass condition: a `recent clients:` line naming the same `entrypoint`
   string you just observed, with an age of a few minutes. This is read from
   the running daemon's `status.json`, not from the cache
   ([LLP 0164](../llp/0164-status-names-recent-clients-from-gateway-entrypoints.decision.md)),
   so two things follow and both are expected, not failures: a daemon that
   has been restarted since the conversation shows nothing here (the rows are
   still in the cache - step 4 is the durable check), and the list is bounded
   to what this daemon process has seen.

5. Confirm the backfill route independently. The rollout tree is shared by
   Codex CLI and Codex Desktop, so the session from step 3 must also be
   re-importable from disk:

   ```sh
   NEWEST=$(find "${CODEX_HOME:-$HOME/.codex}/sessions" -name '*.jsonl' -print0 \
     | xargs -0 ls -t | head -1)
   grep -m1 session_meta "$NEWEST"
   hyp client history import codex --since "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" --json
   ```

   Pass condition: the newest rollout file's `session_meta.originator`
   matches what you observed in step 4, and the run reports `items_seen >= 1`
   with `rows_written + rows_skipped >= 1` for `codex`.
   **`rows_written: 0` with `rows_skipped >= 1` is a pass, not a failure.**
   Step 3 already captured this session live, and the live route wrote
   byte-identical rows, so the materializer's `part_id` dedupe suppresses
   the duplicate. Zero writes here is the expected result and is what proves
   the two routes agree. Re-running is likewise safe: identity comes from the
   rollout, so a second import never duplicates.

6. Confirm the app container is flagged, not silently skipped, and that the
   flag explains itself:

   The event rides the structured log stream, not the command's JSON result,
   so turn dev telemetry on for this one run and read the JSONL it writes:

   ```sh
   HYP_DEV_TELEMETRY=1 hyp client history import codex --dry-run --json >/dev/null
   grep -h unsupported_location "${HYP_HOME:-$HOME/.hyp}"/hypaware/dev-telemetry/logs-*.jsonl | tail -3
   ```

   Pass condition: if `~/Library/Application Support/Codex` exists, a
   `codex_desktop_app` record carries
   `covered_by: "gateway_live,codex_sessions_rollout"`, the two routes that
   do capture this client. This is the boundary check: HypAware must say what
   it does *not* parse and what carries those conversations instead (the
   prose behind those two tokens is in
   [LLP 0141](../llp/0141-codex-desktop-rides-the-codex-adapter.decision.md)
   and the README). (`--dry-run` scans without writing rows, so this step
   imports nothing.)

7. Detach and confirm the file is left clean:

   ```sh
   hyp client detach codex
   grep -n 'hypaware' "${CODEX_HOME:-$HOME/.codex}/config.toml" || echo 'clean'
   ```

   Then, if this is your working machine, re-attach so you do not silently
   leave Codex capture off:

   ```sh
   hyp client attach codex
   ```

### If it fails

- No rows at all in step 4: check `hyp status` for `client_attach_missing`
  or a stopped daemon, and confirm you fully quit Desktop rather than closing
  its window.
- Rows arrive but `entrypoint` is null: Codex sent no `originator` header on
  that route. Capture still worked; attribution did not. File that as its own
  issue with the observed request path, and do not paper over it by matching
  on `client_name` alone. `hyp status`'s `recent clients:` line will also be
  missing the Desktop entry, for the same one reason: it counts `entrypoint`
  values and invents nothing for a row that has none.
- The query in step 4 finds Desktop rows but `hyp status` names no recent
  client: the daemon that captured them has since restarted (the tracker is
  in-memory and daemon-scoped by design), or the gateway wrote no status
  refresh before it exited. Re-run step 3 against the current daemon before
  filing anything.
- Step 5 finds no rollout for the session: Desktop wrote its history
  somewhere other than `$CODEX_HOME/sessions`. That would invalidate
  [LLP 0141](../llp/0141-codex-desktop-rides-the-codex-adapter.decision.md)'s
  backfill half and needs a doc correction, not a code workaround.

---

## `opencode_cli_desktop_capture`

**What it proves:** that one first-party OpenCode adapter captures real CLI and
Desktop conversations through its managed global JavaScript plugin, preserves
the live frontend, and converges with bounded exact-session export recovery. It
also checks setup-picker detection, privacy gates, source health, replay
idempotence, and marker-safe detach.

**What it does not prove:** native OpenCode OTLP completeness, provider proxying,
a hosted gateway route, fleet forwarding, or behavior on another machine.
OpenCode 1.18.22 did not reliably deliver completed turns through native OTLP,
so no pass condition below depends on it.

**Requires:** OpenCode CLI and Desktop installed and configured to use the same
OpenCode config home, HypAware installed from the package under test with
`@hypaware/opencode` not yet enabled, `jq`, and a running HypAware daemon. Use a
dedicated acceptance host if the adapter is already enabled. The operator must
obtain explicit authorization for the model turns below because they may
consume paid tokens. Do not delete any OpenCode session during this procedure.

**Related:** [LLP 0306](../llp/0306-opencode-cli-and-desktop-capture.decision.md).

### Steps

1. Record the product versions and config root, then check the setup picker.
   OpenCode follows `XDG_CONFIG_HOME` and otherwise uses `~/.config`; it does
   not document `OPENCODE_HOME`.

   ```sh
   opencode --version
   OPENCODE_CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
   test -d "$OPENCODE_CONFIG_ROOT"
   printf 'OpenCode config root: %s\n' "$OPENCODE_CONFIG_ROOT"
   hyp setup
   ```

   Also record the Desktop version from its About window. Pass condition: the
   visible `OpenCode` row is pre-checked and says it records CLI and Desktop
   through a local plugin with bounded history recovery. Cancel the walkthrough
   without saving. A fresh installation that has never created the shared
   config directory is allowed to remain unchecked, but the row must still be
   visible and selectable. If this host intentionally sets `XDG_CONFIG_HOME`,
   launch `hyp setup` with the same value and confirm detection there. Do not
   set `OPENCODE_HOME` as a substitute.

2. Enable and attach only the OpenCode adapter, then restart both OpenCode
   frontends so they load the global plugin.

   ```sh
   hyp client attach opencode
   PLUGIN="$OPENCODE_CONFIG_ROOT/plugins/hypaware.js"
   grep -n 'HYPWARE_OPENCODE_PLUGIN' "$PLUGIN"
   hyp daemon restart
   hyp status
   ```

   Accept the prompt to enable OpenCode and decline the history-import prompt
   for now, so step 5 controls the recovery window. Pass condition: the
   consent flow adds and activates `@hypaware/opencode`, composes no
   `@hypaware/ai-gateway`, installs the marker-owned plugin, and offers bounded
   backfill only after attach succeeds. Status reports OpenCode configured,
   attached, and its source started. Fully quit and reopen Desktop after
   attaching. Start a new CLI process after attaching too.

3. Create one controlled file in a non-sensitive scratch project. Run one CLI
   conversation and one Desktop conversation from that project. In each, ask
   OpenCode to read the file with its file-reading tool and report its short,
   non-secret contents. Record the two new session IDs by comparing the session
   list before and after the turns.

   ```sh
   mkdir -p /tmp/hyp-opencode-acceptance/main
   printf 'opencode acceptance probe\n' > /tmp/hyp-opencode-acceptance/main/probe.txt
   opencode session list --format json --max-count 10
   cd /tmp/hyp-opencode-acceptance/main
   opencode run "Read probe.txt with the file-reading tool, then state its contents."
   opencode session list --format json --max-count 10
   ```

   Open the same directory in Desktop and repeat the prompt there. Set
   `CLI_SESSION` and `DESKTOP_SESSION` from the observed IDs for the remaining
   steps. Do not infer them from titles alone.

4. Confirm live text and the completed tool operation landed once with native
   IDs and distinct frontend provenance.

   ```sh
   hyp query sql "
     select session_id, entrypoint, message_id, part_id, part_type,
            tool_name, tool_call_id, content_text
     from ai_gateway_messages
     where session_id in ('$CLI_SESSION', '$DESKTOP_SESSION')
     order by session_id, message_index, part_index"
   ```

   Pass condition: both sessions have text rows and a completed tool row with
   non-null `message_id`, `part_id`, `tool_name`, and `tool_call_id`. The CLI
   session has `entrypoint = 'cli'`; the Desktop session has
   `entrypoint = 'desktop'`. Record representative native message, part, and
   tool-call IDs in the release notes so the recovery comparison can use exact
   values rather than row position.

   Also compare each assistant `content_text` against what the frontend
   displayed. It must be the whole final answer, not a streaming prefix. A
   message is captured once it settles precisely because the append-only dedupe
   is at message grain: whichever version lands first is the one kept forever,
   so a truncated row here is a capture defect, not a display difference, and no
   later snapshot or import can repair it.

5. Prove export/recovery convergence with a tight time cursor. First save exact
   exports for the two IDs and note the current durable counts. Then import only
   the short interval containing these turns twice.

   ```sh
   opencode export "$CLI_SESSION" > /tmp/hyp-opencode-acceptance/cli-export.json
   opencode export "$DESKTOP_SESSION" > /tmp/hyp-opencode-acceptance/desktop-export.json
   hyp query sql "
     select session_id, count(*) n, count(distinct part_id) distinct_parts
     from ai_gateway_messages
     where session_id in ('$CLI_SESSION', '$DESKTOP_SESSION')
     group by 1 order by 1"
   hyp client history import opencode \
     --since '<UTC timestamp immediately before step 3>' \
     --until '<UTC timestamp immediately after step 3>' --json
   hyp client history import opencode \
     --since '<the same timestamp used for --since above>' \
     --until '<the same timestamp used for --until above>' --json
   ```

   The second run must repeat the first run's interval exactly. A narrower or
   zero-width window selects nothing, so it would report zero new rows without
   ever re-exporting the sessions the dedupe is being tested on.

   Pass condition: each import reports only sessions inside the requested
   interval; the provider lists metadata within that cursor and invokes
   `opencode export <exact-session-id>` only for selected IDs. Both runs write
   zero new rows for the two live-captured sessions, and the counts and exact
   `part_id` values remain unchanged. The saved exports retain message/part
   order and the same native IDs. Historical rows may say
   `entrypoint = 'unknown'`; they must not overwrite the live `cli` or
   `desktop` provenance.

6. Exercise the four privacy gates from controlled scratch directories. Each
   marking is prospective. Record the new session ID after each turn and never
   use a pre-existing personal project.

   ```sh
   mkdir -p /tmp/hyp-opencode-acceptance/dotignore \
     /tmp/hyp-opencode-acceptance/private \
     /tmp/hyp-opencode-acceptance/local-only \
     /tmp/hyp-opencode-acceptance/session-ignore
   printf 'ignore\n' > /tmp/hyp-opencode-acceptance/dotignore/.hypignore
   hyp privacy set /tmp/hyp-opencode-acceptance/private ignore
   hyp privacy set /tmp/hyp-opencode-acceptance/local-only local-only
   ```

   Run one short OpenCode CLI turn from each of the first three directories.
   For session ignore, run a first short turn in `session-ignore`, record its
   ID as `IGNORED_SESSION`, note its current row count, then run:

   ```sh
   hyp session ignore "$IGNORED_SESSION"
   hyp session status "$IGNORED_SESSION"
   cd /tmp/hyp-opencode-acceptance/session-ignore
   opencode run --session "$IGNORED_SESSION" "Reply with the single word ignored."
   ```

   Re-run the bounded history import over this step's interval. Pass condition:
   the `.hypignore` and machine-local `ignore` sessions have zero rows from
   both live and recovery producers; the local-only session is queryable in
   the local cache and keeps its real `cwd`; and the ignored session's count
   does not grow while ignored. `hyp session unignore "$IGNORED_SESSION"`
   must restore recording for a later turn. On an enrolled test host, also
   confirm the local-only row is withheld from configured shared export.

7. Check listener and reconciliation health after the real traffic.

   ```sh
   hyp status --json | jq '.sources[] | select(.name == "opencode")'
   ```

   Pass condition: the source is ready/started, `plugin_events` and
   `snapshots_received` advanced, `reconciliation_cursor` names the newest
   observed session/message, and writes/skips plus policy/session drops account
   for the turns above. `unknown_entrypoints`, `store_activity_gaps`,
   `missing_cwd`, and the error field must be zero/empty for this controlled
   run. A nonzero counter is a visible health result to investigate, not a
   reason to guess missing provenance or cwd.

8. Clean up only HypAware-managed effects. Do not delete the OpenCode sessions.

   ```sh
   hyp session unignore "$IGNORED_SESSION"
   hyp privacy unset /tmp/hyp-opencode-acceptance/private ignore
   hyp privacy unset /tmp/hyp-opencode-acceptance/local-only local-only
   hyp client detach opencode
   test ! -e "$PLUGIN"
   hyp status
   ```

   Pass condition: detach removes the marker-owned plugin file and leaves the
   shared OpenCode config and every session untouched. If the file no longer
   carries the ownership marker, detach must refuse to remove it. Re-attach on
   a working machine only after the acceptance result has been recorded.

### If it fails

- No live rows: confirm the daemon source is started, the plugin file is in the
  effective XDG config root, and both frontends were fully restarted after
  attach. Do not switch to OTLP as a completeness workaround.
- CLI lands as `unknown`: the plugin process did not expose the documented
  default. Desktop lands as `unknown`: its shared sidecar did not set
  `OPENCODE_CLIENT=desktop`. Preserve the observed value and treat attribution
  as failed rather than guessing from the session store.
- Recovery writes duplicates: compare exact native `part.id` values in the
  saved export against `part_id` in the cache. Do not add content-derived IDs.
- The picker row is visible but unchecked on an existing config home: confirm
  `XDG_CONFIG_HOME` agrees between OpenCode and `hyp setup`. Do not broaden the
  single-probe picker schema or invent `OPENCODE_HOME`.
- Detach finds an unowned collision: preserve it and report the path. Never
  overwrite or remove a file without the HypAware ownership marker.

---

## `openclaw_capture`

**What it proves:** that a conversation held in **OpenClaw** reaches
`ai_gateway_messages` on this machine, by both lanes the OpenClaw adapter
offers: live capture through the local gateway once attached (this adapter
writes the `anthropic`/`openai` provider overrides into `openclaw.json`
itself, no separate package to install or link), and a periodic sweep of
local session transcripts that backfills every OpenClaw provider within the
sweep interval. It proves the rows name the real upstream, that a turn both
lanes observe settles to exactly one row rather than two, and that live
capture is reversible via `hyp client detach`.

**What it does not prove:** anything about OpenClaw's CLI backends (a
Claude Code or Codex turn run through OpenClaw belongs to the sibling
adapters, [LLP 0147](../llp/0147-cli-backends-are-transcript-captured.decision.md)),
anything about fleet forwarding, or anything on a machine other than the
one you ran it on. There is no longer a deferred-provider-family ledger to
exercise here: LLP 0171 retires that requirement (R13) outright, since the
sweep gives every provider at least transcript-fidelity coverage, so this
procedure has nothing to assert about a "deferred" turn.

**Requires:**

- OpenClaw installed with a working `~/.openclaw`, and credentials
  configured for **both** `anthropic` and `openai`. Both shapes are
  needed: the `openai` turn is the only observation that proves
  `x-hypaware-upstream` actually arrives (step 4).
- **OpenClaw 2026.4.24 or newer** (`openclaw --version`), the same floor
  the prior procedure required. Lane A no longer depends on any OpenClaw
  hook API (no `before_model_resolve`, no `hooks.allowConversationAccess`):
  attach only needs `models.providers` to be a schema-valid config key,
  which [LLP 0167#verify-results](../llp/0167-openclaw-capture-via-config-provider-override.rfc.md#verify-results)
  confirms is stable back to 2026.3.13. The floor is kept here, not
  re-derived, so this run re-confirms items 1, 3, and 4 of that
  verification (step 7) on a current binary: those facts were established
  on 2026.3.13 and this procedure has never re-checked them since.
- HypAware installed from the package under test, `@hypaware/openclaw`
  enabled, daemon running. Nothing to link from the checkout and nothing
  else to install: attach writes the two provider overrides itself
  (step 1).
- **Steps 5 and 6 (the sweep and zero-duplicate steps) need PR #552
  (fix/issue-543) merged** into the binary under test. Until it lands, the
  LLP 0158 session-file reader still parses OpenClaw v3 records with the
  old flat shape, so the sweep and the transcript backfill both project
  zero rows from a real transcript, not because Lane B is miswired but
  because the reader upstream of it has nothing to hand it. A red step 5
  or 6 against an unmerged #552 is not evidence of a Lane B regression;
  confirm the merge before filing anything.
- **The `client_attach` status-row re-confirmation in steps 1 and 7 needs no
  pending PR.** `openclaw` declares a real `attach_probe` again as of this
  change set, for the first time since
  [LLP 0143](../llp/0143-openclaw-registers-no-attach-probe.decision.md)
  removed it and [LLP 0169](../llp/0169-openclaw-attach-surface-returns.decision.md)
  brought it back, so `hyp status` derives its row from disk like any other
  probed client. The probe-less `attach n/a` rendering
  ([LLP 0229 #status-derives-by-the-same-gate](../llp/0229-status-derives-attach-state-by-the-desired-gate.decision.md#status-derives-by-the-same-gate))
  applies to `claude-desktop`, not to `openclaw`, and is not what this
  procedure checks.
- **A `backfill.window_days` on the `@hypaware/openclaw` config entry clips
  the scheduled sweep, not just the join-time
  import** ([LLP 0359 #sweep-context](../llp/0359-bounded-scheduled-backfill.decision.md#sweep-context)),
  so a transcript older than that window is never recovered by Lane B. Every
  turn steps 5 and 6 depend on is held during the run, and the smallest legal
  window is a day, so no window an operator can set breaks this procedure as
  written. The note is here for the variant: if you substitute an older
  transcript for step 6's fresh turn, unset `window_days` first, or step 6
  fails for a configured reason rather than a broken one.

**Related:** [LLP 0167](../llp/0167-openclaw-capture-via-config-provider-override.rfc.md)
(the override design and the verify-results this procedure re-confirms),
[LLP 0169](../llp/0169-openclaw-attach-surface-returns.decision.md) (attach/detach),
[LLP 0170](../llp/0170-openclaw-scheduled-transcript-sweep.decision.md) (the sweep),
[LLP 0171](../llp/0171-openclaw-two-lane-capture.spec.md) (the requirements this
procedure checks, R11 in particular), [LLP 0172](../llp/0172-openclaw-two-lane-capture.design.md#acceptance-onboarding)
(section 8.1, this rewrite's own design), [LLP 0159](../llp/0159-openclaw-route-agreement-by-settlement.decision.md)
(why step 5 passes on zero *new* writes from the sweep).

### Steps

1. Attach OpenClaw and confirm the write, then restart the gateway. Before
   restarting, re-confirm LLP 0167#verify-results item 4 (no pickup without
   a restart): run one turn first, so there is something to contrast once
   the restart step below actually takes effect.

   ```sh
   hyp query sql "select count(*) from ai_gateway_messages where conversation_source = 'openclaw'"
   hyp client attach openclaw
   openclaw agent --agent <agent-id> --model anthropic/<a-claude-model> \
     --message "pre-restart probe, should not route through the gateway"
   hyp query sql "select count(*) from ai_gateway_messages where conversation_source = 'openclaw'"
   ```

   Pass condition for item 4: the two counts are equal. `hyp client attach` wrote
   the config, but a running OpenClaw gateway does not pick up
   `models.providers` changes until restarted, so the probe turn above
   still went out at OpenClaw's original `baseUrl`, not the gateway's.

   Now run the restart instruction `hyp client attach` printed:

   ```sh
   openclaw gateway restart
   ```

   Then confirm the write itself and the daemon's view of it:

   ```sh
   hyp status
   jq '.models.providers | {anthropic, openai}' "${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
   ```

   Pass condition: `hyp status` shows a running daemon and
   `openclaw  [configured, attached]` among the clients, with no
   `client_attach_missing` diagnostic (this is the LLP 0169 re-confirmation:
   with the probe back, that row is read off disk again rather than reported
   as not applicable). The `jq` output shows
   `anthropic.baseUrl` as the bare gateway origin and `openai.baseUrl` as
   the same origin plus `/v1`, both carrying `headers["x-hypaware-upstream"]`
   set to their own key, and **both carrying `models: []`**. That empty
   array is LLP 0167#verify-results item 1's caveat, re-confirmed here: a
   partial entry without it is schema-invalid and OpenClaw hard-refuses the
   config outright. Separately confirm the empty array does not empty the
   real catalog: `openclaw models list --all` must still list the full
   built-in `anthropic` catalog.

2. Note the current row count and pin the window, so steps 4, 5, and 6
   measure only new traffic:

   ```sh
   SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   hyp query sql "
     select count(*) from ai_gateway_messages
     where conversation_source = 'openclaw'"
   ```

   `$SINCE` is the ISO instant `hyp client history import --since` takes, and the same
   text goes straight into SQL against the `message_created_at` TIMESTAMP
   column. Keep the trailing `Z`: the query layer types the string literal
   against the column ([LLP 0272](../llp/0272-string-literals-typed-by-the-column.decision.md)),
   and a zone-less instant would be read as local time.

3. Hold a short conversation in OpenClaw, one turn on each API shape (use
   `openclaw agents list` if you do not know your agent id):

   ```sh
   openclaw agent --agent <agent-id> --model anthropic/<a-claude-model> \
     --message "In one sentence, what is a checksum?"
   openclaw agent --agent <agent-id> --model openai/<a-gpt-model> \
     --message "In one sentence, what is a checksum?"
   ```

   Ordinary interactive use works just as well. Do **not** substitute
   `openclaw agent exec`: it runs against a temporary state directory, so
   the session JSONL that steps 5 and 6 depend on may never land under
   `~/.openclaw/agents/<agent-id>/sessions/`.

4. Confirm the live route captured both shapes and recorded the true
   upstream:

   ```sh
   hyp query sql "
     select provider, client_name, count(*) n, max(message_created_at) last_seen
     from ai_gateway_messages
     where conversation_source = 'openclaw'
       and message_created_at >= '$SINCE'
     group by 1, 2
     order by last_seen desc"
   ```

   Pass condition: two rows, `provider` = `anthropic` and `openai`, both
   with `client_name` = `openclaw` and `last_seen` inside the last few
   minutes, and the count grew against step 2. Unlike the old
   steering-plugin design, there is no shadow provider id to leak here:
   attach overrides the existing `anthropic`/`openai` entries' `baseUrl`
   rather than registering new provider ids, so any `provider` value other
   than `anthropic`/`openai` is unexpected on its own terms, not a specific
   named failure mode to check for.

   The `openai` row is the load-bearing one, and it is this procedure's
   proof that `x-hypaware-upstream` arrives at the gateway. The projector
   reads the provider from that header and falls back to `anthropic` when
   it is absent, so an `anthropic` row alone cannot tell "routed through
   the override, header arrived" from "header lost, fell back". Only a row
   that says `openai` proves the header survived the trip from the
   override entry's static `headers` value to the projection.

5. Zero-duplicate assertion: the two turns from step 3 are exactly the case
   both lanes observe (live capture already caught them at wire fidelity;
   their session file entry is also sitting on disk waiting for a sweep).
   Wait past one sweep interval (default 5 minutes) after the quiesce
   window (default 3 minutes) has elapsed since step 3, then re-run the
   same query:

   ```sh
   hyp query sql "
     select count(*) from ai_gateway_messages
     where conversation_source = 'openclaw'
       and message_created_at >= '$SINCE'"
   hyp query sql "
     select part_id, count(*) n
     from ai_gateway_messages
     where conversation_source = 'openclaw'
       and message_created_at >= '$SINCE'
     group by part_id
     having count(*) > 1"
   ```

   Pass condition: the first count is unchanged from step 4's total (the
   scheduled sweep found the same two turns already settled onto their
   session file's native identity and wrote nothing new), and the second
   query returns zero rows (no `part_id` in the window appears more than
   once). This is R11 proven against the daemon's own automatic scheduler
   rather than a manually-invoked `hyp client history import`, which is the whole point
   of Lane B being *scheduled*, not just present.

6. Sweep step: prove a turn Lane A never saw still lands, at transcript
   fidelity, within one sweep interval. Detach first, so the turn below
   has no live route to travel:

   ```sh
   hyp client detach openclaw
   openclaw gateway restart
   SINCE2=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   openclaw agent --agent <agent-id> --model anthropic/<a-claude-model> \
     --message "In one sentence, what is a hash collision?"
   hyp query sql "
     select count(*) from ai_gateway_messages
     where conversation_source = 'openclaw'
       and message_created_at >= '$SINCE2'"
   ```

   Pass condition immediately after the turn: `0`. Detach means the turn
   went straight to OpenClaw's own `anthropic` endpoint, not the gateway,
   so nothing reaches Lane A; only the session file records it.

   This is also the LLP 0167#verify-results item 3 re-confirmation
   ("no self-heal"): confirm the detach actually purged the derived
   caches rather than leaving a stale entry for OpenClaw to keep routing
   by, since a cache that self-healed would make this step's absence
   claim accidentally true for the wrong reason:

   ```sh
   grep -rl 'x-hypaware-upstream' "${OPENCLAW_HOME:-$HOME/.openclaw}"/agents/*/agent/models.json
   ```

   Pass condition: no matches. `hyp client detach` best-effort purges every
   `agents/<id>/agent/models.json`; a leftover match here means the purge
   missed a cache, not that self-heal happened on its own.

   Now wait past one sweep interval (default 5 minutes) after the quiesce
   window (default 3 minutes) has elapsed since the turn above, then
   re-run the same query:

   ```sh
   hyp query sql "
     select count(*), max(message_created_at)
     from ai_gateway_messages
     where conversation_source = 'openclaw'
       and message_created_at >= '$SINCE2'"
   ```

   Pass condition: `1`. The scheduled sweep picked the turn up once its
   session file cleared the quiesce window, at transcript fidelity, with
   no live route involved at all.

   Re-attach so this machine is not left silently uncaptured on the live
   lane, and restart once more:

   ```sh
   hyp client attach openclaw
   openclaw gateway restart
   ```

7. Re-confirm [LLP 0167#verify-results](../llp/0167-openclaw-capture-via-config-provider-override.rfc.md#verify-results)
   items 1, 3, and 4 on this OpenClaw version, per **Requires**. This step
   is a recap, not new commands: each item was already exercised above.

   - **Item 1** ("merges, but only with `models: []`"): confirmed by step
     1's `jq` check and `openclaw models list --all` still showing the
     full catalog.
   - **Item 3** ("no self-heal"): confirmed by step 6's cache-purge grep
     returning no matches after `hyp client detach`.
   - **Item 4** ("no pickup without restart"): confirmed by step 1's
     pre-restart probe turn producing no new row.

   Record in the release notes that all three still hold on
   `openclaw --version` as run, not only that this document says they do.

8. Codex-backend stamping probe
   ([LLP 0193#verify](../llp/0193-openclaw-backfill-cli-denylist.decision.md#verify)):
   run **one** OpenClaw turn on a codex CLI backend (a `codex-cli/<model>`
   ref, or whatever ref your install resolves to the `codex` binary), then
   read the newest records of the session file it wrote:

   ```sh
   tail -5 ~/.openclaw/agents/main/sessions/<session-id>.jsonl | \
     grep -o '"provider":"[^"]*"\|"api":"[^"]*"'
   ```

   Expected: the turn's assistant record stamps `api: "cli"` (any provider
   string). Record the observed `provider`/`api` pair and
   `openclaw --version` in LLP 0193's verify section. If the record stamps
   a wire-shape api (`openai-responses`, `openai-completions`) instead,
   that is the LLP 0193 fail-open residual observed live: the turn
   double-counts against `@hypaware/codex` unless its provider string
   matches the `codex` prefix, so file it and extend
   `SIBLING_ADAPTER_COVERAGE` with the observed provider before release.

### If it fails

- Step 1's pre-restart probe finds a *new* row before you restart the
  gateway: either the gateway was already running with a stale config that
  happened to match, or your OpenClaw binary's config reloader has changed
  to pick up `models.providers` hot (LLP 0167#verify-results item 4 notes
  this as a real possibility on newer chokidar-based reloaders). Either way
  this is a finding worth recording, not a HypAware bug: attach never
  relies on hot reload, it only prints the restart instruction.
- Step 1 finds `client_attach_missing` still firing after a successful
  attach and restart: check `openclaw --version` against the floor in
  **Requires** first, then re-run step 1's `jq` check. The warning is
  probe-derived, so it means the probe read `openclaw.json` and found no
  HypAware-owned entry: either the write did not land, or it landed
  somewhere other than the `OPENCLAW_HOME` the probe reads.
- Step 4 finds no rows at all: check `hyp status` for a stopped daemon,
  then re-run step 1's `jq` check for a config that did not actually write
  (a concurrent edit under `openclaw.json` fails the write's mtime guard
  rather than silently overwriting), then confirm
  `openclaw gateway restart` actually ran after the last config change.
- Step 4 finds `anthropic` rows but no `openai` row: no OpenAI credential
  is configured in OpenClaw for that turn, or the `openai` upstream preset
  failed to register at plugin activation. Check `hyp status` for a
  `@hypaware/openclaw` activation error before touching code.
- Step 5 or 6 finds nothing after waiting past the sweep interval: confirm
  PR #552 is merged into the binary under test first (see **Requires**); a
  sweep against the unmerged flat reader silently backfills zero rows from
  a real OpenClaw v3 transcript, and this is the expected, documented
  effect of that specific gap, not a new bug to chase.
- Step 5's second query returns a `part_id` with `count(*) > 1`: the live
  row did not settle onto the session file's native identity before the
  sweep imported the same turn, so the two rows never converged. Check
  whether the live row still carries `attributes.openclaw.match_key` (an
  unsettled row does); a settlement that has not run yet points at
  [LLP 0159](../llp/0159-openclaw-route-agreement-by-settlement.decision.md)'s
  open question about append timing, not a dedupe bug.
- Step 6 finds a row immediately after the detached turn (should be `0`):
  `hyp client detach` did not actually remove the override entries, most likely
  because the entry on disk was not one this gateway wrote (a hand-edited
  `baseUrl`, or `models` non-empty) and the detach backed it up instead of
  deleting it, per
  [LLP 0163](../llp/0163-attach-backs-up-a-malformed-block.decision.md)'s
  backup-not-discard rule. Check the detach command's own warning output
  before concluding the turn leaked.

---

## `claude_otel_shape_check`

**What it proves:** that the **installed** Claude Code still emits the
telemetry HypAware's `otel` attach depends on: the nine-key `env` block is
honored, the expected event names arrive with the attributes the listener
reads, the raw body files still carry the fields the projector fills its
column gaps from, and the whole path lands `ai_gateway_messages` and
`claude_telemetry_events` rows with nothing null that should not be.

This is the release-gate half of LLP 0262's flag-stability duty (open
question 5). The other half runs in production: the `hyp status` capture-health
line. Neither can be replaced by a hermetic smoke, because a smoke POSTs a
fixture we wrote and therefore agrees with itself forever. Only a real Claude
Code can tell you it renamed an event or dropped a flag.

**What it does not prove:** anything about the gateway proxy path (still the
capture route for `codex`, `claude-desktop`, `openclaw`, `hermes`, and raw SDK
traffic), anything about fleet managed-settings delivery, anything about
central forwarding, or anything on a machine other than the one you ran it on.

**Requires:**

- A real Claude Code install, **2.1.214 or newer**. Attach's own floor is
  2.1.193 (the event set) and it refuses the mode switch below it
  ([LLP 0258#version-floor](../llp/0258-attach-injects-telemetry-via-settings-env.decision.md#version-floor)),
  so there is nothing to shape-check there. This procedure asks for the higher
  number because step 8 asserts the tool-decision `source`, which arrives at
  2.1.214: between the two versions attach succeeds and that one field reads
  null, which is correct behavior and would read here as a false failure.
- HypAware installed from the package under test, `@hypaware/claude` enabled,
  daemon running, and `jq` on `PATH`.
- A scratch git repository to hold the two conversations in. Do not run this in
  a directory covered by `.hypignore` or the machine-local list: the usage
  policy drops those sessions at ingest by design, and every row assertion
  below would then fail for the right reason at the wrong time.
- Willingness to have two short real conversations recorded on this machine.

**Related:**
[LLP 0262](../llp/0262-otel-attach-replaces-proxy.rfc.md) (the design record and
open question 5),
[LLP 0257](../llp/0257-claude-telemetry-listener-source.spec.md) (S21, the
two-layer drift detection this discharges),
[LLP 0258](../llp/0258-attach-injects-telemetry-via-settings-env.decision.md)
(the env keys step 1 asserts),
[LLP 0252](../llp/0252-events-carry-content-bodies-fill-the-gaps.decision.md)
(which fields come from events and which from bodies),
[LLP 0253](../llp/0253-body-spool-is-capped-and-swept.decision.md) (the spool),
[LLP 0255](../llp/0255-claude-telemetry-events-dataset.decision.md) (the
`claude_telemetry_events` row shape).

### Steps

1. Attach, and confirm the env block on disk is exactly the managed key set:

   ```sh
   SETTINGS="${CLAUDE_HOME:-$HOME/.claude}/settings.json"
   claude --version
   hyp client attach claude
   jq '.env, ._hypaware' "$SETTINGS"
   hyp status
   ```

   Pass condition: `claude --version` is 2.1.214 or newer; `env` carries all
   nine managed keys (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_LOGS_EXPORTER`,
   `OTEL_METRICS_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`,
   `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_LOG_USER_PROMPTS`,
   `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`,
   `OTEL_LOG_RAW_API_BODIES`) and **no** `ANTHROPIC_BASE_URL`, `HTTPS_PROXY`,
   or `NODE_EXTRA_CA_CERTS`; the `_hypaware` marker records `mode: "otel"` and
   the spool directory; `hyp status` shows
   `claude  [configured, attached (otel)]` and a running daemon.

2. Pin the window, so every later query measures only this run:

   ```sh
   SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   SPOOL="${HYP_HOME:-$HOME/.hyp}/spool/claude-bodies"
   ls -ld "$SPOOL"
   ```

   Pass condition: the spool directory exists and reads `drwx------`
   ([LLP 0253#spool-location](../llp/0253-body-spool-is-capped-and-swept.decision.md#spool-location)).
   `$SINCE` is the ISO instant, and the same text goes straight into SQL
   against a TIMESTAMP column. Keep the trailing `Z`: the query layer types
   the string literal against the column
   ([LLP 0272](../llp/0272-string-literals-typed-by-the-column.decision.md)),
   and a zone-less instant would be read as local time.

3. Take a raw body sample with the daemon **stopped**. Stopping it is what
   makes this step deterministic: nothing consumes the spool, so the files sit
   still long enough to read, which the live path never allows (a projected
   body is deleted immediately).

   ```sh
   hyp daemon stop
   ```

   Now, in the scratch repo, hold one short Claude Code conversation in a
   **fresh** session (the settings `env` applies at launch, so a session that
   was already open is not attached). Ask it to read one file, so the request
   carries a tool definition and the response a tool-use block. Then:

   ```sh
   mkdir -p /tmp/hyp-shape-check && cp "$SPOOL"/* /tmp/hyp-shape-check/
   for f in /tmp/hyp-shape-check/*; do echo "== $f"; jq -r 'keys | join(",")' "$f"; done
   ```

   Pass condition: at least two files, and their top-level key lists identify a
   request body and a response body. If the directory is empty, stop here:
   `OTEL_LOG_RAW_API_BODIES` is no longer writing files, which is the single
   biggest drift this procedure exists to catch.

4. Assert the body shape. These are exactly the fields the projector reads a
   body **for**
   ([LLP 0252#bodies-for-gaps](../llp/0252-events-carry-content-bodies-fill-the-gaps.decision.md#bodies-for-gaps)):
   everything else in the file the events already delivered.

   ```sh
   REQ=$(grep -l '"messages"' /tmp/hyp-shape-check/* | head -1)
   RES=$(grep -l '"stop_reason"' /tmp/hyp-shape-check/* | head -1)
   jq '{model, system: (.system|type), messages: (.messages|type),
        tools: (.tools|type), tool0: (.tools[0]|keys?)}' "$REQ"
   jq '{id, role, model, stop_reason,
        content: [.content[].type], usage: (.usage|keys)}' "$RES"
   ```

   Pass condition: the request body is a JSON object carrying `model`, a
   `system` that is a string or an array of text blocks, a `messages` array,
   and a `tools` array whose entries carry `name` and `input_schema`. The
   response body carries `id`, `role`, `model`, `stop_reason`, a `content`
   array of typed blocks, and a `usage` object. A missing field here is silent
   column loss downstream (`system_text`, `tools`, untruncated `tool_args`),
   not a crash, which is why it is asserted on the file rather than inferred
   from a null column.

   Then clear the sample. Those bodies are orphans: their events were lost
   with the daemon down, so nothing will ever project them and they would sit
   in the spool until the byte cap evicted them.

   ```sh
   rm -f "$SPOOL"/*
   hyp daemon start
   ```

5. Hold the real conversation, daemon up, in a **fresh** session in the same
   scratch repo. Drive three things on purpose, because each one is a separate
   event this procedure asserts:

   - let it run one tool call to completion (`tool_result`),
   - **reject** one tool call when it asks (`tool_decision` with
     `decision = reject`),
   - change permission mode once, e.g. accept-edits (`permission_mode_changed`).

   Then wait out one export interval and confirm the spool drained. Claude
   Code batches its exports, so an immediate check reads "not yet" as
   "broken":

   ```sh
   sleep 60
   ls -1 "$SPOOL" | wc -l
   ```

   Pass condition: `0`, or only the files of a turn still in flight. Bodies are
   projected and then deleted
   ([LLP 0252#project-then-delete](../llp/0252-events-carry-content-bodies-fill-the-gaps.decision.md#project-then-delete)),
   so a spool that keeps growing means the listener is not consuming what
   Claude Code writes.

6. Assert the message rows, and that the body join actually filled its columns:

   ```sh
   hyp query sql "
     select role,
            count(*) n,
            max(message_created_at) last_seen,
            sum(case when system_text is not null then 1 else 0 end) with_system,
            sum(case when tools is not null then 1 else 0 end) with_tools,
            sum(case when cwd is not null then 1 else 0 end) with_cwd,
            sum(case when git_branch is not null then 1 else 0 end) with_branch,
            sum(case when client_version is not null then 1 else 0 end) with_version
     from ai_gateway_messages
     where conversation_source = 'claude_code'
       and message_created_at >= '$SINCE'
     group by 1
     order by 1"
   ```

   Pass condition: rows for both `user` and `assistant`; `with_system` and
   `with_tools` above zero (that is the body join, step 4's fields arriving in
   columns); `with_cwd` and `with_branch` above zero (that is the SessionStart
   hook, which is where cwd and git identity come from on this path, not the
   events); `with_version` above zero (`app.version` off the events on
   2.1.233, or `service.version` off the export's OTLP resource from 2.1.235,
   where the event attribute is gone: the projector reads both, so a null
   here across a whole session means the version reached neither place: a
   third upstream shape or a broken fallback, filed as new drift the way
   #854 was, not #854 itself).
   `with_cwd = 0` with everything else healthy means the hook is not installed
   and the usage policy is running blind, which is a release blocker on its own.

7. Assert the event names. This query is both the presence check and the drift
   detector, because an event name the listener does not model is still
   recorded rather than dropped
   ([LLP 0257#failure-modes](../llp/0257-claude-telemetry-listener-source.spec.md#failure-modes)):

   ```sh
   hyp query sql "
     select event_name, count(*) n, max(event_timestamp) last_seen
     from claude_telemetry_events
     where event_timestamp >= '$SINCE'
     group by 1
     order by 1"
   ```

   Pass condition: the list contains at least `api_request`, `tool_decision`,
   `tool_result`, `permission_mode_changed`, and the metric rows
   `claude_code.cost.usage`, `claude_code.lines_of_code.count`, and
   `claude_code.active_time.total`. The metric rows ride the metrics exporter,
   whose interval is longer than the logs one: if the `claude_code.*` names are
   the only ones missing, wait another minute and re-run this query before
   concluding anything. Write the **whole** list into the release
   notes, not just the verdict: a name this document does not mention is an
   upstream addition worth a follow-up, and a name that has stopped appearing
   is upstream drift to file before the release ships. Note that `user_prompt`,
   `assistant_response`, `api_request_body`, and `api_response_body` are
   *expected to be absent here*: the first two are projected into
   `ai_gateway_messages` and the last two are body pointers, so their absence
   from this table is correct and their presence would be the bug.

8. Assert the event attributes, which is where a flag going quiet shows up as a
   null rather than an error:

   ```sh
   hyp query sql --max-bytes 0 "
     select event_name, tool_name, decision, source, cost_usd, attributes
     from claude_telemetry_events
     where event_timestamp >= '$SINCE'
       and event_name in ('tool_decision', 'api_request', 'permission_mode_changed')
     order by event_timestamp
     limit 12"
   ```

   Pass condition: the `tool_decision` row for the call you rejected has
   `decision = reject` and a non-null `source` (the 2.1.214 detail); the
   `api_request` row has a non-null `cost_usd` and its `attributes` carry
   `model`, `input_tokens`, `output_tokens`, and the cache-token pair; the
   `permission_mode_changed` row's `attributes` carry `from_mode` and
   `to_mode`. Every row's `attributes` should carry the identity block
   (`user.account_uuid`, `organization.id`, `terminal.type`, plus
   `app.version` and `app.entrypoint` on clients that still send them: 2.1.235
   moved the version to the OTLP resource, so its absence here is upstream
   shape, not a capture fault. That same capture carries no `app.entrypoint`
   on the events either and the resource offers no replacement for it, so
   `ai_gateway_messages.entrypoint` is null on that client: a separate gap
   from #854, and not something this step passes or fails on). Pass
   `--max-bytes 0` or the display truncates the JSON and you will read a short
   value as a missing one.

9. Confirm the capture-health line agrees, which is the production half of the
   same duty:

   ```sh
   hyp status
   ```

   Pass condition: a `capture health:` block with a `- claude  last event
   <minutes> ago, last transcript activity <minutes> ago` line, the two ages
   within a few minutes of each other, and **no** `[capture gap]` tag or
   `capture_gap` diagnostic.

10. Record in the release notes: the `claude --version` you ran against, the
    full event-name list from step 7, the body top-level keys from step 3, and
    any field from steps 4, 6, or 8 that came back null. Those four items are
    the release-to-release diff that makes upstream drift visible; a bare
    "passed" makes the next run start from nothing.

### If it fails

- Step 1 refuses the attach with an upgrade hint: the installed Claude Code is
  below 2.1.193. Run `claude update` and start again. The refusal is correct
  behavior, not a bug: any existing attach was left byte-for-byte alone
  ([LLP 0258#version-floor](../llp/0258-attach-injects-telemetry-via-settings-env.decision.md#version-floor)).
- Step 8 finds `decision` set but `source` null on a Claude Code between
  2.1.193 and 2.1.214: that is the documented gap, not drift. Upgrade and
  re-run rather than filing it.
- Step 3 finds an empty spool: check that the conversation ran in a session
  started **after** the attach (the settings `env` applies at launch), then
  check `jq '.env.OTEL_LOG_RAW_API_BODIES' "$SETTINGS"` names the
  spool with the `file:` prefix. If both hold, `OTEL_LOG_RAW_API_BODIES` is no
  longer honored upstream. That is the flag-stability failure LLP 0262 open
  question 5 predicts. File it and hold the release: events alone lose
  `system_text`, the `tools` list, and untruncated tool args.
- Step 4 finds a body whose keys have changed shape: file it with the observed
  key list before release and do not paper over it in the projector. The rows
  will keep landing with the affected columns null, which is exactly the silent
  loss this step exists to make loud.
- Step 5 finds the spool growing rather than draining: the listener is not
  consuming. Check `hyp status` for a `@hypaware/claude` source error, confirm
  the daemon restarted after step 4, and confirm the port in
  `OTEL_EXPORTER_OTLP_ENDPOINT` is the one the listener actually bound (a
  dynamic port moves across daemon restarts; `hyp client attach claude`
  rewrites it).
- Step 6 finds rows with `with_system = 0` and `with_tools = 0` while step 4
  passed: the bodies are being written but not joined. Check whether the body
  files are landing somewhere other than the attach-written spool, since a
  `body_ref` outside the spool is refused by containment and counted, not read.
- Step 7 finds no rows at all while step 6 found messages: the logs exporter is
  arriving and the metrics exporter is not, or vice versa. Check
  `OTEL_METRICS_EXPORTER` in the env block before suspecting the dataset.
- Step 9 shows `[capture gap]` right after a healthy step 6: the transcript
  probe sees session files newer than the last event, usually because the
  daemon was down for part of the run. Re-run steps 5 and 9 against a daemon
  that stayed up before filing anything.

---

## `codex_login_switch_reroute`

**What it proves:** that a Codex user can switch login mode (ChatGPT
subscription to API key) and the very next turn works, with no re-attach, no
daemon restart, and no `codex` restart, because the gateway routes on the
credential the request carries (LLP 0313). It also proves the half a fixture
cannot: that `api.openai.com/v1/responses` accepts the body Codex builds for
the neutral provider block, and that the rewritten path is one the OpenAI
platform actually serves.

**What it does not prove:** anything about a machine still pinned at the old
`/v1` `base_url` (an install that has not re-attached since the upgrade). A
subscription token arriving on `/v1` is not recoverable from the request, per
LLP 0313 #sk-never-reaches-chatgpt: only re-running `hyp client attach codex`
moves such a machine onto the neutral prefix, and it has to be run with the
daemon up (with no live endpoint to compare against, attach reports
`already attached` and rewrites nothing).

That re-attach is **manual**. The reconciler will not do it for you: an attach
marker goes stale on gateway-endpoint drift, on the asset set, and on Claude's
attach mode, and a route change moves none of the three, so an already-enrolled
machine keeps whatever `base_url` its last attach wrote. Machines attached in
subscription mode were already on `/backend-api/codex` and are unaffected;
machines attached in API-key mode sit at `/v1` until someone re-attaches them
by hand. Do not read a passing run of this procedure as evidence that enrolled
fleets migrated. Step 8 below exercises the
API-key-back-to-subscription switch, which IS covered once the neutral prefix
is in place. Nor does it prove anything about Codex Desktop, which shares
`config.toml` and is covered by `codex_desktop_capture`.

**Requires:** a machine with the Codex CLI installed and **both** credentials
available: a ChatGPT account you can `codex login` with, and an OpenAI
platform API key. HypAware installed from the package under test. Note the
`codex --version` you ran against and record it in the release notes: this
procedure is a check against upstream drift, so a passing run is only
evidence about the version it was run on.

**Related:** [LLP 0313](../llp/0313-codex-routes-by-credential.decision.md),
[LLP 0099](../llp/0099-codex-attach-auth-route.decision.md) (superseded).

### Steps

1. Log in with the **subscription** and attach:

   ```sh
   codex login                       # the ChatGPT subscription flow
   hyp client attach codex
   grep -A4 'model_providers.hypaware' "${CODEX_HOME:-$HOME/.codex}/config.toml"
   hyp status
   ```

   The provider block must read exactly:

   ```toml
   name = "HypAware Codex Gateway"
   base_url = "http://127.0.0.1:<port>/backend-api/codex"
   ```

   If `base_url` ends in `/v1`, or `name` mentions ChatGPT or OpenAI, you are
   not running the build under test. Stop.

2. Mark the window and note the row count, so later steps measure only new
   traffic. `$SINCE` has to be taken BEFORE step 3, because step 6 compares
   the subscription rows and the rerouted ones in one result:

   ```sh
   SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   hyp query sql "select count(*) from ai_gateway_messages"
   ```

3. Hold a short conversation with `codex` and let it answer. **This is the
   half that must not regress**: subscription traffic is forwarded byte for
   byte, unrewritten, exactly as before.

   ```sh
   hyp query sql "select provider, count(*) from ai_gateway_messages group by provider"
   ```

   Pass: new rows, and they carry `provider = 'chatgpt'`.

4. Now switch credentials **without touching anything else**. Do not
   re-attach, do not restart the daemon, and leave `config.toml` alone:

   Save the provider block in step 1 first, so there is something to compare
   against:

   ```sh
   # ...before step 4, right after the grep in step 1:
   grep -A4 'model_providers.hypaware' "${CODEX_HOME:-$HOME/.codex}/config.toml" > /tmp/codex-provider-before

   codex login --api-key "sk-..."    # or however this Codex spells it
   grep -A4 'model_providers.hypaware' "${CODEX_HOME:-$HOME/.codex}/config.toml" \
     | diff /tmp/codex-provider-before -
   ```

   Confirm `config.toml` is unchanged from step 1 (`diff` prints nothing and
   exits 0). If HypAware rewrote it,
   the neutral URL is not doing its job and this procedure is measuring the
   old repair path instead of the new routing.

5. Hold another short conversation with `codex`. **Do not restart `codex`
   first** if you can avoid it: the point of routing per request is that a
   running client keeps working. Note whether you restarted, and record it.

   Pass: the turn completes normally, with a real answer. A 401 mentioning
   scopes means the request still went to `chatgpt.com`; a 404 means it
   reached OpenAI at the wrong path.

6. Confirm the reroute was recorded, and recorded honestly:

   ```sh
   hyp query sql "
     select provider,
            json_extract_string(attributes, '$.gateway.path')          as arrived_at,
            json_extract_string(attributes, '$.gateway.upstream_path')  as sent_to,
            count(*)
     from ai_gateway_messages
     where message_created_at >= '$SINCE'
     group by 1, 2, 3
     order by 4 desc"
   ```

   Pass, all three together:

   - the new rows carry `provider = 'openai'`, not `chatgpt`. The column
     names the wire the request was sent on;
   - `arrived_at` is `/backend-api/codex/responses`, the door it came in at;
   - `sent_to` is `/v1/responses`, the wire it left on. This is the queryable
     reroute marker, and it is null for every row from step 3.

7. Confirm the message content actually projected, rather than landing as an
   unparsed exchange:

   ```sh
   hyp query sql "
     select role, left(content_text, 60)
     from ai_gateway_messages
     where provider = 'openai' and message_created_at >= '$SINCE'
     order by message_created_at desc limit 6"
   ```

   Pass: both a `user` and an `assistant` row with real text. The projector
   reads the **inbound** path to choose the body shape, so this is what
   proves the reroute did not confuse it.

8. Switch back to the subscription and hold one more conversation, to prove
   the move is not one-way:

   ```sh
   codex login
   ```

   Pass: the turn completes and its rows carry `provider = 'chatgpt'` with a
   null `sent_to`.

### If it fails

- **Step 5 returns a 401 about missing scopes.** The request still reached
  `chatgpt.com`, so the credential rung did not fire. Check the gateway saw
  the key at all - the gateway facts live in `attributes`, not in columns of
  their own, so read them with `json_extract_string(attributes,
  '$.gateway.path')` and `json_extract_string(attributes,
  '$.gateway.status_code')`.
  The likeliest causes are an operator config that declares an upstream named
  `openai-codex` (it must not), and a Codex that sends its key in something
  other than the `Authorization` header - the credential test reads that
  header only, though it does tolerate a missing or malformed scheme within
  it. Never paste the key itself into an issue, a log, or a query.
- **Step 5 returns a 404.** The host was right and the path was wrong, so the
  rewrite did not apply. Check `aigw.path_rewritten` in the daemon log: it
  names the upstream and both pathnames, and its absence means the matched
  upstream carried no rewrite.
- **Step 5 fails with a body or schema error from OpenAI.** This is the
  residual the design named and could not settle offline: the body Codex
  builds for this provider block is not one `/v1/responses` accepts. That is
  a real finding, not a flake. Record the exact error, the `codex --version`,
  and the request body shape, and treat it as a blocker for the release.
- **Step 6 shows `provider = 'chatgpt'` on rows that succeeded.** Routing
  worked and recording did not. The row must describe the wire it was sent
  on; a wrong value here yields a confident wrong number in cost attribution
  rather than an error, so do not wave it through.
- **Step 3 regresses (subscription traffic stops working).** Stop and revert.
  The neutral prefix exists precisely so the working direction is never
  rewritten, and a break there is worse than the bug being fixed.

---

## `launchd_supervisor_env`

**What it proves:** that a real installed LaunchAgent hands the daemon process
an `XPC_SERVICE_NAME` the shipped `detectSupervisor` accepts, so the automatic
self-update lanes on macOS (the daemon tick, and the pre-boot lane in
`bin/hypaware.js` that unsticks a machine from the front) actually apply
instead of refusing every update as unsupervised.

`detectSupervisor` believes launchd only when `XPC_SERVICE_NAME` equals the
daemon's own label, `com.hyperparam.hypaware`, or begins with that label
followed by a dot. Presence alone is deliberately not the test: macOS sets the
variable in terminals (`0`) and GUI apps (`application.<bundle>...`) too, so a
hand-run `hyp daemon run --foreground` carries one. No hermetic test can settle
which value launchd actually delivers, because every fixture asserts the value
the test itself wrote. Only a running LaunchAgent can answer, and a wrong
answer is quiet: `hyp status` keeps advertising the release and `hyp update`
keeps applying, so the only symptom is the `self_update.unsupervised` event.
The daemon tick writes it to `daemon.log`; the pre-boot lane writes it to
stderr, which under the LaunchAgent is `daemon.err.log`. Neither is anywhere a
user looks.

**What it does not prove:** anything about the systemd half of the same gate
(`INVOCATION_ID` on Linux, which `tr '\0' '\n' < /proc/<pid>/environ` answers
directly and which needs no procedure of its own); that an apply succeeds, that
its preflight passes, or that the relaunch lands; behavior on any macOS version
other than the one you ran it on; or the system-domain LaunchDaemon form, which
HypAware does not install.

**Required when:** a release changes `detectSupervisor`, `LAUNCH_LABEL`, or the
LaunchAgent plist the macOS installer writes (its `Label`,
`ProgramArguments`, or `EnvironmentVariables`). It is also required once
before the first release that ships the supervisor gate at all, to establish
the baseline value later releases diff against.

**Requires:**

- A real Mac, with the environment launchd builds. There is no substitute.
- HypAware installed globally from the package under test (`npm install -g`),
  not run from a checkout and not through `npx`. The self-update lanes refuse
  a non-global provenance before they ever reach the supervisor gate, so a
  checkout would pass this procedure while proving nothing.
- The daemon installed and started as a LaunchAgent (`hyp daemon install`,
  `hyp daemon start`), not `hyp daemon run --foreground`. A foreground daemon
  is exactly the unsupervised case.
- `jq` and `node` on `PATH`, and `sudo` if step 2 comes back empty.

**Related:**
[LLP 0365#restart-needs-a-supervisor](../llp/0365-self-update-cannot-strand-the-daemon.decision.md#restart-needs-a-supervisor)
(the gate this confirms),
[LLP 0309#unstick-from-the-front](../llp/0309-kernel-auto-update.decision.md#unstick-from-the-front)
(the pre-boot lane the gate also governs),
hyparam/hypaware#1257 (the deferred finding that asked for this procedure).

### Steps

1. Confirm the process you are about to read is the installed LaunchAgent, and
   that its environment is launchd's work rather than ours:

   ```sh
   HYP_HOME="$HOME/.hyp" hyp status
   launchctl print "gui/$(id -u)/com.hyperparam.hypaware" | grep -E '[[:space:]](state|pid) = '
   DPID=$(jq -r .pid "$HOME/.hyp/hypaware/run/hypaware.pid")
   plutil -p ~/Library/LaunchAgents/com.hyperparam.hypaware.plist
   echo "$DPID"
   ```

   Pass condition: `hyp status` shows a running daemon; `launchctl print`
   reports `state = running` and a `pid` equal to `$DPID`; and the plist has no
   `EnvironmentVariables` entry naming `XPC_SERVICE_NAME`. If the two pids
   differ, the pid file belongs to a hand-run daemon and every step below would
   measure a terminal's environment. Stop the stray process and start again. If
   the plist does set the variable, this procedure is reading a value HypAware
   wrote and is worthless; find out who added it before going on.

   The paths above are `$HOME/.hyp` and not `$HYP_HOME` on purpose, and
   `hyp status` is run with `HYP_HOME` pinned to the same value for the same
   reason. The installer renders no `EnvironmentVariables`, so the LaunchAgent
   inherits no `HYP_HOME`, and the running daemon's state root and log dir are
   home-anchored however your own shell is set. Reading them through an
   exported `HYP_HOME` would point an operator at an empty state root and
   then, by the paragraph above, at a healthy daemon as the culprit. The
   `launchctl print` output is filtered rather than truncated for the same
   reason: `pid` prints well past the `arguments` and `environment` blocks, so
   a head of the first dozen lines never reaches it.

2. Read `XPC_SERVICE_NAME` out of the running daemon's own environment:

   ```sh
   ps -Eww -p "$DPID" | tr ' ' '\n' | grep '^XPC_SERVICE_NAME='
   ```

   Pass condition: exactly one line, reading
   `XPC_SERVICE_NAME=com.hyperparam.hypaware`, or that label followed by a dot
   and more. That line is the baseline: copy it into the release notes verbatim.

3. Only if step 2 printed nothing. `ps -E` reads another process's environment
   through the kernel and a restricted host can refuse it, which is an absent
   answer and not a failing one. Ask launchd instead:

   ```sh
   sudo launchctl procinfo "$DPID" | grep XPC_SERVICE_NAME
   ```

   Pass condition: a line naming `com.hyperparam.hypaware`. `procinfo` prints
   the job's configured environment as well as the process's, so if two lines
   come back, take the one inside the `environment` block; step 1 already
   established the plist configures nothing here.

4. Judge the observed value with the shipped predicate rather than by eye, so
   this check cannot drift away from the code it is about:

   ```sh
   # If step 2 came back empty, set OBSERVED_XPC by hand from step 3 instead
   # of running this first line.
   OBSERVED_XPC=$(ps -Eww -p "$DPID" | tr ' ' '\n' | sed -n 's/^XPC_SERVICE_NAME=//p')
   DAEMON_BIN=$(plutil -convert json -o - \
     ~/Library/LaunchAgents/com.hyperparam.hypaware.plist | jq -r '.ProgramArguments[1]')
   OBSERVED_XPC="$OBSERVED_XPC" DAEMON_BIN="$DAEMON_BIN" \
     node --input-type=module -e '
       const { realpathSync } = await import("node:fs")
       const path = await import("node:path")
       const { pathToFileURL } = await import("node:url")
       const observed = process.env.OBSERVED_XPC
       if (!observed) throw new Error("OBSERVED_XPC is empty: a missing reading, not a false")
       const root = path.dirname(path.dirname(realpathSync(process.env.DAEMON_BIN)))
       console.error("package root: " + root)
       const mod = await import(pathToFileURL(path.join(root, "src/core/update/self_update.js")).href)
       console.log(mod.detectSupervisor({ XPC_SERVICE_NAME: observed }))
     '
   ```

   Pass condition: `true` on stdout. The `package root:` line goes to stderr so
   the verdict stays a single word; read it to confirm the module came from the
   install you meant. A `false` here is the finding this whole procedure exists
   to surface, and it blocks the release.

   Three details carry the step. The module is derived from the plist's own
   `ProgramArguments` and not from `npm root -g`: the shell's global root can
   be a different install than the one launchd runs (a version manager, a
   second prefix), and importing that one would be exactly the drift this step
   claims to rule out. The derivation resolves that path with `realpathSync`
   because the plist records `process.argv[1]`, which for any `npm install -g`
   is the bin symlink (`<prefix>/bin/hyp`) and not the file it points at;
   resolving it is what turns the recorded path into the package root the
   daemon actually loads, and without it the import would look for
   `<prefix>/src/core/update/self_update.js` and fail outright. And the snippet
   throws on an empty `OBSERVED_XPC` rather than judging it, because
   `detectSupervisor({ XPC_SERVICE_NAME: '' })` is `false`, and a missing
   reading must not be recorded as a failing one.

5. Check the daemon has not already refused an update on this host:

   ```sh
   grep -c self_update.unsupervised "$HOME/.hyp/hypaware/logs/daemon.log"
   grep -c self_update.unsupervised "$HOME/.hyp/hypaware/logs/daemon.err.log"
   ```

   Pass condition: `0` from both. Both files are needed: the daemon tick logs
   the event through the daemon logger into `daemon.log`, while the pre-boot
   lane in `bin/hypaware.js` writes it to stderr, which the LaunchAgent
   redirects to `daemon.err.log`. That lane runs on every relaunch launchd
   performs, so it is the likelier of the two to be holding a refusal, and a
   `daemon.log`-only check would report a clean `0` on a host that has been
   refusing updates for weeks. The event fires only when there was something
   to hand over: a newer version on the registry, or an installed root already
   ahead of the running one, so a zero on a machine that has had neither says
   nothing by itself. A nonzero count in either file on a host that passed
   step 4 is the finding: the gate refused under an environment other than the
   one you just read (a different login session, or a relaunch launchd
   performed differently). File it before release.

6. Record in the release notes: the exact `XPC_SERVICE_NAME` line from step 2
   or 3, the host's `sw_vers -productVersion`, and the step 4 verdict. The
   value is the baseline the next release diffs against; a bare "passed" makes
   the next run start from nothing.

### If it fails

- **Steps 2 and 3 both come back empty.** You have no reading, not a failed
  one. Do not record a pass. Confirm `$DPID` is alive (`ps -p "$DPID"`) and
  that it is the LaunchAgent's pid from step 1, then retry step 3 with `sudo`.
  A host where neither works cannot run this procedure; say so in the release
  notes rather than inferring the value.
- **Step 4 prints `false` and the observed value is `0` or
  `application.<bundle>...`.** That is a terminal's or a GUI app's value, so
  the pid was almost certainly not the LaunchAgent's. Go back to step 1. If
  the pid does check out, launchd genuinely is not naming this job in
  `XPC_SERVICE_NAME`, and the gate refuses every automatic apply on macOS.
  Hold the release and widen `detectSupervisor` against the value you actually
  observed. Do not remove the gate: without it the automatic lanes exit for a
  relaunch nobody will perform, which is the dead daemon
  [LLP 0365#restart-needs-a-supervisor](../llp/0365-self-update-cannot-strand-the-daemon.decision.md#restart-needs-a-supervisor)
  exists to prevent.
- **Step 4 prints `true` but the value is not exactly the label.** Check which
  job the suffix names before recording anything. HypAware installs a second
  LaunchAgent, `com.hyperparam.hypaware.node-system-ca`, whose only program is
  `launchctl setenv` and which carries `RunAtLoad` with no `KeepAlive`: it
  satisfies the dot-suffixed branch but relaunches nothing, so observing that
  value is a failure and not a pass, and it means `$DPID` was not the
  daemon's. Go back to step 1. For any other suffixed value, confirm against
  step 1 that the job it names is the daemon's own `KeepAlive` LaunchAgent.
  Then the dot-suffixed branch is doing the work, which is the design: record
  the exact value and leave the predicate alone, since narrowing it to the bare
  label would break the host you are standing on.
- **Step 1 reports the service is not loaded.** `hyp daemon install` was never
  run here, or `hyp daemon uninstall` removed it. There is nothing to measure
  until the LaunchAgent exists, and a foreground daemon is not a substitute.
- **`DAEMON_BIN` names a checkout or an `npx` cache rather than a global
  install.** The plist points launchd at whatever `hyp daemon install` was run
  from, so the daemon under test is not the packaged one and its provenance
  guard would refuse an apply long before the supervisor gate was consulted.
  Reinstall from the package under test (`npm install -g`, then
  `hyp daemon install`) and start again. If you are unsure which root it
  belongs to, step 4's `package root:` line for a global install sits directly
  under `npm root -g`; `DAEMON_BIN` itself never does, since it is the bin
  symlink beside that directory's parent.

## `github_since_inclusivity`

**What it proves:** whether GitHub's issues-family `since` window really is
inclusive of items whose windowed timestamp equals the `since` value, measured
against a real repository with a real token. It also records, for a release
reviewer counting rows, that a repeat `hyp github backfill` re-appends by
design.

The GitHub source polls three endpoints with `since`: `/issues` and
`/issues/comments` (windowed on `updated_at`) and `/commits` (windowed on the
committer date). Its watermark is the newest captured item's own
second-granularity timestamp, so under inclusive semantics every later tick
re-receives whatever sits exactly on that second. `openGate` in
`hypaware-core/plugins-workspace/github/src/capture.js` carries a boundary
floor that refuses those items by identity, and the hermetic fake in
`test/plugins/github-fake-client.js` models the inclusive case because it is
the strictly harder one. **No run against real GitHub has ever confirmed that
premise, and nothing in this repository records one.** The gate is correct
either way: under exclusive semantics the boundary items never come back at
all and the floor refuses nothing. So this procedure buys knowledge rather
than safety, before a later change is tempted to lean on the assumption.

**What it does not prove:** that the boundary floor may be removed. A confirmed
"exclusive" answer would make it inert on today's endpoints, not wrong, and
removing it would stake the no-duplicates property on a semantic GitHub has
never documented as stable. It also says nothing about the pulls pass, which
carries no `since` at all (it pages `sort=updated&direction=desc` and stops on
the high-water mark), nothing about GraphQL, and nothing about any endpoint
other than the three probed here.

**Required when:** once, to establish the fact, since it is unrecorded today.
Again if a release changes which endpoints carry `since`, or proposes to narrow
or remove the boundary floor on the strength of the answer.

**Requires:**

- A GitHub token with read access to the probe repository, exported as
  `GITHUB_TOKEN`, or a logged-in `gh` (`gh auth status`). The source resolves
  the same two, in that order.
- A repository with recent issue, comment, and commit activity, quiet enough
  that nothing is updated during the two requests of a probe. Your own fork is
  a good choice; a busy upstream is not.
- `gh` and `jq` on `PATH`.

**Related:**
[LLP 0360#cursoring](../llp/0360-github-source-is-bundled.decision.md#cursoring)
(the watermark this windows on),
[LLP 0361#page-work](../llp/0361-github-capture-is-work-budgeted.decision.md#page-work)
(equal-timestamp items are captured rather than skipped),
[LLP 0374](../llp/0374-repeat-github-backfill-re-appends.decision.md) (the
repeat-backfill half, settled),
hyparam/hypaware#1284 (the duplicate-row report),
hyparam/hypaware#1330 (the boundary floor),
hyparam/hypaware#1334 (the deferred finding that asked for this procedure).

### Steps

1. Name the repository and confirm the credential the source would use:

   ```sh
   REPO=owner/repo
   gh auth status
   gh api "repos/$REPO" --jq '.full_name + " pushed_at=" + .pushed_at'
   ```

   Pass condition: `gh auth status` reports a logged-in host, and the repo line
   prints. A `pushed_at` older than a few months usually means the commits
   probe in step 4 has nothing recent to stand on, which is fine, but pick a
   repo you know has issues and comments.

2. Probe `/issues`. Take the newest `updated_at` in the repository, then ask
   for exactly that window and look for the same issue coming back:

   ```sh
   T=$(gh api "repos/$REPO/issues?state=all&sort=updated&direction=desc&per_page=1" --jq '.[0].updated_at')
   N=$(gh api "repos/$REPO/issues?state=all&sort=updated&direction=desc&per_page=1" --jq '.[0].number')
   echo "boundary issue #$N at $T"
   gh api "repos/$REPO/issues?state=all&since=$T&per_page=100" \
     | jq --arg n "$N" '[.[] | select((.number|tostring) == $n)] | length'
   ```

   Read the last number: `1` means `since` is **inclusive** of the boundary
   second, `0` means **exclusive**. Either is a result; neither is a failure.

   Before recording a `0`, run the guard, because an issue updated between the
   two requests would leave the window legitimately:

   ```sh
   gh api "repos/$REPO/issues/$N" --jq .updated_at
   ```

   If that no longer equals `$T`, the repository moved under the probe. Discard
   the reading and repeat step 2 on a quieter repository.

3. Probe `/issues/comments`, the same shape on the comments listing:

   ```sh
   CT=$(gh api "repos/$REPO/issues/comments?sort=updated&direction=desc&per_page=1" --jq '.[0].updated_at')
   CID=$(gh api "repos/$REPO/issues/comments?sort=updated&direction=desc&per_page=1" --jq '.[0].id')
   echo "boundary comment $CID at $CT"
   gh api "repos/$REPO/issues/comments?since=$CT&per_page=100" \
     | jq --arg id "$CID" '[.[] | select((.id|tostring) == $id)] | length'
   ```

   Same reading as step 2, and the same guard
   (`gh api "repos/$REPO/issues/comments/$CID" --jq .updated_at`).

4. Probe `/commits`, which windows on the committer date rather than
   `updated_at`. The listing is reverse-chronological, so take the maximum over
   the first page rather than the first element:

   ```sh
   ST=$(gh api "repos/$REPO/commits?per_page=100" --jq '[.[].commit.committer.date] | max')
   SHA=$(gh api "repos/$REPO/commits?per_page=100" \
     | jq -r --arg t "$ST" '[.[] | select(.commit.committer.date == $t)][0].sha')
   echo "boundary commit $SHA at $ST"
   gh api "repos/$REPO/commits?since=$ST&per_page=100" \
     | jq --arg s "$SHA" '[.[] | select(.sha == $s)] | length'
   ```

   Commits are immutable once pushed, so this probe needs no re-read guard. A
   force-push during the probe is the only way to invalidate it, and it would
   change the sha.

5. Record the three readings verbatim in this file, under **Observed**, with
   the date and the repository you probed (or its visibility, if the name is
   private). A bare "passed" records nothing: the point of the procedure is the
   answer, not the exit status.

   If any probe answers **exclusive**, that is the more interesting result and
   it needs a second repository before it is believed: a per-endpoint
   difference is plausible, a global one would contradict the model every
   caller of `openGate` is written against. Two agreeing repositories is enough
   to record it. Nothing in the adapter changes on either answer; open an issue
   describing the observation and leave the floor in place.

### Observed

Nothing recorded yet. The three readings above are unconfirmed as of
2026-09-04: no run against a real token has been made, and the "inclusive"
statement in `openGate`'s note is the model the code was written to, not a
measurement. Add a dated row here on the first run.

### Repeat backfill re-appends (by design)

A release reviewer who runs `hyp github backfill` twice over unchanged history
will see `count(*)` on `github_events` grow, roughly doubling for the
repositories the run visited. That is the design and not a regression:

```sh
hyp query sql "select count(*) from github_events"
hyp github backfill owner/repo
hyp query sql "select count(*) from github_events"   # larger
hyp query sql "select count(distinct event_id) from github_events"
```

`hyp github backfill` resets each selected repository's cursor and re-fetches
its available history into an append-only dataset
([LLP 0360#capture-regimes](../llp/0360-github-source-is-bundled.decision.md#capture-regimes)),
invoking it after a completed backfill starts a deliberate new one
([LLP 0361#budget](../llp/0361-github-capture-is-work-budgeted.decision.md#budget)),
and rows an earlier attempt appended stay as valid snapshots
([LLP 0360#cursoring](../llp/0360-github-source-is-bundled.decision.md#cursoring)).
[LLP 0374](../llp/0374-repeat-github-backfill-re-appends.decision.md) records
that entailment and refuses a dedup against already-committed rows.

The idempotent trigger is the other one: `hyp github sync` and the daemon poll
resume from the durable cursor and append only what is new, including at the
watermark second, which is the property #1330 fixed and the hermetic tests
hold. A second `hyp graph project` after a repeat backfill does not double the
graph either, because the T0 contract keys on the natural keys settled by
LLP 0032. If a run of `hyp github sync` grows the row count over unchanged
history, that is a real regression and this is not the explanation.

### If it fails

- **`gh api` returns 401 or 403.** The token cannot read the repository, or
  `gh` is logged into the wrong host. Fix the credential before reading
  anything into a `0`: an empty listing and an excluded boundary item look
  identical at the jq layer.
- **Step 2 or 3 prints `0` and the guard shows the timestamp moved.** Not a
  reading. The repository was updated between the two requests. Repeat on a
  quieter repository rather than recording the result.
- **A probe listing comes back empty (`.[0]` is null and `T` is empty).** The
  repository has no issues, no comments, or no commits, so `since=` would carry
  an empty value and the probe would measure nothing. Pick a repository that
  has the resource, and do not record an absent reading as an exclusive one.
- **`hyp github backfill` reports the repository is not in the active
  inventory.** The default `inventory = "session_repos"` selects only
  repositories evidenced by local agent sessions
  ([LLP 0360#inventory](../llp/0360-github-source-is-bundled.decision.md#inventory)),
  and a positional argument narrows that set without expanding it. Set
  `inventory = "all_visible"` in the `[github]` config section for the probe
  run, keep the positional `owner/repo` so only that repository is captured,
  and put it back afterwards.

---

## Other candidates

`CLAUDE.md` lists further acceptance candidates that have no written
procedure yet: `installed_daemon_idle_soak`, `otel_self_loop_guard`,
`codex_subscription_capture`, `configured_sink_roundtrip`. Add them here as
they are written, in the same shape: what it proves, what it does not, the
exact commands, and the pass condition.
