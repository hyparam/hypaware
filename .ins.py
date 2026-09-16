import io
p='test/core/product-telemetry.test.js'
src=open(p).read()
anchor="""    fs.writeFileSync(remote.configPath, broken === 'invalid config' ? '{bad' : JSON.stringify(remote.config))
    assert.equal(effectivePolicy(productRoot({ HYP_HOME: home })).mode, 'off')
  })
}
"""
assert src.count(anchor)==1
block = """
// The raw destination becomes the POST target's prefix, so shapes a parse
// alone accepts still move `/v1/telemetry` off the path: a bare `?`/`#` leaves
// `search`/`hash` empty and turns the receiver path into a query or fragment,
// and a doubled trailing slash survives a single-slash strip. Delimiters are
// rejected; redundant trailing slashes normalize to one destination.
for (const [shape, url, target] of [
  ['a fragment after a path', 'https://example.invalid/receiver#', null],
  ['a query after a path', 'https://example.invalid/receiver?', null],
  ['a doubled trailing slash', 'https://example.invalid//', 'https://example.invalid/v1/telemetry']
]) {
  test(`${shape} ${target ? 'normalizes to one receiver path' : 'is not a usable destination'}`, async (t) => {
    const home = temp(t)
    const root = productRoot({ HYP_HOME: home })
    const remote = remoteEnrollment(home)
    remote.config.sinks.central.config.url = url
    remote.identity.central_url = url
    fs.writeFileSync(remote.configPath, JSON.stringify(remote.config))
    fs.writeFileSync(remote.identityPath, JSON.stringify(remote.identity))
    // The automatic and explicit paths reach the same verdict, and a refusal
    // names the destination rather than the identity.
    if (target) writePolicy(root, 'organization', { url, identityPath: remote.identityPath })
    else
      assert.throws(
        () => writePolicy(root, 'organization', { url, identityPath: remote.identityPath }),
        /destination/
      )
    const effective = effectivePolicy(root)
    assert.equal(effective.mode, target ? 'organization' : 'off')
    if (!target) return
    createOutbox(root, { now: () => NOW }).append(batch(), /** @type {string} */ (effective.binding))
    const seen = []
    let unauthorized = true
    const fetchFn = /** @type {typeof fetch} */ (async (requested, init) => {
      seen.push(requested)
      if (String(requested).endsWith('/v1/identity/refresh'))
        return new Response(JSON.stringify({ jwt: remote.identity.jwt }), { status: 200 })
      if (unauthorized) {
        unauthorized = false
        return new Response(null, { status: 401 })
      }
      return init?.method === 'POST'
        ? new Response(JSON.stringify({ status: 202, duplicate: false }), { status: 202 })
        : capability()
    })
    await createDelivery(root, { fetchFn, now: () => NOW }).drain()
    // Both routes carry the receiver path, and the 401 refresh inherits it.
    assert.deepEqual(seen, [target, 'https://example.invalid/v1/identity/refresh', target, target])
    assert.equal(createOutbox(root, { now: () => NOW }).entries().length, 0)
  })
}
"""
src=src.replace(anchor, anchor+block)
open(p,'w').write(src)
