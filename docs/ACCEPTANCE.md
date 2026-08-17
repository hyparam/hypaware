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
   hyp status
   jq '.models.providers | {anthropic, openai}' "${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
   ```

   Pass condition: `hyp status` shows a running daemon and
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

## `claude_proxy_capture`

**What it proves:** that proxy-mode attach ([LLP 0231](../llp/0231-proxy-mode-capture.rfc.md),
design [LLP 0245](../llp/0245-proxy-mode-capture.design.md)) works end to end
against a real, installed daemon and a real macOS keychain: attach writes
only the two proxy-mode environment keys into `~/.claude/settings.json`, the
keychain trust dialog names every intercepted provider host, the launchd
environment carries `NODE_USE_SYSTEM_CA`, a live Claude Code session lands
rows in `ai_gateway_messages` while Remote Control's inbound channel keeps
working (the reason this design exists at all), `hyp status` reports the
trust state, and detach, purge and uninstall each remove exactly what they
are supposed to and nothing more.

**What it does not prove:** anything about the Codex adapter (Codex stays on
base-URL attach and is out of this design's scope), anything about
`upstream_proxy` field-testing against a corporate egress proxy (an open
item, not covered here), the exact Bun trust-store behaviour underlying
[LLP 0236](../llp/0236-claude-code-split-trust-stores.research.md) (its
canary caveat is a standing risk this procedure can only observe the
symptom of, not the cause), or fleet forwarding. It also proves nothing
about base-URL attach, which is the default and is already exercised by
`hyp smoke gateway_claude_capture` and `hyp smoke client_attach_idempotent`.

**Requires:**

- A real Mac (the keychain trust dialog and `launchctl` env delivery are
  Darwin-only; see [LLP 0237](../llp/0237-attach-trusts-ca-in-login-keychain.decision.md)
  #darwin-only). Do not attempt this on Linux; the design states Remote
  Control inbound is unsupported there under proxy mode and there is no
  dialog or launchd table to check.
- Claude Code installed and signed in, with Remote Control reachable from a
  second device (the mobile app or web) so step 4 has something to pair
  against.
- HypAware installed from the package under test, with no prior HypAware CA
  trusted in the login keychain (a machine that has run this procedure
  before will not see the dialog again in step 2; that is expected, not a
  failure, per [LLP 0238](../llp/0238-long-lived-ca-full-provider-constraints.decision.md)
  #ca-survives-detach. Run `hyp detach claude --purge` first if you need a
  clean first-trust observation).

**Related:** [LLP 0231](../llp/0231-proxy-mode-capture.rfc.md) (the request),
[LLP 0245](../llp/0245-proxy-mode-capture.design.md) (the design this
procedure gates, sections 1, 4 and 6),
[LLP 0237](../llp/0237-attach-trusts-ca-in-login-keychain.decision.md)
(keychain trust), [LLP 0238](../llp/0238-long-lived-ca-full-provider-constraints.decision.md)
(CA and trust survive detach), [LLP 0239](../llp/0239-node-use-system-ca-via-launchd.decision.md)
(the launchd delivery and its terminal caveat).

### Steps

1. Turn proxy mode on and do a **real** daemon install and start (not
   `hyp daemon foreground`; this procedure exists specifically to exercise
   the real launchd service and the real keychain, which a foreground dev
   run never touches):

   ```sh
   jq '.plugins |= map(if .name == "@hypaware/ai-gateway"
         then .config.proxy_mode = true else . end)' \
     ~/.hyp/hypaware-config.json > /tmp/hypaware-config.json \
     && mv /tmp/hypaware-config.json ~/.hyp/hypaware-config.json
   hyp daemon install
   hyp daemon start
   hyp status
   ```

   Pass condition: `hyp status` shows the daemon running and, under
   `sources:`, the gateway source `[running]`. If the daemon is not running,
   nothing below can work: the CA-existence preflight in step 2 refuses on
   purpose rather than attaching against a dead gateway
   ([LLP 0245#claude-attach](../llp/0245-proxy-mode-capture.design.md#claude-attach)
   #proxy-attach-preflight).

2. Attach Claude Code and watch for the keychain dialog:

   ```sh
   hyp attach claude
   ```

   A macOS password/consent dialog should appear during this command on a
   machine with no prior HypAware trust, naming **HypAware Local CA** as the
   certificate and offering to add it as a trusted root. Read the dialog
   text: it must name (or the surrounding attach output must state) all
   three hosts the CA is constrained to, `api.anthropic.com`,
   `api.openai.com`, and `chatgpt.com`, not only the one this attach is for
   ([LLP 0238](../llp/0238-long-lived-ca-full-provider-constraints.decision.md)
   #full-provider-constraints: one certificate, one dialog, every provider,
   and the grant must be informed about all of them). Approve it.

   Confirm the settings write:

   ```sh
   cat ~/.claude/settings.json | jq '.env'
   ```

   Pass condition: `env` carries exactly `HTTPS_PROXY` and
   `NODE_EXTRA_CA_CERTS` and nothing else HypAware manages for proxy mode.
   In particular `ANTHROPIC_BASE_URL`, `ENABLE_TOOL_SEARCH`, and
   `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` must be **absent** (or, if this
   machine previously ran base-URL attach, must have been released by the
   mode migration, not merely left stale)
   ([LLP 0232](../llp/0232-claude-attaches-by-proxy.decision.md)
   #mode-migration). `NODE_EXTRA_CA_CERTS` must point at
   `~/.hyp/hypaware/tls/ca-cert.pem` (or
   `$HYP_HOME/hypaware/tls/ca-cert.pem`).

3. Confirm the launchd environment, respecting the terminal caveat: only
   processes launchd starts **after** the `setenv` see the variable, and a
   terminal app is single-process, so a window that predates step 2 will not
   see it even though it is genuinely set
   ([LLP 0239](../llp/0239-node-use-system-ca-via-launchd.decision.md)
   #terminals-predating-attach). Read attach's own final output line first:
   it states this caveat explicitly. Then, in the **same terminal window**
   you ran step 2 in (do not open a new window yet):

   ```sh
   launchctl getenv NODE_USE_SYSTEM_CA
   ```

   Pass condition: `1`. This reads launchd's table directly, so it passes
   regardless of the terminal caveat above; the caveat only matters for
   whether a *shell's own* `$NODE_USE_SYSTEM_CA` is set, which this command
   does not test. Now **fully quit and reopen your terminal application**
   (closing the window is not enough; the app itself must relaunch) and
   confirm the shell environment a freshly-launched Claude Code process
   would actually inherit:

   ```sh
   echo $NODE_USE_SYSTEM_CA
   ```

   Pass condition: `1`, only after the full quit-and-reopen. A pre-existing
   window still printing empty here is the expected, documented gap, not a
   failure; do not file it.

4. Hold a Claude Code session and confirm both halves of the RFC's point:
   capture works, and Remote Control still does too.

   ```sh
   hyp query sql "select count(*) from ai_gateway_messages"
   ```

   Note the count, then **fully quit and reopen Claude Code** (it reads
   `settings.json` at launch) and hold a short conversation: send at least
   one message and let it answer.

   ```sh
   TODAY=$(date -u +%Y-%m-%d)
   hyp query sql "
     select entrypoint, client_name, count(*) n, max(message_created_at) last_seen
     from ai_gateway_messages
     where date >= '$TODAY'
     group by 1, 2
     order by last_seen desc"
   ```

   Pass condition: a new row whose `client_name` names Claude, `entrypoint`
   is populated, and `last_seen` is inside the last few minutes, with the
   total count grown against the value noted above.

   Now, without quitting Claude Code again, pair the second device to
   Remote Control (or, if already paired from before this procedure, send
   one instruction from it) and confirm it drives this session. Pass
   condition: Remote Control connects and controls the session normally,
   with no "Remote Control is only available when using Claude via
   api.anthropic.com" refusal. This is the one observation the whole design
   exists to produce: base-URL attach would have failed this step.

5. Confirm `hyp status` reports the trust state:

   ```sh
   hyp status
   hyp status --json | jq '.proxy_trust'
   ```

   Pass condition: the text output has a `proxy trust:` block naming the CA
   fingerprint, `login keychain: trusted`, and
   `launchd env: NODE_USE_SYSTEM_CA=1 set`; the JSON
   carries the same three facts as `ca_fingerprint`, `ca_trusted: true`, and
   `launchd_env_set: true`
   ([LLP 0245#status](../llp/0245-proxy-mode-capture.design.md#status),
   `ProxyTrustReport`).

6. Detach and confirm the CA and its trust survive, per
   [LLP 0238](../llp/0238-long-lived-ca-full-provider-constraints.decision.md)
   #ca-survives-detach:

   ```sh
   hyp detach claude
   cat ~/.claude/settings.json | jq '.env'
   launchctl getenv NODE_USE_SYSTEM_CA
   hyp status --json | jq '.proxy_trust'
   security find-certificate -c "HypAware Local CA" ~/Library/Keychains/login.keychain-db
   ```

   Pass condition: `env` no longer carries `HTTPS_PROXY` or
   `NODE_EXTRA_CA_CERTS` (restored from the marker's `prev_env`, or removed
   if none existed); `launchctl getenv` now prints nothing (the launchd
   environment and its LaunchAgent are removed, since that half is
   recreatable for free and follows the attach per
   [LLP 0239#launchctl-setenv](../llp/0239-node-use-system-ca-via-launchd.decision.md#launchctl-setenv));
   but `hyp status --json`'s `.proxy_trust.ca_trusted` is still `true` and
   the `security find-certificate` call still finds the CA. Re-attaching
   after this point should show no keychain dialog, proving the trust grant
   really did survive:

   ```sh
   hyp attach claude
   ```

7. Purge, then uninstall, and confirm every artifact this design created is
   gone:

   ```sh
   hyp detach claude --purge
   security find-certificate -c "HypAware Local CA" ~/Library/Keychains/login.keychain-db
   ls ~/.hyp/hypaware/tls/ 2>&1 || echo 'tls dir gone'
   ```

   Pass condition: `security find-certificate` now fails to find the
   certificate, and the `tls/` directory under the state root is gone or
   empty of key material.

   ```sh
   hyp daemon uninstall
   ls ~/Library/LaunchAgents/ | grep hyperparam || echo 'no hypaware launchd residue'
   ```

   Pass condition: no HypAware daemon or `node-system-ca` LaunchAgent plist
   remains under `~/Library/LaunchAgents`, and `hyp status` (if you still
   have the binary) reports no running daemon.

   Then, if this is your working machine, re-install and re-attach so you do
   not silently leave it uncaptured:

   ```sh
   hyp daemon install
   hyp daemon start
   hyp attach claude
   ```

### If it fails

- `hyp attach claude` refuses outright before any dialog appears: check that
  step 1's `proxy_mode: true` edit actually landed and that `hyp daemon
  restart` (or a fresh `hyp daemon start`) ran after it; the CA-existence
  preflight refuses on purpose when the gateway is not actually running in
  proxy mode, and this is correct behaviour, not a bug to route around.
- No dialog in step 2 on a machine that has never run this procedure:
  confirm no earlier HypAware install already trusted a CA under this same
  login keychain (`security find-certificate -c "HypAware Local CA" ...`);
  if one exists, `hyp detach claude --purge` first for a clean observation.
  A refused or dismissed dialog is not a failure on its own: attach still
  completes and states plainly that Remote Control inbound will not work
  ([LLP 0237#attach-anyway-on-refusal](../llp/0237-attach-trusts-ca-in-login-keychain.decision.md#attach-anyway-on-refusal));
  re-running `hyp attach claude` retries the dialog.
- Step 3's `echo $NODE_USE_SYSTEM_CA` is empty even after a full quit and
  reopen of the terminal application: confirm you quit the *application*,
  not just the window (window managers and some terminal emulators keep the
  process alive across "close window"); confirm `launchctl getenv` (which
  does not have this caveat) shows `1` first to isolate whether the launchd
  side or the terminal side is the gap.
- Step 4 shows new rows but Remote Control still refuses: check
  `~/.claude/settings.json` for a lingering `ANTHROPIC_BASE_URL` (mode
  migration should have released it; a stale value here means migration
  regressed), then check `hyp status --json | jq '.proxy_trust.ca_trusted'`
  for `false` (an untrusted CA is exactly the state that leaves capture
  working and Remote Control inbound broken, per
  [LLP 0245#failure-modes](../llp/0245-proxy-mode-capture.design.md#failure-modes)).
  If both are clean, and the refusal names the *account* rather than the base
  URL ("Remote Control environments are not available for your account"), it
  is the absolute-form regression, not the trust story: the bridge client
  sends absolute-form requests straight at the proxy port and the gateway
  must route them by the host the request line names
  ([LLP 0246](../llp/0246-remote-control-absolute-form-requests.issue.md),
  [LLP 0247](../llp/0247-absolute-form-third-front-door.decision.md)).
  Otherwise this may be the LLP 0236 canary: an upstream Bun
  behaviour change silently breaking Remote Control's trust-store lookup is
  out of this design's control; file it against claude-code#75050 rather
  than against this procedure.
- Step 4 shows no new rows at all: confirm `proxy_mode_error` is absent from
  the gateway source's details in the daemon status file, which is where the
  source publishes it (`hyp daemon status --json | jq '.sources[] |
  select(.plugin == "@hypaware/ai-gateway") | .details'`; note `hyp status
  --json`'s own `.sources` carries only name, plugin and state, not the
  details block). A CA-preparation failure at boot degrades the gateway to
  reverse-proxy-only, so an attached proxy-mode client's traffic never gets
  terminated. Then confirm you fully quit and reopened Claude Code so it
  re-read `settings.json`.
- Step 6 finds the CA no longer trusted, or the `tls/` directory gone, right
  after a plain `hyp detach claude` (no `--purge`): this is the LLP 0238
  regression to watch for specifically, since keeping the CA and trust
  across detach is the entire point of that decision; do not treat "detach
  cleaned up everything" as a pass here the way it would for the settings
  keys.
- Step 7 still finds the certificate after `hyp detach claude --purge`:
  confirm `purgeProxyTrustResidue` actually ran (its output names the
  keychain and CA removal explicitly); a permission prompt cancelled
  mid-purge can leave the keychain entry behind while still removing the CA
  files on disk, which is worth filing as its own gap rather than assuming
  the whole purge silently no-op'd.

---

## Other candidates

`CLAUDE.md` lists further acceptance candidates that have no written
procedure yet: `installed_daemon_idle_soak`, `otel_self_loop_guard`,
`codex_subscription_capture`, `configured_sink_roundtrip`. Add them here as
they are written, in the same shape: what it proves, what it does not, the
exact commands, and the pass condition.
