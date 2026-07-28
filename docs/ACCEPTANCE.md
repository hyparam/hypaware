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

**Related:** [LLP 0141](../llp/0141-codex-desktop-rides-the-codex-adapter.decision.md).

### Steps

1. Attach Codex and confirm the marker landed in the file Desktop reads:

   ```sh
   hyp attach codex
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

- No rows at all in step 4: check `hyp status` for `client_attach_missing`
  or a stopped daemon, and confirm you fully quit Desktop rather than closing
  its window.
- Rows arrive but `entrypoint` is null: Codex sent no `originator` header on
  that route. Capture still worked; attribution did not. File that as its own
  issue with the observed request path, and do not paper over it by matching
  on `client_name` alone.
- Step 5 finds no rollout for the session: Desktop wrote its history
  somewhere other than `$CODEX_HOME/sessions`. That would invalidate
  [LLP 0141](../llp/0141-codex-desktop-rides-the-codex-adapter.decision.md)'s
  backfill half and needs a doc correction, not a code workaround.

---

## Other candidates

`CLAUDE.md` lists further acceptance candidates that have no written
procedure yet: `installed_daemon_idle_soak`, `otel_self_loop_guard`,
`codex_subscription_capture`, `configured_sink_roundtrip`. Add them here as
they are written, in the same shape: what it proves, what it does not, the
exact commands, and the pass condition.
