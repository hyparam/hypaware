import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { resolveRuntimeSecrets, validateCollectivusConfig } from '../src/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const composePath = path.join(repoRoot, 'docker-compose.yml')
const envExamplePath = path.join(repoRoot, '.env.example')

/**
 * Five env vars referenced by `${...}` substitutions in docker-compose.yml.
 * Both files must list the same set so `docker compose up` cannot start with
 * a partially populated `.env`.
 */
const REQUIRED_ENV_VARS = [
  'COLLECTIVUS_ADMIN_TOKEN',
  'COLLECTIVUS_IDENTITY_SECRET',
  'COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN',
  'COLLECTIVUS_RENDEZVOUS_URL',
  'COLLECTIVUS_PUBLIC_URL',
]

/**
 * Parse docker-compose.yml once and reuse across tests. The YAML structure
 * is asserted in the first test in this file; everything after assumes the
 * top-level shape matches.
 *
 * @returns {{ services: Record<string, Record<string, unknown>>, volumes: Record<string, unknown> }}
 */
function readCompose() {
  const raw = fs.readFileSync(composePath, 'utf8')
  const doc = yaml.load(raw)
  if (!doc || typeof doc !== 'object') throw new Error('compose root is not an object')
  // @ts-expect-error narrowed by the tests below
  return doc
}

describe('docker-compose.yml', function() {
  it('parses as valid YAML with services + volumes top-level keys', function() {
    const doc = readCompose()
    expect(doc.services).toBeDefined()
    expect(typeof doc.services).toBe('object')
    expect(doc.volumes).toBeDefined()
    expect(typeof doc.volumes).toBe('object')
  })

  it('defines exactly the central + rendezvous services', function() {
    const doc = readCompose()
    expect(Object.keys(doc.services).sort()).toEqual(['central', 'rendezvous'])
  })

  it('declares the two named volumes referenced by services', function() {
    const doc = readCompose()
    expect(Object.keys(doc.volumes).sort()).toEqual([
      'collectivus-rendezvous-data',
      'collectivus-server-data',
    ])
  })

  describe('central service', function() {
    it('uses the published GHCR image with --config-env', function() {
      const doc = readCompose()
      const central = doc.services.central
      expect(central.image).toBe('ghcr.io/hyparam/collectivus:latest')
      expect(central.command).toEqual(['--config-env', 'COLLECTIVUS_SERVER_CONFIG'])
    })

    it('exposes the control-plane port 8788', function() {
      const doc = readCompose()
      const central = doc.services.central
      expect(central.ports).toContain('8788:8788')
    })

    it('mounts the server data volume at /data (matches Dockerfile VOLUME)', function() {
      const doc = readCompose()
      const central = doc.services.central
      expect(central.volumes).toContain('collectivus-server-data:/data')
    })

    it('depends on the rendezvous service so registrations can succeed at boot', function() {
      const doc = readCompose()
      const central = doc.services.central
      // compose normalizes both `depends_on: [name]` and `depends_on: { name: ... }`
      // forms. Accept either, just check rendezvous is mentioned.
      const deps = central.depends_on
      if (Array.isArray(deps)) {
        expect(deps).toContain('rendezvous')
      } else {
        expect(deps).toHaveProperty('rendezvous')
      }
    })

    it('passes every required secret into the container environment', function() {
      const doc = readCompose()
      const env = doc.services.central.environment
      // Compose accepts environment as either a list of "KEY=VALUE" strings
      // or a map. The reference uses the map form for readability.
      expect(typeof env).toBe('object')
      expect(Array.isArray(env)).toBe(false)
      for (const name of REQUIRED_ENV_VARS) {
        expect(env, `central is missing env ${name}`).toHaveProperty(name)
      }
      expect(env).toHaveProperty('COLLECTIVUS_SERVER_CONFIG')
    })

    it('embeds an inline server config that validates against the runtime schema', function() {
      const doc = readCompose()
      const env = /** @type {Record<string, string>} */ (doc.services.central.environment)
      const raw = env.COLLECTIVUS_SERVER_CONFIG
      expect(typeof raw).toBe('string')
      // Substitute the operator-provided values with synthetic ones that
      // satisfy the validator. We use 32-char strings for token-shaped
      // fields and an https URL for the public_url field, mirroring what a
      // real .env would supply.
      const stuffed = raw
        .replace(/\$\{COLLECTIVUS_PUBLIC_URL\}/g, 'https://central.example.com')
      const parsed = JSON.parse(stuffed)
      // Sanity: top-level shape is what the spec calls for.
      expect(parsed.role).toBe('server')
      expect(parsed.server.control_plane_listen).toBe('0.0.0.0:8788')
      expect(parsed.server.data_dir).toBe('/data')
      expect(parsed.server.sink_dir).toBe('/data/ingested')
      expect(parsed.server.identity_issuer.bootstrap_store_path).toBe('/data/bootstrap.json')
      // Admin and rendezvous tokens are sourced via `*_env` so the JSON
      // never carries plaintext secrets. The CLI argv test below relies on
      // this contract for the rendezvous service too.
      expect(parsed.server.admin.token_env).toBe('COLLECTIVUS_ADMIN_TOKEN')
      expect(parsed.server.identity_issuer.secret_env).toBe('COLLECTIVUS_IDENTITY_SECRET')
      expect(parsed.server.rendezvous.url_env).toBe('COLLECTIVUS_RENDEZVOUS_URL')
      expect(parsed.server.rendezvous.registration_token_env)
        .toBe('COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN')
      // Now exercise the real validator with env-resolved fakes. If the
      // schema rejects this shape the central container would crash at
      // boot — surface that here. Schema validation is env-agnostic; it
      // checks the shape (exactly-one-of token/token_env etc), not the
      // resolved values.
      expect(() => validateCollectivusConfig(parsed)).not.toThrow()
      // resolveRuntimeSecrets pulls identity_issuer.secret_env at boot.
      // The admin token and rendezvous fields are resolved per-request,
      // not at boot, so they are not exercised here.
      const env32 = {
        COLLECTIVUS_IDENTITY_SECRET: 'b'.repeat(32),
      }
      expect(() => resolveRuntimeSecrets(parsed, env32)).not.toThrow()
    })
  })

  describe('rendezvous service', function() {
    it('uses the same image as central with the rendezvous subcommand', function() {
      const doc = readCompose()
      const r = doc.services.rendezvous
      expect(r.image).toBe('ghcr.io/hyparam/collectivus:latest')
      expect(r.command).toEqual([
        'rendezvous',
        '--listen',
        '0.0.0.0:8789',
        '--data-dir',
        '/data/rendezvous',
      ])
    })

    it('does not leak the registration token via process argv', function() {
      const doc = readCompose()
      const r = doc.services.rendezvous
      // The token must arrive via env, not the command array. If a future
      // edit adds `--registration-token` to argv, this test fires before
      // the change merges.
      const cmd = /** @type {string[]} */ (r.command)
      const tokenFlagIdx = cmd.indexOf('--registration-token')
      expect(tokenFlagIdx).toBe(-1)
      const env = r.environment
      expect(env).toHaveProperty('COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN')
    })

    it('exposes the rendezvous port 8789', function() {
      const doc = readCompose()
      const r = doc.services.rendezvous
      expect(r.ports).toContain('8789:8789')
    })

    it('mounts a dedicated volume for rendezvous state', function() {
      const doc = readCompose()
      const r = doc.services.rendezvous
      expect(r.volumes).toContain('collectivus-rendezvous-data:/data/rendezvous')
    })
  })
})

