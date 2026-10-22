// @ts-check

import { matchesSemverRange } from '../semver.js'

export const APPLICATION_NODE_RANGE = '^22.23.4 || ^24.22.1 || >=26.12.1'

/** @param {string} version */
export function supportsApplicationNode(version) {
  return !version.includes('-') && matchesSemverRange(version, APPLICATION_NODE_RANGE)
}
