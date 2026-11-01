// @ts-check

// Shared secret rules. Export redaction applies them to every exported string
// today; recording-time redaction is meant to import the same functions, so a
// rule added here reaches both paths at once.

export const SECRET_MASK = '[REDACTED]'

export const CREDENTIAL_KEYS = /^(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key|authorization)$/i

// Small, maintained patterns with recognizable credential syntax. Avoid a
// thousands-of-regex pass over every string in a growing transcript.
const PATTERNS = [
  /\bsk-(?:ant-[A-Za-z0-9_-]{16,}|proj-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{32,})\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/@]+:[^\s/@]+@[^\s"'<>]+/gi,
  /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
  /\bsk_live_[A-Za-z0-9]{24,}\b/g,
  // A JWT is three base64url segments whose header encodes `{"`. The
  // signature segment is empty for an unsigned token. The lookbehind starts a
  // match only where a run starts; `\b` would retry at every `-eyJ` in a long
  // run and backtrack to its end each time, which is quadratic.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
]
const ASSIGNMENT = /\b((?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key)\s*[=:]\s*["']?)[^\s"'<>;,}{]{4,}/gi

/** @param {string} text */
function privateKeys(text) {
  if (!text.includes('-----BEGIN ')) return text
  const begin = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----/g
  const parts = []
  let offset = 0
  let match
  while ((match = begin.exec(text))) {
    parts.push(text.slice(offset, match.index), SECRET_MASK)
    const end = `-----END ${match[1]}-----`
    const at = text.indexOf(end, begin.lastIndex)
    if (at < 0) return parts.join('')
    offset = at + end.length
    begin.lastIndex = offset
  }
  return parts.length ? parts.join('') + text.slice(offset) : text
}

// Entropy heuristic for random tokens with no recognizable syntax. A
// candidate is a whole run of base64url characters; every test below must
// pass, so each one only narrows what is masked.
const MIN_TOKEN = 32
const MAX_TOKEN = 128
// Provider message, call and integrity identifiers look random but are
// recorded routinely and are not credentials.
const IDENTIFIER_PREFIX = /^(?:chatcmpl|msg|toolu|srvtoolu|req|call|resp|rs|fc|sha1|sha256|sha384|sha512)[-_]/
// A digest or public key named by the label before it: go.sum `h1:`, SSH
// `SHA256:` fingerprints, `sha-256=` digest headers and SSH key lines.
const DIGEST_LABEL = /(?:\b(?:h1|md5|sha-?(?:1|224|256|384|512))[:=]|\b(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp\d+)\s+)$/i
// Whole PEM armor lines, so a `'-----BEGIN '` literal in code is not a block.
const ARMOR_BEGIN = /-----BEGIN [A-Z0-9 ]{1,40}-----/g
const ARMOR_END = /-----END [A-Z0-9 ]{1,40}-----/g
// The expected Shannon entropy of n characters drawn uniformly from 62 is
// about log2(62) - 61 / (2n ln 2). The bound sits 0.5 bits below it, under
// the 0.1st percentile of random tokens at every candidate length.
const ENTROPY_BOUND = Float64Array.from({ length: MAX_TOKEN + 1 }, (_, n) =>
  n < MIN_TOKEN ? Infinity : Math.log2(62) - 61 / (2 * n * Math.LN2) - 0.5)
// Share of adjacent characters that change class (upper, lower, digit,
// other). Random tokens sit near 0.62; camelCase and snake_case identifiers
// stay under 0.4 because each word is one long run.
const MIN_TRANSITIONS = 0.42
// Share of adjacent pairs an identifier rarely has: two capitals, a capital
// then a digit, or a digit then a lowercase letter. PascalCase names with
// digits between words have none; random tokens have at least 0.065 in
// 999 of 1000 cases.
const MIN_RARE_PAIRS = 0.06
const UPPER = 0
const LOWER = 1
const DIGIT = 2
const MARK = 3
const OTHER = 4
// Class of each ASCII code; everything else is OTHER. MARK is - and _.
const CLASS = Uint8Array.from({ length: 128 }, (_, code) =>
  code >= 65 && code <= 90 ? UPPER : code >= 97 && code <= 122 ? LOWER
    : code >= 48 && code <= 57 ? DIGIT : code === 45 || code === 95 ? MARK : OTHER)
const counts = new Uint16Array(128)

/** @param {number} code NaN before or past the string */
function charClass(code) {
  return code < 128 ? CLASS[code] : OTHER
}

/** @param {number} code */
function base64Index(code) {
  const kind = CLASS[code]
  return kind === UPPER ? code - 65 : kind === LOWER ? code - 71 : kind === DIGIT ? code + 4 : 62
}

// Base64 of 7-bit text leaves three bits clear in every 4-character group:
// each byte's high bit. A random token keeps all three clear in about one
// group in eight, so a whole token of them is encoded text, not a key.
/** @param {string} text @param {number} start @param {number} end */
function encodedText(text, start, end) {
  for (let i = start; i < end; i += 4) {
    if (base64Index(text.charCodeAt(i)) >= 32) return false
    if (i + 1 < end && base64Index(text.charCodeAt(i + 1)) & 8) return false
    if (i + 2 < end && base64Index(text.charCodeAt(i + 2)) & 2) return false
  }
  return true
}

/** @param {string} text @param {number} start @param {number} end */
function looksRandom(text, start, end) {
  const length = end - start
  if (length < MIN_TOKEN || length > MAX_TOKEN) return false
  let seen = 0
  let transitions = 0
  let rare = 0
  let previous = CLASS[text.charCodeAt(start)]
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i)
    const kind = CLASS[code]
    if (kind !== MARK) seen |= 1 << kind
    if (kind !== previous) transitions++
    if (previous === UPPER ? kind === UPPER || kind === DIGIT : previous === DIGIT && kind === LOWER) rare++
    previous = kind
    counts[code]++
  }
  let entropy = 0
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i)
    const count = counts[code]
    if (!count) continue
    const p = count / length
    entropy -= p * Math.log2(p)
    counts[code] = 0
  }
  // Hex (commit SHAs, digests, UUIDs) lacks one of the three classes.
  return seen === 7 && transitions / (length - 1) >= MIN_TRANSITIONS && rare / (length - 1) >= MIN_RARE_PAIRS &&
    entropy >= ENTROPY_BOUND[length] &&
    !encodedText(text, start, end) && !IDENTIFIER_PREFIX.test(text.slice(start, start + 10))
}