describe('.env.example', function() {
  it('declares every variable referenced by compose `${...}` substitutions', function() {
    const text = fs.readFileSync(envExamplePath, 'utf8')
    // Allow comments and blank lines; each var must appear as `NAME=` at
    // line start (empty value, so a fresh copy fails fast rather than
    // booting with placeholder data).
    for (const name of REQUIRED_ENV_VARS) {
      const pattern = new RegExp(`^${name}=`, 'm')
      expect(text, `.env.example missing ${name}`).toMatch(pattern)
    }
  })

  it('ships empty values so an unfilled copy fails the validator', function() {
    const text = fs.readFileSync(envExamplePath, 'utf8')
    for (const name of REQUIRED_ENV_VARS) {
      const line = text.match(new RegExp(`^${name}=(.*)$`, 'm'))
      expect(line, `.env.example missing ${name} line`).not.toBeNull()
      const value = line ? line[1].trim() : 'unset'
      expect(value, `.env.example ${name} must ship empty`).toBe('')
    }
  })
})

describe('docker-compose <-> .env.example cross-check', function() {
  it('every ${VAR} in compose is declared in .env.example', function() {
    const composeText = fs.readFileSync(composePath, 'utf8')
    const envText = fs.readFileSync(envExamplePath, 'utf8')
    const substitutions = new Set()
    const re = /\$\{([A-Z_][A-Z0-9_]*)\}/g
    /** @type {RegExpExecArray | null} */
    let m
    while ((m = re.exec(composeText)) !== null) {
      substitutions.add(m[1])
    }
    expect(substitutions.size).toBeGreaterThan(0)
    for (const name of substitutions) {
      const pattern = new RegExp(`^${name}=`, 'm')
      expect(envText, `.env.example missing compose substitution ${name}`).toMatch(pattern)
    }
  })
})
