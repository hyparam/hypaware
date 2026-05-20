import { ConfigError } from '../config.js'

/**
 * Resolve a secret string from either a direct config field or an environment
 * variable name, applying the documented minimum-length floor.
 *
 * Throws `ConfigError` with the supplied `pointer` (or the field name in
 * `envVarPointer`) when neither source yields a usable value. Error messages
 * are deliberately redacted: they reference the env-var name but never the
 * resolved value.
 *
 * Callers are expected to have already passed schema validation, so the
 * `exactly one of direct/envVar` contract is asserted here rather than
 * silently preferring one over the other.
 *
 * @param {{
 *   direct: string | undefined,
 *   envVar: string | undefined,
 *   env: NodeJS.ProcessEnv,
 *   minBytes: number,
 *   pointer: string,
 *   envVarPointer?: string,
 * }} args
 * @returns {string}
 */
export function resolveSecret(args) {
  const { direct, envVar, env, minBytes, pointer } = args
  const envPointer = args.envVarPointer ?? pointer
  const hasDirect = direct !== undefined
  const hasEnvVar = envVar !== undefined
  if (hasDirect === hasEnvVar) {
    throw new ConfigError(
      'must set exactly one of direct value or env-var reference',
      { pointer }
    )
  }
  let resolved
  let source
  let sourcePointer
  if (direct !== undefined) {
    resolved = direct
    source = 'value'
    sourcePointer = pointer
  } else {
    const envKey = envVar
    const fromEnv = env[envKey]
    if (fromEnv === undefined || fromEnv === '') {
      throw new ConfigError(
        `environment variable ${envKey} is not set`,
        { pointer: envPointer }
      )
    }
    resolved = fromEnv
    source = `environment variable ${envKey}`
    sourcePointer = envPointer
  }
  if (typeof resolved !== 'string' || resolved.length < minBytes) {
    throw new ConfigError(
      `${source} must be at least ${minBytes} bytes`,
      { pointer: sourcePointer }
    )
  }
  return resolved
}
