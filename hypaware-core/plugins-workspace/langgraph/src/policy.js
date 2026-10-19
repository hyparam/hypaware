import fs from 'node:fs'
import { createClientRecordingPolicyReader } from '../../../../src/core/config/client_recording.js'
import { SessionIgnoreSet } from '../../../../src/core/control/session_ignore_store.js'
import { createUsagePolicyResolver, localOnlyListPath } from '../../../../src/core/usage-policy/index.js'

// @ref LLP 0517#privacy: policy is checked before journaling and again on delivery
export function createPolicy(env, stateDir, ignored = new SessionIgnoreSet(stateDir)) {
  const recording = createClientRecordingPolicyReader({ env, plugin: '@hypaware/langgraph' })
  let signature = ''
  return {
    ignored,
    allows(sessionId, cwd) {
      try {
        if (!recording().recording) return false
        let next = 'missing'
        try {
          const s = fs.statSync(ignored.directory)
          next = `${s.ino}:${s.mtimeMs}:${s.ctimeMs}`
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (signature !== next || ignored.loadError) {
          ignored.refresh()
          signature = next
        }
        if (ignored.loadError || ignored.has(sessionId)) return false
        // One short-lived resolver bounds its cwd cache and sees policy edits now.
        return createUsagePolicyResolver({ localOnlyListPath: localOnlyListPath(stateDir), ttlMs: 0 }).resolve(cwd).class !== 'ignore'
      } catch { return false }
    },
  }
}
