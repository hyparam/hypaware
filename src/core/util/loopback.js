// @ts-check

// The one loopback predicate, shared by the three checks that have to agree
// on what "this machine" means: the OTLP listener's `Host` guard
// (`src/core/otlp/server.js`), the self-updater's registry-override trust
// (`src/core/update/self_update.js`), and the AI gateway's CONNECT and
// absolute-form peer checks. It imports nothing on purpose, because the
// self-updater is deliberately import-light: that module has to stay loadable
// when the rest of a release is broken.

/**
 * Does this string name *this machine*, decided from the string alone?
 *
 * Only the literal `localhost` and the loopback IP literals count; no
 * resolver is consulted, so a name that merely resolves here does not
 * qualify. That is the point at every call site: a `*.localhost` subdomain,
 * or an attacker's name rebound to 127.0.0.1, is what these checks exist to
 * turn away, and each one fails closed.
 *
 * Accepts the spellings the callers hand it: an IPv6 literal with or without
 * its brackets, mixed case, and the IPv4-mapped form a dual-stack listener
 * reports an IPv4 peer in (`::ffff:127.0.0.1`). The port is not one of them:
 * every caller has it off already, and reading one here would be a second
 * parser to disagree with theirs.
 *
 * Brackets come off only as a matched pair. A lone `]` is not punctuation to
 * tidy away, it is part of the name, and a name does not become this machine
 * because deleting a character from it would be: a `Host: localhost]` reaches
 * the OTLP guard intact, and answering it would widen the refusal that closed
 * the rebinding hole.
 *
 * `hexMappedIpv4` opts into the hex-serialized mapped form as well, and only
 * the self-updater passes it: a registry override written
 * `http://[::ffff:127.0.0.1]:4873` reaches that check as `[::ffff:7f00:1]`,
 * because `URL` re-serializes it, and refusing the hex form there would turn
 * away a Verdaccio plainly running on this machine. It stays off elsewhere
 * because nothing there produces it: libuv reports an IPv4-mapped peer in
 * dotted form, so it never arrives off a socket, and in a `Host` header it is
 * a caller-chosen literal no resolver can point elsewhere, so admitting it
 * would prove nothing about the sender.
 *
 * @param {string | undefined} host a `Host` header hostname, a URL hostname,
 * or a socket address
 * @param {{ hexMappedIpv4?: boolean }} [opts]
 * @returns {boolean}
 */
export function isLoopbackHost(host, opts) {
  if (!host) return false
  const bracketed = host.startsWith('[') && host.endsWith(']')
  const bare = (bracketed ? host.slice(1, -1) : host).toLowerCase()
  if (bare === 'localhost' || bare === '::1') return true
  // IPv4 loopback is the whole 127.0.0.0/8 block, not just 127.0.0.1.
  const dotted = bare.startsWith('::ffff:') ? bare.slice(7) : bare
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(dotted)) return true
  if (!opts?.hexMappedIpv4) return false
  // `::ffff:7f00:1` and friends: an IPv4-mapped address whose first 16-bit
  // group starts with 127 is 127.0.0.0/8 wearing an IPv6 coat, and nothing
  // else is (a short first group, `::ffff:7f:1`, is 0.127.0.1).
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(bare)
  return mapped ? Number.parseInt(mapped[1], 16) >>> 8 === 127 : false
}
