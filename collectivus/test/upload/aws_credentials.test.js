import { describe, expect, it, vi } from 'vitest'
import {
  awsCredentialProviderFromEnv,
  hasAwsCredentialSource,
} from '../../src/upload/aws_credentials.js'

describe('AWS credential provider', () => {
  it('detects static env credentials and ECS container credential env', () => {
    expect(hasAwsCredentialSource({
      AWS_ACCESS_KEY_ID: 'id',
      AWS_SECRET_ACCESS_KEY: 'secret',
    })).toBe(true)
    expect(hasAwsCredentialSource({
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task',
    })).toBe(true)
    expect(hasAwsCredentialSource({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://127.0.0.1/credentials',
    })).toBe(true)
    expect(hasAwsCredentialSource({})).toBe(false)
  })

  it('prefers static env credentials', () => {
    const provider = awsCredentialProviderFromEnv({
      AWS_ACCESS_KEY_ID: 'AKIASTATIC',
      AWS_SECRET_ACCESS_KEY: 'static-secret',
      AWS_SESSION_TOKEN: 'static-session',
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/ignored',
    }, {
      fetch: vi.fn(),
    })

    expect(provider()).toEqual({
      accessKeyId: 'AKIASTATIC',
      secretAccessKey: 'static-secret',
      sessionToken: 'static-session',
    })
  })

  it('fetches and caches ECS task-role credentials from the relative URI', async () => {
    const fetchSpy = vi.fn()
    /**
     * @param {RequestInfo | URL} input
     * @param {RequestInit} [init]
     * @returns {Promise<Response>}
     */
    function fetchFn(input, init) {
      fetchSpy(input, init)
      return Promise.resolve(/** @type {Response} */ (/** @type {unknown} */ ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({
          AccessKeyId: 'AKIATASK',
          SecretAccessKey: 'task-secret',
          Token: 'task-token',
          Expiration: '2099-01-01T00:00:00Z',
        }),
      })))
    }
    const provider = awsCredentialProviderFromEnv({
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task',
    }, { fetch: fetchFn })

    await expect(provider()).resolves.toEqual({
      accessKeyId: 'AKIATASK',
      secretAccessKey: 'task-secret',
      sessionToken: 'task-token',
    })
    await expect(provider()).resolves.toEqual({
      accessKeyId: 'AKIATASK',
      secretAccessKey: 'task-secret',
      sessionToken: 'task-token',
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('http://169.254.170.2/v2/credentials/task', undefined)
  })

  it('passes the container authorization token for full URI credentials', async () => {
    const fetchSpy = vi.fn()
    /**
     * @param {RequestInfo | URL} input
     * @param {RequestInit} [init]
     * @returns {Promise<Response>}
     */
    function fetchFn(input, init) {
      fetchSpy(input, init)
      return Promise.resolve(/** @type {Response} */ (/** @type {unknown} */ ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({
          AccessKeyId: 'AKIAFULL',
          SecretAccessKey: 'full-secret',
        }),
      })))
    }
    const provider = awsCredentialProviderFromEnv({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://127.0.0.1:4567/credentials',
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'Bearer token',
    }, { fetch: fetchFn })

    await expect(provider()).resolves.toEqual({
      accessKeyId: 'AKIAFULL',
      secretAccessKey: 'full-secret',
      sessionToken: undefined,
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4567/credentials',
      { headers: { Authorization: 'Bearer token' } }
    )
  })
})
