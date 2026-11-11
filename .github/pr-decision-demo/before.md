An organization service-account token (it starts with `hsa_`) now enrolls a collector with the shipped `hyp join`, and buys query access with `hyp remote login --token-file`. The design is LLP 0547, promoted from Draft to Accepted in this PR. The server half is hypaware-server LLP 0620.

What changes

- `hyp join <url> -` (or `--token-file`) with an `hsa_` secret keeps a destination-bound record, `service-token`, beside the central sink's `identity.json`. The record is mode 0600 in a 0700 directory. Any other join and `hyp leave` retire it. A join that cannot write or retire the record stops before the seed changes.
- The central sink recovers unattended. A 401 at its own destination re-bootstraps once from the kept record and keeps the same gateway id. A 403 `service_token_revoked` or `service_account_disabled` stops the sink and persists the stop, and nothing more is sent. `hyp status` reports `stopped: service token revoked` (or `service account disabled`) with the remedy.
- `hyp remote login <target> --token-file` with an `hsa_` secret stores a `kind: 'service'` record:
  - It exchanges once before storing, so a revoked or mistyped secret fails at login with the server's code.
  - Later it re-exchanges under the existing credentials lock.
  - A refusal names the code and the re-login command.
- `hyp remote mint` and the `HYP_REMOTE_TOKEN_<NAME>` override both refuse a service secret locally.
- Logs carry no secret, JWT or fingerprint.

Decisions

- No new command, flag, config key or schema field. Setup uses the shipped `hyp join`, `hyp daemon install` and `hyp daemon run`.
- The collector runs in its own `HYP_HOME`, so it never touches a person's enrollment or query credentials. Recovery never falls back to personal credentials.
- The docs name the built-in `hypaware` remote for queries, so no `hyp remote add` is needed.
- The hermetic smoke `central_service_token_collector` covers the collector lane and the remote lane in one flow, with a `smoke_step` per step:
  - Collector lane: join, upload, re-bootstrap with the same gateway id, revoke (no further requests), status, and leave removing the record.
  - Remote lane: login, query, then revoke, where the error names the code.
- `writeOtelFixturePlugin` in `central_forward_outbox.js` is now exported so the new smoke can reuse it.

Docs

- `docs/integrations/ci-and-headless.md` gains "Collect as an organization service account": exact headless setup, secret placement on stdin or a private token file, query login, and what revocation looks like.

Tests

- New: `test/core/join-service-token.test.js`, `test/core/remote-service-token.test.js`, `test/core/remote-service-credentials.test.js`, `test/core/status-service-token-stopped.test.js` and `test/plugins/central-identity-service-token.test.js`.
- `npm test`: 8929 pass, 0 fail, 3 skipped.
- `npm run typecheck` is clean, and `node scripts/llp-numbers.js check` is clean.
- `npm run smoke -- central_service_token_collector` passes.
- A fixture smoke does not replace real capture acceptance against a live server.

CPU and memory

- The kept record is read at sink activation and on a 401; there is no polling.
- Recovery is one re-bootstrap per 401, and a stop ends all requests.
- A fresh cached query JWT takes no lock and makes no request.
- No new buffers or loops.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
