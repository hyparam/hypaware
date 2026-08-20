# Evidence ledger

All sources are local repository primary sources, accessed 2026-08-18. Source
dates are the checkout state on that date; individual files do not carry a
publication date. Exact command-level citations are also recorded in WP1-WP4.

| Source | Claims supported | Strength and limits |
|---|---|---|
| `src/core/cli/core_commands.js` | Complete core registration names, usage strings, aliases, group help, proposed starting inventory | Authoritative registration surface; help can lag runner details |
| `src/core/cli/dispatch.js` | Boot profiles, config-active plugin availability, pre-activation help, inactive-plugin repairs, longest-prefix dispatch, one-shot source cleanup | Authoritative dispatch behavior |
| `src/core/registry/commands.js` and `verbs.js` | Alias indexing, hidden filtering, group metadata, typed verb projection | Authoritative registry mechanics |
| `src/core/commands/init.js` and `src/core/cli/walkthrough.js` | Setup modes, config writes, daemon/client/assets/backfill finale | Authoritative implementation; wizard has many UI branches summarized in WP1 |
| `src/core/commands/status.js` and `src/core/daemon/status.js` | Overall status inputs, stable JSON, client state projection opportunity | Authoritative collector and renderer |
| `src/core/commands/ask.js` | Question picker/list/launch behavior and client eligibility | Authoritative runner |
| `src/core/commands/clients.js` | Attach/detach, ignore/unignore, skills, proxy trust, interactive enablement | Authoritative but large; cross-checked against LLPs and focused tests |
| `src/core/commands/backfill.js` and `src/core/registry/backfills.js` | Provider selection, scan/materialize/write/flush, plan/list behavior | Authoritative runner/registry |
| `src/core/commands/policy.js` and `src/core/usage-policy/` | Directory, client, and folder policy semantics and store failures | Authoritative policy edge and storage |
| `src/core/commands/purge.js` | Destructive local-only scope, confirmation, identity/watermark preservation | Authoritative runner, cross-checked with LLP 0104/tests |
| `src/core/commands/central.js` | Join seed and daemon behavior; leave teardown and partial repair | Authoritative client-side enrollment behavior; server internals out of scope |
| `src/core/commands/query.js` and `src/core/query/` | Overview/schema/cache status/refresh/maintenance and SQL behavior | Authoritative local query/cache implementation |
| `src/core/cli/verb_command.js`, `verb_codec.js`, and `src/core/query/verb.js` | Typed controls, local/remote routing, render budgets, privacy context | Authoritative shared verb adapter |
| `src/core/commands/sync.js` and `src/core/sinks/driver.js` | Sync plan, confirmation, first-sync release, forced sink tick | Authoritative consent-sensitive movement path |
| `src/core/cli/report_commands.js` and `src/core/reports/` | Local render and server publish/list/get/delete contracts | Authoritative client implementation; server enforcement inferred only from response contract |
| `src/core/cli/remote_commands.js` and `src/core/remote/` | Remote target config, static/OIDC login, optional enrollment, credential lifecycle | Authoritative client contract; IdP/server implementation out of scope |
| `src/core/commands/daemon.js` and `src/core/daemon/` | Service lifecycle, dry-run rendering, foreground runtime, uninstall detach | Authoritative platform abstraction; not exercised against live service manager |
| `src/core/commands/plugin.js`, `src/core/plugin_install/`, `src/core/plugin_doctor/` | Plugin trust gate, lifecycle, update overload, scaffold/doctor | Authoritative implementation; network fetch paths not executed |
| `src/core/commands/config.js` and `src/core/config/` | Active config path precedence and cross-validation | Authoritative implementation |
| `src/core/commands/mcp.js` and `src/core/mcp/` | Local stdio server, remote proxy, tool/auth surface | Authoritative implementation |
| `src/core/commands/sink.js` and `hypaware-core/plugins-workspace/format-iceberg/src/maintenance.js` | Export snapshot expiration and explicit compaction | Authoritative implementation |
| `src/core/commands/misc.js` and `hypaware-core/smoke/` | Version and hermetic smoke subprocess behavior | Authoritative implementation plus repository smoke guidance |
| Bundled `hypaware.plugin.json` files | Complete manifest-declared plugin command inventory and help visibility | Authoritative declarative discovery; runtime registrations were reconciled separately |
| `hypaware-core/plugins-workspace/ai-gateway/src/session_command.js` | Exact-session resolution, in-memory control, exit 0/1/2/3 | Authoritative runner |
| `hypaware-core/plugins-workspace/context-graph/src/command.js` and `verb.js` | Projection, compaction, traversal, remote verb/tool behavior | Authoritative plugin implementation |
| `hypaware-core/plugins-workspace/vector-search/src/commands.js` | Vector search/status flags, refresh effects, lack of typed remote transport | Authoritative plugin implementation |
| `hypaware-core/plugins-workspace/context-graph-enrich/src/commands.js`, `propose.js`, `curate.js`, `batch.js` | T1/T2/backfill/status behavior, Batch API, partial dry-run caveat | Authoritative implementation |
| `hypaware-core/plugins-workspace/gascity/src/commands.js` | Process-memory city changes and lack of persistence | Authoritative runner; dispatch cleanup establishes transience |
| `hypaware-core/plugins-workspace/claude-account/src/` | Login/logout/status and secret-bearing credential helper | Authoritative plugin implementation |
| `hypaware-core/plugins-workspace/claude-desktop/src/` | Profile/helper/install/status/verify, macOS/sudo/idempotency | Authoritative plugin implementation |
| `hypaware-core/plugins-workspace/claude/src/index.js` | Hidden generated Claude hook commands | Authoritative runtime registration; intentionally absent from manifest help |
| Relevant `test/core/**/*.test.js` and `test/plugins/**/*.test.js` | Edge cases for joins/leaves, attach/detach, status, policy, purge, plugins, graph/vector, Desktop | Strong deterministic cross-checks; test coverage is uneven by command |

