import { runGascityPreset } from './gascity.js'

/**
 * @typedef {{
 *   name: string,
 *   description: string,
 *   run: (argv: string[], hooks?: object) => Promise<number>,
 * }} InitPreset
 */

/** @type {Record<string, InitPreset>} */
const PRESETS = {
  gascity: {
    name: 'gascity',
    description: 'Register .gc/events.jsonl and session-reconciler segments; install ctvs-gascity skill',
    run: runGascityPreset,
  },
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isInitPreset(name) {
  return Object.prototype.hasOwnProperty.call(PRESETS, name)
}

/**
 * @returns {InitPreset[]}
 */
export function listInitPresets() {
  return Object.values(PRESETS)
}

/**
 * @param {string} name
 * @returns {InitPreset | undefined}
 */
export function getInitPreset(name) {
  return PRESETS[name]
}
