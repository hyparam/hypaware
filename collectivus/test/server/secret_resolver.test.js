import { describe, expect, it } from 'vitest'
import { ConfigError } from '../../src/config.js'
import { resolveSecret } from '../../src/server/secret_resolver.js'

describe('resolveSecret', () => {
  const SECRET = 'x'.repeat(40)

  it('returns the direct value when only `direct` is set', () => {
    expect(resolveSecret({
      direct: SECRET,
      envVar: undefined,
      env: {},
      minBytes: 32,
      pointer: '/server/admin',
    })).toBe(SECRET)
  })

  it('returns the env value when only `envVar` is set and the env has it', () => {
    expect(resolveSecret({
      direct: undefined,
      envVar: 'MY_TOKEN',
      env: { MY_TOKEN: SECRET },
      minBytes: 32,
      pointer: '/server/admin',
      envVarPointer: '/server/admin/token_env',
    })).toBe(SECRET)
  })

  it('throws ConfigError when both `direct` and `envVar` are set', () => {
    expect(() => resolveSecret({
      direct: SECRET,
      envVar: 'MY_TOKEN',
      env: { MY_TOKEN: SECRET },
      minBytes: 32,
      pointer: '/server/admin',
    })).toThrow(ConfigError)
  })

  it('throws ConfigError when neither `direct` nor `envVar` is set', () => {
    expect(() => resolveSecret({
      direct: undefined,
      envVar: undefined,
      env: {},
      minBytes: 32,
      pointer: '/server/admin',
    })).toThrow(/exactly one/)
  })

  it('throws ConfigError when the env var is missing, redacting the value', () => {
    /** @type {unknown} */
    let caught
    try {
      resolveSecret({
        direct: undefined,
        envVar: 'MY_TOKEN',
        env: {},
        minBytes: 32,
        pointer: '/server/admin',
        envVarPointer: '/server/admin/token_env',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    const msg = caught instanceof Error ? caught.message : String(caught)
    expect(msg).toMatch(/MY_TOKEN is not set/)
    expect(msg).toMatch(/\/server\/admin\/token_env/)
  })

  it('throws ConfigError when the env var is empty', () => {
    expect(() => resolveSecret({
      direct: undefined,
      envVar: 'MY_TOKEN',
      env: { MY_TOKEN: '' },
      minBytes: 32,
      pointer: '/server/admin',
    })).toThrow(/MY_TOKEN is not set/)
  })

  it('throws ConfigError when the resolved value is shorter than minBytes (direct)', () => {
    /** @type {unknown} */
    let caught
    try {
      resolveSecret({
        direct: 'short',
        envVar: undefined,
        env: {},
        minBytes: 32,
        pointer: '/server/admin/token',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    const msg = caught instanceof Error ? caught.message : String(caught)
    expect(msg).toMatch(/at least 32 bytes/)
    // Value content must NOT appear in the error message.
    expect(msg).not.toMatch(/short/)
  })

  it('throws ConfigError when the resolved env value is shorter than minBytes', () => {
    /** @type {unknown} */
    let caught
    try {
      resolveSecret({
        direct: undefined,
        envVar: 'MY_TOKEN',
        env: { MY_TOKEN: 'tiny' },
        minBytes: 32,
        pointer: '/server/admin',
        envVarPointer: '/server/admin/token_env',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    const msg = caught instanceof Error ? caught.message : String(caught)
    expect(msg).toMatch(/environment variable MY_TOKEN.*at least 32 bytes/)
    expect(msg).not.toMatch(/tiny/)
  })
})
