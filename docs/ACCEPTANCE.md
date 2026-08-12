# Acceptance procedures (opt-in, manual)

Acceptance checks are the third tier of the test model in `CLAUDE.md`. They
use the packaged CLI, a real daemon, a real user home, and real client
traffic, so they cannot run in CI and cannot run under the hermetic smoke
harness (`hypaware-core/smoke/lib/harness.js` forces a temp `HYP_HOME` and
`HYP_DEV_TELEMETRY=1`, which is the opposite of what these prove).

Each procedure below is run by a human, on a machine that has the client
installed, before a release that touched the relevant adapter. Record the
result in the release notes. **Do not mark one passed unless you ran it.**

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
   hyp attach codex
   grep -n 'model_providers.hypaware' "${CODEX_HOME:-$HOME/.codex}/config.toml"
   hyp status --full
   ```

   `hyp status --full` must show `codex  [configured, attached]` and a running
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

   Pass condition: the `activity` row names `codex/<entrypoint>` with the same
   `entrypoint` string you just observed, at an age of a few minutes. This is
   read from the running daemon's `status.json`, not from the cache
   ([LLP 0164](../llp/0164-status-names-recent-clients-from-gateway-entrypoints.decision.md)),
   so two things follow and both are expected, not failures: a daemon that
   has been restarted since the conversation shows nothing here (the rows are
   still in the cache - step 4 is the durable check), and the row is capped to
   the three most recent surfaces this daemon process has seen
   ([LLP 0212](../llp/0212-status-is-a-triage-summary.decision.md)); use
   `hyp status --full` for the complete, uncapped list.

5. Confirm the backfill route independently. The rollout tree is shared by
   Codex CLI and Codex Desktop, so the session from step 3 must also be
   re-importable from disk:

   ```sh
   NEWEST=$(find "${CODEX_HOME:-$HOME/.codex}/sessions" -name '*.jsonl' -print0 \
     | xargs -0 ls -t | head -1)
   grep -m1 session_meta "$NEWEST"
   hyp backfill codex --since "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" --json
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
   HYP_DEV_TELEMETRY=1 hyp backfill codex --dry-run --json >/dev/null
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
   hyp detach codex
   grep -n 'hypaware' "${CODEX_HOME:-$HOME/.codex}/config.toml" || echo 'clean'
   ```

   Then, if this is your working machine, re-attach so you do not silently
   leave Codex capture off:

   ```sh
   hyp attach codex
   ```

### If it fails

- No rows at all in step 4: check `hyp status` for a warning that codex
  settings show no HypAware marker (`client_attach_missing` in `--json`)
  or a stopped daemon, and confirm you fully quit Desktop rather than closing
  its window.
- Rows arrive but `entrypoint` is null: Codex sent no `originator` header on
  that route. Capture still worked; attribution did not. File that as its own
  issue with the observed request path, and do not paper over it by matching
  on `client_name` alone. `hyp status`'s `activity` row will also be missing
  the Desktop entry, for the same one reason: it counts `entrypoint` values
  and invents nothing for a row that has none.
- The query in step 4 finds Desktop rows but `hyp status`'s `activity` row
  names nothing recent: the daemon that captured them has since restarted
  (the tracker is in-memory and daemon-scoped by design), or the gateway
  wrote no status refresh before it exited. Re-run step 3 against the current
  daemon before filing anything.
- Step 5 finds no rollout for the session: Desktop wrote its history
  somewhere other than `$CODEX_HOME/sessions`. That would invalidate
  [LLP 0141](../llp/0141-codex-desktop-rides-the-codex-adapter.decision.md)'s
  backfill half and needs a doc correction, not a code workaround.

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
capture is reversible via `hyp detach`.

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
- **The `client_attach` status-row re-confirmation in steps 1 and 7 needs
  PR #553 (fix/issue-544) merged.** Without it, a now-probed `openclaw`
  (its `attach_probe` is real again as of this change set, for the first
  time since [LLP 0143](../llp/0143-openclaw-registers-no-attach-probe.decision.md))
  falls back to whatever pre-#553 `hyp status` did for a client that used
  to be probe-less, which this procedure was not written to describe.

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
   hyp attach --client openclaw
   openclaw agent --agent <agent-id> --model anthropic/<a-claude-model> \
     --message "pre-restart probe, should not route through the gateway"
   hyp query sql "select count(*) from ai_gateway_messages where conversation_source = 'openclaw'"
   ```

   Pass condition for item 4: the two counts are equal. `hyp attach` wrote
   the config, but a running OpenClaw gateway does not pick up
   `models.providers` changes until restarted, so the probe turn above
   still went out at OpenClaw's original `baseUrl`, not the gateway's.

   Now run the restart instruction `hyp attach` printed:

   ```sh
   openclaw gateway restart
   ```

   Then confirm the write itself and the daemon's view of it:

   ```sh
   hyp status --full
   jq '.models.providers | {anthropic, openai}' "${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
   ```

   Pass condition: `hyp status --full` shows a running daemon and
   `openclaw  [configured, attached]` among the clients, with no
   `client_attach_missing` diagnostic (this is the PR #553 re-confirmation:
   a probe-less `openclaw` used to be stuck reading as `attach n/a`
   regardless of what was on disk). The `jq` output shows
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
   SINCE_SQL=${SINCE%Z}
   hyp query sql "
     select count(*) from ai_gateway_messages
     where conversation_source = 'openclaw'"
   ```

   `$SINCE` is the ISO instant `hyp backfill --since` takes; `$SINCE_SQL`
   is the same instant without the zone suffix, which is what compares
   cleanly against the `message_created_at` TIMESTAMP column.

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
       and message_created_at >= '$SINCE_SQL'
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
       and message_created_at >= '$SINCE_SQL'"
   hyp query sql "
     select part_id, count(*) n
     from ai_gateway_messages
     where conversation_source = 'openclaw'
       and message_created_at >= '$SINCE_SQL'
     group by part_id
     having count(*) > 1"
   ```

   Pass condition: the first count is unchanged from step 4's total (the
   scheduled sweep found the same two turns already settled onto their
   session file's native identity and wrote nothing new), and the second
   query returns zero rows (no `part_id` in the window appears more than
   once). This is R11 proven against the daemon's own automatic scheduler
   rather than a manually-invoked `hyp backfill`, which is the whole point
   of Lane B being *scheduled*, not just present.

