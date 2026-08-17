// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { V1_BUNDLED_PLUGIN_ALLOWLIST, V1_EXCLUDED_FROM_DEFAULT } from '../../src/core/runtime/bundled.js'

// The two sets are read by different code paths that must never disagree
// about a name: `discoverBundledPlugins` checks the allowlist before the
// exclude set, so a name in both lands in `loaded`, while
// `ridersInDefaultSet` (src/core/cli/walkthrough.js) drops anything in
// `V1_EXCLUDED_FROM_DEFAULT`. Coverage (the union spanning the bundled
// workspace) does no work here; only disjointness keeps those two reads in
// agreement (issue #761, follow-up to PR #757's round-2 review).
//
// `composedRiders` in hypaware-core/smoke/flows/walkthrough_picker_to_first_query.js
// rests on this: it reads only `loaded` and expects that set to agree with
// what `loadPickerCatalog` writes. Break disjointness and that smoke goes red
// on a plugin the install never receives, pointing at its golden rather than
// at the two-list edit that caused it. This test names the cause instead.
test('the default-activation allowlist and the excluded set are disjoint', () => {
  const overlap = [...V1_BUNDLED_PLUGIN_ALLOWLIST].filter((name) => V1_EXCLUDED_FROM_DEFAULT.has(name))
  assert.deepEqual(
    overlap,
    [],
    `plugin(s) ${overlap.join(', ')} appear in both V1_BUNDLED_PLUGIN_ALLOWLIST and `
    + 'V1_EXCLUDED_FROM_DEFAULT: discoverBundledPlugins checks the allowlist first, so '
    + 'these land in its `loaded` bucket while ridersInDefaultSet treats them as excluded. '
    + 'Remove the name from whichever set does not match its intended default-activation '
    + 'boundary.'
  )
})
