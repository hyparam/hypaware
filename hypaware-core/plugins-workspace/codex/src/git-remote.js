// @ts-check

/**
 * Strip credential userinfo (`user[:token]@`) from a git remote URL so a token
 * embedded in an HTTPS remote — e.g. `https://x-access-token:<token>@github.com/owner/repo.git`,
 * which `gh` and CI checkouts write into `remote.origin.url` — never lands in a
 * stored `git_remote` column, the `attributes.codex.git_origin_url` mirror, or
 * the graph's `source_keys`. Convergence only needs the normalized `owner/repo`
 * (`keys.ownerRepoFromRemote` discards userinfo anyway), so the raw secret has
 * no downstream use.
 *
 * Only the `scheme://[user[:token]@]host/…` URL form carries a secret; the
 * scp-like SSH form (`git@github.com:owner/repo.git`) authenticates by key, so
 * its `git@` user is meaningful and is left intact. Non-strings and the
 * userinfo-free case pass through unchanged.
 *
 * Kept tiny and duplicated per capture plugin (see `@hypaware/claude`) rather
 * than shared — the plugins are decoupled; a test on each path pins it.
 *
 * @ref LLP 0032#remote-redaction — owner/repo is all convergence needs; the raw remote can carry a secret
 * @param {string | undefined} remote
 * @returns {string | undefined}
 */
export function redactRemoteUserinfo(remote) {
  if (typeof remote !== 'string' || remote.length === 0) return remote
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1')
}
