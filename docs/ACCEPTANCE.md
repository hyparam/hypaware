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
`ai_gateway_messages` on this machine, by both routes the OpenClaw adapter
offers (live proxy capture through the steering plugin's shadow providers,
and session-transcript backfill), that the rows name the real upstream
rather than the `hypaware-*` shadow the turn resolved to, and that a turn
the plugin refuses to steer passes through and is warned about instead of
vanishing silently.

**What it does not prove:** anything about OpenClaw's CLI backends (a
Claude Code or Codex turn run through OpenClaw belongs to the sibling
adapters, [LLP 0147](../llp/0147-cli-backends-are-transcript-captured.decision.md)),
anything about whether a deferred provider family *would* work if it were
steered ([LLP 0146](../llp/0146-host-signed-providers-out-of-shadow-steering.decision.md)
defers those untested, and step 5 only proves the deferral is reported),
anything about fleet forwarding, or anything on a machine other than the
one you ran it on.

**Requires:**

- OpenClaw installed with a working `~/.openclaw`, and credentials
  configured for **both** `anthropic` and `openai`. Both shapes are
  needed: the `openai` turn is the only observation that proves
  `x-hypaware-upstream` actually arrives (step 4).
- **OpenClaw 2026.4.24 or newer** (`openclaw --version`). The
  `before_model_resolve` hook this plugin steers from arrived in 2026.4.21,
  and the `hooks.allowConversationAccess` gate below arrived with the
  2026.4.23 plugin-config schema. On an older build the config key is
  rejected outright (`Unrecognized key: "allowConversationAccess"`, and
  OpenClaw rolls the file back to last-known-good), which leaves the plugin
  loading and registering both providers while steering nothing. Check the
  version first: every later step reads as a HypAware failure when the real
  cause is the host.
- HypAware installed from the package under test, `@hypaware/openclaw`
  enabled, daemon running.
- The steering plugin installed into OpenClaw *from the tree under test*.
  It is not on npm at the point this procedure must first run (R12 wants a
  human run **before** the adapter ships), so link it from the checkout:

  ```sh
  openclaw plugins install --link ./openclaw-steering-plugin --force
  openclaw plugins enable hypaware-openclaw-steering
  ```

- Two entries in `~/.openclaw/openclaw.json`. Both are mandatory and
  neither is self-announcing when missing:

  ```json5
  {
    env: { HYP_GATEWAY_ENDPOINT: "http://127.0.0.1:18521" },
    plugins: {
      entries: {
        "hypaware-openclaw-steering": {
          hooks: { allowConversationAccess: true },
        },
      },
    },
  }
  ```

  `before_model_resolve` is one of OpenClaw's raw conversation hooks, and
  OpenClaw will not run it for a non-bundled plugin without
  `allowConversationAccess`: the gate applies only to plugins loaded from
  `plugins.load.paths` (which is exactly where `--link` puts this one), and
  when it blocks, `api.on(...)` returns without throwing. The providers
  still register, the plugin still reports as loaded, no turn is ever
  steered, and the only trace is a `pluginDiagnostics` warning in the
  gateway log. `HYP_GATEWAY_ENDPOINT` is read
  once at plugin load; absent it the plugin assumes the fixed default port
  ([LLP 0114](../llp/0114-gateway-default-listen-port-fixed.decision.md)),
  which is wrong whenever the daemon fell back to an ephemeral bind. Put
  the real value there (step 1 reads it) and restart the OpenClaw gateway
  (`openclaw gateway restart`) so plugin code and config both reload.

**Related:** [LLP 0157](../llp/0157-openclaw-full-capture.spec.md) (the
requirements this procedure checks), [LLP 0161](../llp/0161-openclaw-full-capture.design.md)
(the design), [LLP 0159](../llp/0159-openclaw-route-agreement-by-settlement.decision.md)
(why step 6 passes on zero writes).

### Steps

