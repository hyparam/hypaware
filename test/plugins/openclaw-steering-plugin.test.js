// @ts-check

// The `@hypaware/openclaw-steering-plugin` package keeps its unit tests beside
// its own source, because it is an npm package OpenClaw installs rather than a
// relative-import HypAware kernel plugin (LLP 0161#package-layout). But the
// repo's `npm test` is deliberately scoped to root `test/**/*.test.js`
// (CLAUDE.md), so nothing under `openclaw-steering-plugin/test/` was reaching
// the gate: the four-branch `resolveSteering` precedence (LLP 0162's single
// highest-complexity task, where a wrong branch is a wrong answer to "is this
// provider captured") and the credential-borrow contract (R3: never persisted,
// re-resolved every call) were unit-tested and then never run in CI.
//
// Importing the package's test modules registers their `test()` calls in this
// runner, so they run under `npm test` without either moving them out of the
// package or widening the runner's root.
//
// @ref LLP 0157#requirements [tests]: R2, R3, R4, R5 - the steering plugin's
// own unit tests, gated by the repo's test command.

import '../../openclaw-steering-plugin/test/gateway_endpoint.test.js'
import '../../openclaw-steering-plugin/test/runtime_auth.test.js'
import '../../openclaw-steering-plugin/test/steering.test.js'
import '../../openclaw-steering-plugin/test/warning_ledger.test.js'
import '../../openclaw-steering-plugin/test/wire_parity.test.js'