## Governing LLP sources

The most consequential settled constraints were cross-checked against:

- `llp/0003-core-vs-plugin-surface.spec.md`
- `llp/0009-cli-registry.spec.md`
- `llp/0022-iceberg-export-partitioning.spec.md`
- `llp/0023-context-graph-projection.decision.md`
- `llp/0024-vector-search-plugin.decision.md`
- `llp/0025-remote-config-join-flow.spec.md`
- `llp/0033-remote-query-attach.spec.md`
- `llp/0034-mcp-host-intrinsic.decision.md`
- `llp/0045-client-attach.design.md`
- `llp/0049-hypignore-usage-policy.spec.md`
- `llp/0050-ignore-enforced-in-adapters.decision.md`
- `llp/0056-refuse-over-spill-or-truncate.decision.md`
- `llp/0058-oidc-login-client.decision.md`
- `llp/0062-builtin-default-remote.decision.md`
- `llp/0063-login-auto-provision-forward-sink.decision.md`
- `llp/0064-context-graph-query.decision.md`
- `llp/0067-session-opt-out.design.md`
- `llp/0100-enrollment-privacy-review.spec.md`
- `llp/0101-first-sync-review-window.decision.md`
- `llp/0103-machine-local-policy-classes.decision.md`
- `llp/0104-hyp-purge.decision.md`
- `llp/0105-query-seam-local-only-visibility.decision.md`
- `llp/0106-session-start-classification-hook.decision.md`
- `llp/0107-skills-ride-attach.decision.md`
- `llp/0110-hyp-policy-verb.issue.md` and `llp/0111-hyp-policy-verb.design.md`
- `llp/0116-desktop-credential-client-presented.decision.md`
- `llp/0117-claude-account-credential-plugin.decision.md`
- `llp/0131-configure-phase.decision.md`
- `llp/0133-desktop-solo-sudo-plist.decision.md`
- `llp/0135-install-experience-overhaul.design.md`
- `llp/0138-client-assets-one-install.decision.md`
- `llp/0139-desktop-picker-consent.decision.md`
- `llp/0153-inactive-not-unknown-dispatch-miss.decision.md`
- `llp/0154-dispatch-miss-repair-by-cause.decision.md`
- `llp/0155-report-cli.decision.md`
- `llp/0164-status-names-recent-clients-from-gateway-entrypoints.decision.md`
- `llp/0174-attach-prompts-to-enable.design.md`
- `llp/0188-enrolled-default-sync-with-client-optout.decision.md`
- `llp/0196-skills-state-constraints-not-procedures.rfc.md`
- `llp/0200-folder-ask-is-a-preference.decision.md`
- `llp/0206-uninstall-detaches-its-clients.decision.md`
- `llp/0212-session-opt-out-is-a-cli-verb.decision.md`
- `llp/0213-graph-plugin-always-active.decision.md`
- `llp/0214-verbs-and-plugin-groups-carry-long-help.decision.md`
- `llp/0238-long-lived-ca-full-provider-constraints.decision.md`
- `llp/0244-attach-migrates-to-proxy-mode.decision.md`

These LLPs establish rationale and invariants, while implementation files above
remain the primary evidence for what the current command actually does.
