import assert from 'node:assert/strict'
import test from 'node:test'
import { SECRET_MASK as MASK, redactSecretText } from '../../src/core/secret_rules.js'

// Seeded so a failure names the same token on every run. Tokens are built at
// runtime rather than written out, so no literal in this file looks like a
// live credential to a secret scanner.
function generator(seed = 1) {
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  /** @param {ArrayLike<string>} alphabet */
  const pick = alphabet => alphabet[Math.floor(rand() * alphabet.length)]
  /** @param {number} length @param {string} alphabet */
  const string = (length, alphabet) => Array.from({ length }, () => pick(alphabet)).join('')
  /** @param {number} length */
  const bytes = length => Buffer.from(Array.from({ length }, () => Math.floor(rand() * 256)))
  return { rand, pick, string, bytes }
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const BASE64URL = ALNUM + '-_'
const HEX = '0123456789abcdef'
const WORDS = ('account user settings tenant export redaction worker thread handler server error exception factory ' +
  'proxy abstract singleton image data thumbnail encoded request response stream buffer cache partition snapshot ' +
  'manifest config loader plugin registry session message token gateway codex claude query result writer reader ' +
  'parquet iceberg schema column table index').split(' ')

/** @param {object} payload */
const base64url = payload => Buffer.from(JSON.stringify(payload)).toString('base64url')

test('Google API keys, Stripe live secret keys and JWTs are masked, with or without a Bearer prefix', () => {
  const { string } = generator(7)
  const google = 'AI' + 'za' + string(35, BASE64URL)
  const stripe = 'sk_' + 'live_' + string(24, ALNUM)
  const jwt = [base64url({ alg: 'HS256', typ: 'JWT' }), base64url({ sub: 'user-1', iat: 1700000000 }), string(43, BASE64URL)].join('.')
  const unsigned = [base64url({ alg: 'none' }), base64url({ sub: 'user-1' }), ''].join('.')
  assert.equal(redactSecretText(`key=${google}&q=1`), `key=${MASK}&q=1`)
  assert.equal(redactSecretText(`"apiKey": "${google}"`), `"apiKey": "${MASK}"`)
  assert.equal(redactSecretText(`stripe ${stripe} done`), `stripe ${MASK} done`)
  assert.equal(redactSecretText(`STRIPE_KEY="${stripe + string(75, ALNUM)}"`), `STRIPE_KEY="${MASK}"`)
  assert.equal(redactSecretText(`token ${jwt} expires`), `token ${MASK} expires`)
  assert.equal(redactSecretText(`unsigned ${unsigned} end`), `unsigned ${MASK} end`)
  assert.equal(redactSecretText(`Authorization: Bearer ${jwt}`), `Authorization: ${MASK}`)
  assert.equal(redactSecretText(`{"id_token":"${jwt}"}`), `{"id_token":"${MASK}"}`)
})

test('near misses of the new formats are left alone', () => {
  const kept = [
    'AIza is the prefix Google API keys start with',
    'AIza' + 'x'.repeat(34),
    'sk_' + 'live_short1',
    'sk_' + 'test_' + 'a'.repeat(30),
    'the header eyJhbGciOiJIUzI1NiJ9 alone is not a token',
    'eyJ.config.json and eyJhbGci.short.x',
    'a.b.c and v1.2.3 and example.com.au',
  ]
  for (const text of kept) assert.equal(redactSecretText(text), text, text)
})

test('every format supported before the shared rules is still masked', () => {
  const { string } = generator(11)
  const cases = [
    ['sk-' + 'proj-' + string(40, BASE64URL), MASK],
    ['sk-' + 'ant-' + string(40, BASE64URL), MASK],
    ['gh' + 'p_' + string(36, ALNUM), MASK],
    ['github_' + 'pat_' + string(40, ALNUM), MASK],
    ['AK' + 'IA' + string(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'), MASK],
    ['xo' + 'xb-' + string(24, ALNUM), MASK],
    ['Bearer ' + 'b'.repeat(32), MASK],
    ['postgres://alice:private@db.example/db', MASK],
    ['password = hunter22', `password = ${MASK}`],
    ['-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', MASK],
  ]
  for (const [secret, expected] of cases) assert.equal(redactSecretText(`[ ${secret} ]`), `[ ${expected} ]`, secret)
})

test('the entropy heuristic masks unknown random tokens of 32 to 128 characters', () => {
  const { string } = generator(3)
  for (const length of [32, 40, 64, 128]) {
    const token = 'Aa0' + string(length - 3, ALNUM)
    assert.equal(redactSecretText(`x-vendor-token: ${token}\n`), `x-vendor-token: ${MASK}\n`)
    assert.equal(redactSecretText(`{"secret":"${token}"}`), `{"secret":"${MASK}"}`)
  }
  // An escaped newline before the token is not part of it.
  const token = 'Aa0' + string(37, ALNUM)
  assert.equal(redactSecretText(`line\\n${token}`), `line\\n${MASK}`)
  // Armor text that is not a whole PEM block does not shield what follows.
  const code = `if (pem.startsWith('-----BEGIN ')) parse(pem)\nconst TOKEN = '${token}'\nconst END = '-----END '`
  assert.equal(redactSecretText(code), code.replace(token, MASK))
  const truncated = `-----BEGIN CERTIFICATE-----\nMIIB\nAPI_TOKEN=${token}`
  assert.equal(redactSecretText(truncated), truncated.replace(token, MASK))
  // Padded base64url, such as a Fernet key, is a secret, not a digest.
  const fernet = 'Aa0-' + string(39, ALNUM) + '='
  assert.equal(redactSecretText(`FERNET_KEY=${fernet}`), `FERNET_KEY=${MASK}`)
  // An `=` after a token that is not padding stays.
  assert.equal(redactSecretText(`${token}=1 ${token}==value`), `${MASK}=1 ${MASK}==value`)
  // Lengths where the `=` would align the run: a token with a mark, and one after an escape.
  const marked = 'Aa0_' + string(43, ALNUM)
  assert.equal(redactSecretText(`${marked}=1`), `${MASK}=1`)
  const short = 'Aa0' + string(31, ALNUM)
  assert.equal(redactSecretText(`a\\n${short}=1`), `a\\n${MASK}=1`)
  // Outside the length bounds the heuristic does not decide.
  for (const length of [31, 129]) {
    const text = `t ${'Aa0' + string(length - 3, ALNUM)}`
    assert.equal(redactSecretText(text), text)
  }
})

test('the heuristic catches nearly every random 62-character-alphabet token', () => {
  const { string } = generator(5)
  for (const [length, floor] of [[32, 0.95], [40, 0.97], [64, 0.99]]) {
    let caught = 0
    for (let i = 0; i < 1000; i++) if (redactSecretText(`token ${string(length, ALNUM)}`) === `token ${MASK}`) caught++
    assert.ok(caught / 1000 >= floor, `length ${length}: caught ${caught} of 1000`)
  }
})

test('adversarial input stays linear: a long run of -eyJ with no dots', () => {
  // A word-boundary JWT pattern took about 30 s on 512 KB of this.
  const text = '-eyJ' + 'aaaaaaaa-eyJ'.repeat(87382)
  const started = performance.now()
  redactSecretText(text)
  assert.ok(performance.now() - started < 2000, 'took more than 2 s on 1 MB')
})

test('adversarial input stays linear: a database URL scheme before a long colon run', () => {
  // The user part used to take `:`, which made this about 1.6 s at 64 KB.
  for (const text of ['postgres://' + 'a:'.repeat(32768), 'redis://u:' + ':'.repeat(65536)]) {
    const started = performance.now()
    assert.equal(redactSecretText(text), text)
    assert.ok(performance.now() - started < 200, 'took more than 200 ms on 64 KB')
  }
  // A password may still hold `:`, and the whole URL is masked as before.
  assert.equal(redactSecretText('[ mysql://u:p:q@h:3306/x ]'), `[ ${MASK} ]`)
  assert.equal(redactSecretText('[ redis://a:b:c:d@h ]'), `[ ${MASK} ]`)
})

test('the heuristic false-positive bound: no realistic non-secret token in the corpus is masked', () => {
  const { rand, pick, string, bytes } = generator(1)
  const capitalized = () => { const word = pick(WORDS); return word[0].toUpperCase() + word.slice(1) }
  const camel = () => {
    let name = pick(WORDS)
    while (name.length < 32) name += capitalized()
    return name + (rand() < 0.5 ? String(Math.floor(rand() * 100)) : '')
  }
  const sentence = () => Array.from({ length: 6 + Math.floor(rand() * 10) }, () => pick(WORDS)).join(' ')
  /** @type {Record<string, () => string>} */
  const corpus = {
    commitSha: () => string(40, HEX),
    sha256: () => string(64, HEX),
    uuid: () => [8, 4, 4, 4, 12].map(n => string(n, HEX)).join('-'),
    ulid: () => string(26, '0123456789ABCDEFGHJKMNPQRSTVWXYZ'),
    camelCase: camel,
    pascalWithDigits: () => {
      let name = ''
      while (name.length < 34) name += capitalized() + (rand() < 0.3 ? String(Math.floor(rand() * 10)) : '')
      return name
    },
    snakeCase: () => {
      let name = pick(WORDS)
      while (name.length < 36) name += '_' + pick(WORDS)
      return name + '_' + Math.floor(rand() * 1000)
    },
    path: () => '/Users/dev/' + Array.from({ length: 4 }, camel).join('/') + '.js',
    base64Blob: () => bytes(300).toString('base64'),
    base64urlBlob: () => bytes(200).toString('base64url'),
    dataUrl: () => 'data:image/png;base64,' + bytes(120).toString('base64'),
    npmIntegrity: () => 'sha512-' + bytes(64).toString('base64'),
    paddedBase64: () => bytes([32, 64, 80][Math.floor(rand() * 3)]).toString('base64'),
    escapedPaddedBase64: () => 'line\\n' + bytes(32).toString('base64'),
    windowsPathPaddedBase64: () => 'C:\\d\\' + bytes(32).toString('base64'),
    goSum: () => 'golang.org/x/text v0.14.0 h1:' + bytes(32).toString('base64'),
    digestHeader: () => 'Digest: sha-256=' + bytes(32).toString('base64'),
    sshFingerprint: () => 'SHA256:' + bytes(32).toString('base64').replace(/=+$/, ''),
    sshPublicKey: () => 'ssh-ed25519 ' + Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), bytes(32)]).toString('base64') + ' dev@host',
    pemCertificate: () => '-----BEGIN CERTIFICATE-----\n' + (bytes(600).toString('base64').match(/.{1,64}/g) ?? []).join('\n') + '\n-----END CERTIFICATE-----',
    completionId: () => 'chatcmpl-' + string(29, ALNUM),
    toolUseId: () => 'toolu_' + string(24, ALNUM),
    encodedProse: () => Buffer.from(sentence()).toString('base64'),
    prose: sentence,
  }
  /** @type {Record<string, number>} */
  const masked = {}
  for (const [name, make] of Object.entries(corpus)) {
    masked[name] = 0
    for (let i = 0; i < 1000; i++) {
      const text = `value ${make()} end`
      if (redactSecretText(text) !== text) masked[name]++
    }
  }
  assert.deepEqual(masked, Object.fromEntries(Object.keys(corpus).map(name => [name, 0])))
})