1. Confirm the shadow providers registered and the steering hook is live.
   There is no settings marker to grep here: the adapter writes nothing to
   `openclaw.json` and declares no `attach_probe` (R7), so `hyp attach
   openclaw` has nothing to leave behind. The assertion moves to OpenClaw's
   own runtime introspection:

   ```sh
   hyp status
   jq -r '.sources[] | select(.plugin == "@hypaware/ai-gateway")
          | "http://\(.details.host):\(.details.port)"' \
     "${HYP_HOME:-$HOME/.hyp}/hypaware/run/status.json"
   INSPECT=$(openclaw plugins inspect hypaware-openclaw-steering --runtime --json)
   printf '%s\n' "$INSPECT"
   for token in hypaware-anthropic hypaware-openai before_model_resolve; do
     printf '%-24s %s\n' "$token" "$(printf '%s' "$INSPECT" | grep -c -- "$token")"
   done
   ```

   Pass condition: `hyp status` shows a running daemon and `openclaw` among
   the clients; the printed gateway URL equals the `HYP_GATEWAY_ENDPOINT`
   you configured; the report says the plugin is loaded (not errored, not
   disabled); and all three tokens are present in it. `openclaw plugins
   list` will not do instead: it is a cold registry read, while `inspect
   --runtime` imports the module and reports the tools, hooks, services,
   gateway methods and commands a live gateway actually registered.

   Read the report, do not assert against a key path. OpenClaw documents
   `--runtime --json` as the machine-readable form of the same report and
   describes its *contents* (identity, load status, source, registered
   capabilities, hooks, diagnostics) without publishing a key schema, so
   the field names are its to change between releases and a `jq` selector
   written here would fail as a missing key rather than as a missing
   registration - a false negative pointing at the wrong system. Grepping
   the three tokens is version-proof by comparison: two are provider ids
   this repo owns (`openclaw-steering-plugin/src/index.js`) and the third
   is OpenClaw's own documented hook name. None of them is a key name
   OpenClaw invents for the shape of its report.
   `openclaw plugins inspect hypaware-openclaw-steering --runtime` without
   `--json` prints the same report for a human to read.

   If your build has no `--runtime` flag (it is absent from some published
   CLI references, and `inspect` alone is a cold manifest and registry
   check that cannot prove registration), do not substitute the cold read.
   Skip to step 3 and let step 4 carry this assertion instead: an `openai`
   row there is only reachable through both shadow providers and a hook
   that steered, so it proves at once what this step checks separately.

   Expect `hyp status` to carry **no** `client_attach_missing` warning for
   `openclaw`, and its clients row to read `[configured, attach n/a]`
   rather than `not attached`. That absence is the pass condition, not a
   regression: with no `attach_probe` (R7) there is no marker to miss,
   `hyp attach openclaw` is a documented no-op, and status derives attach
   state by the same gate the attach reconciler does
   ([LLP 0143 #status-derives-by-the-same-gate](../llp/0143-openclaw-registers-no-attach-probe.decision.md#status-derives-by-the-same-gate),
   #544). On a joined host the `client actions:` section shows `attach
   openclaw [n/a]` for the same reason; a `backfill @hypaware/openclaw
   [pending]` row beside it is a real, unrelated target. None of these
   lines says anything about capture either way.

2. Note the current row count and pin the window, so steps 4 and 6 measure
   only new traffic:

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
   minutes, and the count grew against step 2. Neither row may say
   `hypaware-anthropic` or `hypaware-openai`: a shadow id in this column is
   an R6 failure, not a cosmetic one.

   The `openai` row is the load-bearing one, and it is this procedure's
   proof that `x-hypaware-upstream` arrives at the gateway. The projector
   reads the provider from that header and falls back to `anthropic` when
   it is absent, so an `anthropic` row alone cannot tell "steered, header
   arrived" from "header lost, fell back". Only a row that says `openai`
   proves the header survived the trip from the hook to the projection.

5. Exercise the warning ledger against a deferred provider family. Pick one
   whose declared `api` is `anthropic-messages` or `openai-completions`: the
   `deferred` branch only runs for a candidate that *shares a shape* with a
   canonical provider, so a Google-family id (also in `DEFERRED_SET`, but
   declaring `google-generative-ai`) reports `no_preset` and would verify
   the wrong branch. If a real deferred-family provider is configured on
   this machine, use it. Otherwise declare one locally, which needs no
   cloud credentials at all, because the deferral is decided before any
   credential is resolved:

   ```json5
   {
     models: {
       mode: "merge",
       providers: {
         "anthropic-vertex": {
           baseUrl: "http://127.0.0.1:1/deferred-probe",
           apiKey: "not-a-real-key",
           api: "anthropic-messages",
           models: [{ id: "deferred-probe", name: "Deferred family probe" }],
         },
       },
     },
   }
   ```

   ```sh
   openclaw gateway restart
   openclaw agent --agent <agent-id> --model anthropic-vertex/deferred-probe \
     --message "ping"
   openclaw logs --limit 200 | grep hypaware-openclaw-steering
   hyp query sql "
     select count(*) from ai_gateway_messages
     where conversation_source = 'openclaw' and provider = 'anthropic-vertex'
       and message_created_at >= '$SINCE_SQL'"
   ```

   Pass condition: the log carries one `uncaptured provider turn` record
   naming `provider: 'anthropic-vertex'` and `cause: 'deferred'`, and the
   query returns `0`. The turn itself failing is expected and is part of
   the pass: a deferred candidate must be left on its original provider,
   unmodified, and must not be rerouted into the gateway (R5). What is
   being checked is that the deferral is *reported* rather than
   indistinguishable from a gap, which is what every coverage number
   downstream rests on (R13). The ledger is rate limited per
   provider+cause per OpenClaw gateway process, so if you repeat this step
   inside five minutes, expect no second record: restart the gateway or
   wait it out rather than concluding the warning stopped working.

6. Confirm the backfill route agrees with live capture instead of
   duplicating it. First check that the live rows settled onto the session
   file's native identity, since that convergence is what the pass
   condition below measures:

   ```sh
   hyp query sql "
     select count(*) total,
            sum(case when json_extract(attributes, '\$.openclaw.match_key') is null
                     then 1 else 0 end) settled
     from ai_gateway_messages
     where conversation_source = 'openclaw'
       and message_created_at >= '$SINCE_SQL'"
   ```

   `settled` should equal `total`: a settled row has spent and dropped its
   match key. Record the ratio in the release notes even when it is 1.0,
   because it is the live measurement of whether OpenClaw appends its
   session JSONL in time for the flush, the open question
   [LLP 0159](../llp/0159-openclaw-route-agreement-by-settlement.decision.md)
   says would trigger revisiting the route-agreement design. Then import
   the same window from disk:

   ```sh
   hyp backfill openclaw --since "$SINCE" --json
   ```

   Pass condition: `items_seen >= 1` with `rows_written + rows_skipped >= 1`
   for `openclaw`. **`rows_written: 0` with `rows_skipped >= 1` is a pass,
   not a failure.** Step 3 already captured these turns live, settlement
   gave those rows the session file's own message ids, so the
   materializer's `part_id` dedupe suppresses every duplicate. Zero writes
   is the expected result and is exactly what proves the two routes agree
   (R11). Re-running is likewise safe: identity comes from the session
   file, so a second import never duplicates.

7. Disable the steering plugin and confirm OpenClaw goes back to its own
   providers, so capture is provably opt-in and reversible:

   ```sh
   openclaw plugins disable hypaware-openclaw-steering
   openclaw gateway restart
   openclaw agent --agent <agent-id> --model anthropic/<a-claude-model> \
     --message "In one sentence, what is a hash collision?"
   hyp query sql "
     select count(*) from ai_gateway_messages
     where conversation_source = 'openclaw'
       and message_created_at >= '$SINCE_SQL'"
   ```

   Pass condition: the count is unchanged from step 4's total. The turn
   answered normally, and nothing about it reached the gateway.

   Then, if this is your working machine, re-enable so you do not silently
   leave OpenClaw capture off (and remove the step 5 probe provider if you
   added one):

   ```sh
   openclaw plugins enable hypaware-openclaw-steering
   openclaw gateway restart
   ```

### If it fails

- Step 1 finds both provider ids but a zero count for
  `before_model_resolve`: the hook was registered and silently dropped, so
  look for a `pluginDiagnostics` warning in `openclaw logs` naming this
  plugin. The usual cause is an `allowConversationAccess` entry that is
  missing or filed under a different key: it belongs to the plugin's
  manifest `id`, `hypaware-openclaw-steering`, not the npm package name
  (`@hypaware/openclaw-steering-plugin`) and not under `.config`. If the
  entry is present and correct, check `openclaw --version` against the
  floor in **Requires** before suspecting the plugin.
- Step 4 finds no rows at all: check the printed gateway URL against
  `HYP_GATEWAY_ENDPOINT` first (a daemon that fell back to an ephemeral
  port leaves the plugin talking to whatever holds the default), then
  `hyp status` for a stopped daemon, then step 1's inspect output for a
  plugin that failed to load after the last `openclaw gateway restart`.
- Step 4 finds `anthropic` rows but no `openai` row: either no OpenAI
  credential is configured in OpenClaw (the candidate warns
  `no_credential` and passes through, visible in `openclaw logs` exactly
  as in step 5), or the `openai` upstream preset is not registered. Check
  the log before touching code.
- Step 4 finds a row whose `provider` is `hypaware-anthropic` or
  `hypaware-openai`: the shadow id leaked into the projection. That is an
  R6 violation and its own bug; do not work around it by rewriting the
  value at query time.
- Step 6 reports `rows_written >= 1`: the live rows did not settle, so
  backfill imported the same turns a second time under native identity.
  Re-run the settled/total query. A settled count below total means the
  session JSONL was not on disk when the flush ran, which is the
  real-time-append question above, not a backfill bug. Record the observed
  ratio and file it against LLP 0159 rather than editing either route.
- Step 5 logs `cause: 'no_preset'` instead of `'deferred'`: the provider
  you used does not share an API shape with a canonical one, so it never
  reached the deferred-family check. Pick an `anthropic-messages` or
  `openai-completions` shaped provider and repeat.

---

## Other candidates

`CLAUDE.md` lists further acceptance candidates that have no written
procedure yet: `installed_daemon_idle_soak`, `otel_self_loop_guard`,
`codex_subscription_capture`, `configured_sink_roundtrip`. Add them here as
they are written, in the same shape: what it proves, what it does not, the
exact commands, and the pass condition.