/** @param {string} text @param {number} start @param {number} end */
function hasMark(text, start, end) {
  for (let i = start; i < end; i++) if (CLASS[text.charCodeAt(i)] === MARK) return true
  return false
}

/** @param {string} text @param {number} at */
function continues(text, at) {
  const code = text.charCodeAt(at)
  return code === 47 || code === 43
}

/**
 * One left-to-right scan; a run is examined only once it ends, and each run is
 * read again at most a constant number of times, so cost is linear in the text.
 * @param {string} text
 */
function maskRandomTokens(text) {
  /** @type {string[] | undefined} */
  let parts
  let copied = 0
  const length = text.length
  let i = 0
  // Base64 inside a PEM block (a certificate or public key; private keys are
  // already masked whole) is armor. Blocks are found once, moving forward.
  let armorSearch = text.includes('-----BEGIN ') ? 0 : -1
  let armorFrom = -1
  let armorTo = -1
  while (i < length) {
    while (i < length && charClass(text.charCodeAt(i)) === OTHER) i++
    const run = i
    while (i < length && charClass(text.charCodeAt(i)) !== OTHER) i++
    if (i - run < MIN_TOKEN) continue
    let from = run
    // The letter after a backslash in escaped text is the escape, not the token.
    if (text.charCodeAt(from - 1) === 92) from++
    // Part of a path, URL, base64 blob, hostname or dotted name, or padded
    // standard base64 (a digest or key), not a token. A backslash may be an
    // escape or part of a path, so either alignment counts as padded.
    let end = i
    while (text.charCodeAt(end) === 61) end++
    const padded = end > i && end - i <= 2 && (end - from) % 4 === 0
    if (end > i && ((end - run) % 4 === 0 || (end - from) % 4 === 0) && !hasMark(text, from, i)) continue
    if (continues(text, from - 1) || continues(text, end) ||
        (text.charCodeAt(from - 1) === 46 && charClass(text.charCodeAt(from - 2)) !== OTHER) ||
        (text.charCodeAt(end) === 46 && charClass(text.charCodeAt(end + 1)) !== OTHER)) continue
    if (!looksRandom(text, from, i)) continue
    if (DIGEST_LABEL.test(text.slice(Math.max(0, from - 24), from))) continue
    // A BEGIN line pairs with the next END line. A block that no END closes
    // is not armor, and then no later block can close either.
    while (armorSearch >= 0 && armorTo <= from) {
      ARMOR_BEGIN.lastIndex = armorSearch
      const begin = ARMOR_BEGIN.exec(text)
      ARMOR_END.lastIndex = ARMOR_BEGIN.lastIndex
      const close = begin && ARMOR_END.exec(text)
      if (!begin || !close) {
        armorSearch = -1
        break
      }
      armorFrom = begin.index
      armorTo = close.index
      armorSearch = ARMOR_END.lastIndex
    }
    if (armorFrom >= 0 && armorFrom <= from && from < armorTo) continue
    ;(parts ??= []).push(text.slice(copied, from), SECRET_MASK)
    copied = padded ? end : i
  }
  return parts ? parts.join('') + text.slice(copied) : text
}

/**
 * Mask every recognized secret in one string. Every rule is compiled at load;
 * the heuristic and the formats added with it are linear in the string.
 * @param {string} text
 * @ref LLP 0566#entropy-heuristic [implements]: conservative random-token masking alongside the explicit formats
 */
export function redactSecretText(text) {
  let result = privateKeys(text)
  for (const pattern of PATTERNS) result = result.replace(pattern, SECRET_MASK)
  result = result.replace(ASSIGNMENT, (_, prefix) => prefix + SECRET_MASK)
  return maskRandomTokens(result)
}

/** @param {string} file */
export function isSensitiveFile(file) {
  const normalized = file.replace(/\\/g, '/').toLowerCase()
  const name = normalized.split('/').at(-1) ?? ''
  if (/^\.env(?:\.|$)/.test(name) && !/\.(?:example|sample|template)$/.test(name)) return true
  return /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|\.npmrc|\.netrc|\.git-credentials|\.zshrc|\.bashrc|\.bash_profile|\.profile|\.zsh_history|\.bash_history|secrets\.ya?ml|master\.key|service[-_]account\.json)$/.test(name) ||
    /\.(?:pem|key)$/.test(name) || /(?:^|\/)(?:\.aws\/(?:credentials|config)|\.docker\/config\.json|\.kube\/config)$/.test(normalized)
}