6. Sweep step: prove a turn Lane A never saw still lands, at transcript
   fidelity, within one sweep interval. Detach first, so the turn below
   has no live route to travel:

   ```sh
   hyp detach --client openclaw
   openclaw gateway restart
   SINCE2=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   SINCE2_SQL=${SINCE2%Z}
   openclaw agent --agent <agent-id> --model anthropic/<a-claude-model> \
     --message "In one sentence, what is a hash collision?"
   hyp query sql "
     select count(*) from ai_gateway_messages
     where conversation_source = 'openclaw'
       and message_created_at >= '$SINCE2_SQL'"
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

   Pass condition: no matches. `hyp detach` best-effort purges every
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
       and message_created_at >= '$SINCE2_SQL'"
   ```

   Pass condition: `1`. The scheduled sweep picked the turn up once its
   session file cleared the quiesce window, at transcript fidelity, with
   no live route involved at all.

   Re-attach so this machine is not left silently uncaptured on the live
   lane, and restart once more:

   ```sh
   hyp attach --client openclaw
   openclaw gateway restart
   ```

7. Re-confirm [LLP 0167#verify-results](../llp/0167-openclaw-capture-via-config-provider-override.rfc.md#verify-results)
   items 1, 3, and 4 on this OpenClaw version, per **Requires**. This step
   is a recap, not new commands: each item was already exercised above.

   - **Item 1** ("merges, but only with `models: []`"): confirmed by step
     1's `jq` check and `openclaw models list --all` still showing the
     full catalog.
   - **Item 3** ("no self-heal"): confirmed by step 6's cache-purge grep
     returning no matches after `hyp detach`.
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
  **Requires** first, then confirm PR #553 is actually in the binary under
  test (a probe-less-client `attach n/a` state is exactly what an unmerged
  #553 reproduces here).
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
  `hyp detach` did not actually remove the override entries, most likely
  because the entry on disk was not one this gateway wrote (a hand-edited
  `baseUrl`, or `models` non-empty) and the detach backed it up instead of
  deleting it, per
  [LLP 0163](../llp/0163-attach-backs-up-a-malformed-block.decision.md)'s
  backup-not-discard rule. Check the detach command's own warning output
  before concluding the turn leaked.

---

## Other candidates

`CLAUDE.md` lists further acceptance candidates that have no written
procedure yet: `installed_daemon_idle_soak`, `otel_self_loop_guard`,
`codex_subscription_capture`, `configured_sink_roundtrip`. Add them here as
they are written, in the same shape: what it proves, what it does not, the
exact commands, and the pass condition.
