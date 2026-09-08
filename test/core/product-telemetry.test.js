// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import {
  createProductResource,
  createRuntimeSummary,
  productEvent,
  productBatch,
  PRODUCT_VERSION
} from '../../src/core/product_telemetry/collection.js'
import {
  validateBatch,
  COMMANDS
} from '../../src/core/product_telemetry/contract.js'
import {
  createOutbox,
  QUEUE_BYTES,
  QUEUE_SLOTS
} from '../../src/core/product_telemetry/outbox.js'
import {
  effectivePolicy,
  writePolicy,
  productRoot
} from '../../src/core/product_telemetry/policy.js'
import {
  createDelivery,
  retryAfterMs
} from '../../src/core/product_telemetry/delivery.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'

/** @param {any} t */
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-product-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const NOW = Date.parse('2026-09-08T12:00:00.000Z')
const binding = 'a'.repeat(64)
/** @param {number} [now] */
function batch(now = NOW) {
  return productBatch(
    createProductResource(),
    [
      /** @type {any} */ (
        productEvent(
          'cli.invocation',
          {
            command: 'query sql',
            invocation_kind: 'execution',
            outcome: 'success',
            exit_class: 'zero',
            duration_ms: 12
          },
          now
        )
      )
    ],
    now
  )
}

/** @param {string} dir @param {string} [org] */
function enroll(dir, org = 'org-a') {
  const identityPath = path.join(dir, 'identity.json')
  const jwt = `header.${Buffer.from(JSON.stringify({ org })).toString('base64url')}.signature`
  fs.writeFileSync(
    identityPath,
    JSON.stringify({
      central_url: 'https://example.invalid',
      gateway_id: randomUUID(),
      jwt,
      expires_at: NOW / 1000 + 86400
    })
  )
  return writePolicy(dir, 'organization', {
    url: 'https://example.invalid',
    identityPath
  })
}
const capability = () =>
  new Response(
    JSON.stringify({
      schema_versions: [1],
      max_records: 100,
      max_batch_bytes: 32768,
      max_queue_age_seconds: 604800,
      dedup_seconds: 691200
    }),
    { status: 200 }
  )

// Construction fixtures deliberately mix every forbidden class into a record.
test('product construction drops forbidden fields and normalizes finite labels', () => {
  const secret =
    '/Users/private/repo select prompt response hostname token https://secret.invalid'
  const event = productEvent(
    'cli.invocation',
    {
      command: secret,
      invocation_kind: secret,
      outcome: secret,
      exit_class: secret,
      duration_ms: 4,
      argv: [secret],
      sql: secret,
      error: secret,
      stack: secret,
      plugin: secret,
      resource: secret
    },
    NOW
  )
  assert.equal(JSON.stringify(event).includes(secret), false)
  assert.equal(event?.attributes.command, 'unknown')
  assert.equal(
    validateBatch(
      productBatch(createProductResource(), [/** @type {any} */ (event)], NOW),
      NOW
    ),
    null
  )
  assert.equal(productEvent('anything-private', { secret }, NOW), null)
  const injected = batch()
  assert(injected)
  injected.records[0].attributes.path = secret
  assert.equal(validateBatch(injected, NOW), 'invalid_event')
})

test('resource is actual package version and finite platform, role, test traffic', () => {
  const resource = createProductResource({
    role: 'daemon',
    env: {
      HYP_DEV_TELEMETRY: '1',
      OTEL_RESOURCE_ATTRIBUTES: 'user.name=secret',
      OTEL_SERVICE_NAME: 'private'
    }
  })
  assert.equal(resource['service.version'], PRODUCT_VERSION)
  assert.equal(resource['service.role'], 'daemon')
  assert.equal(resource['deployment.environment'], 'test')
  assert.equal(JSON.stringify(resource).includes('private'), false)
  assert.equal(JSON.stringify(resource).includes('secret'), false)
  const server = createProductResource({ role: 'server', version: '2.3.4' })
  assert.equal(server['hypaware.version'], PRODUCT_VERSION)
})

test('basic sampler measures interval CPU and weighted average, peak and latest', () => {
  let wall = NOW
  let mono = 0
  let cpu = 0
  let memory = 100
  const sampler = createRuntimeSummary({
    now: () => wall,
    monotonicNow: () => mono,
    cpuUsage: () => ({ user: cpu, system: 0 }),
    memoryUsage: () => ({ rss: memory, heapUsed: memory / 2 })
  })
  mono += 30000
  wall += 30000
  cpu += 15000000
  sampler.sample()
  memory = 300
  mono += 15000
  wall += 15000
  cpu += 15000000
  sampler.sample()
  const points = sampler.flush()
  const rss = points.find((p) => p.name === 'process.rss')
  assert(rss)
  assert.equal(rss.average, 500 / 3)
  assert.equal(rss.max, 300)
  assert.equal(rss.value, 300)
  assert.equal(rss.coverageMs, 45000)
  const cpuPoint = points.find((p) => p.name === 'process.cpu')
  assert.equal(cpuPoint?.average, 2 / 3)
  assert.equal(cpuPoint?.value, 1)
  assert.equal(cpuPoint?.max, 1)
  assert.equal(
    validateBatch(productBatch(createProductResource(), points, wall), wall),
    null
  )
  assert.deepEqual(sampler.flush(), [])
})

test('sampler omits stalls, invalid memory, and missing samples rather than zero-filling', () => {
  let now = NOW
  const sampler = createRuntimeSummary({
    now: () => now,
    monotonicNow: () => now,
    cpuUsage: () => ({ user: 0, system: 0 }),
    memoryUsage: () => ({ rss: NaN, heapUsed: Infinity })
  })
  now += 30000
  sampler.sample()
  assert.deepEqual(
    sampler.flush().map((p) => p.name),
    ['process.cpu']
  )
  now += 70000
  sampler.sample()
  assert.deepEqual(sampler.flush(), [])
})

test('concurrent writers share an aggregate fixed byte and count cap', async (t) => {
  const root = temp(t)
  const url = new URL(
    '../../src/core/product_telemetry/outbox.js',
    import.meta.url
  ).href
  const b = batch()
  const script = `import {createOutbox} from ${JSON.stringify(url)}; const q=createOutbox(process.argv[1],{now:()=>${NOW}});const b=JSON.parse(process.argv[2]);for(let i=0;i<100;i++)q.append(b,${JSON.stringify(binding)})`
  await Promise.all(
    Array.from({ length: 6 }, () =>
      child(['--input-type=module', '-e', script, root, JSON.stringify(b)])
    )
  )
  const queue = createOutbox(root, { now: () => NOW })
  const status = queue.status()
  assert.equal(status.queue_batches, QUEUE_SLOTS)
  assert(status.queue_bytes <= QUEUE_BYTES)
  assert.equal(status.dropped_lower_bound, 1)
  assert.equal(fs.readdirSync(path.join(root, 'queue-v1')).length, QUEUE_SLOTS)
})

test('queue survives restart with immutable bytes and expires after seven days', (t) => {
  const root = temp(t)
  const queue = createOutbox(root, { now: () => NOW })
  const b = batch()
  assert(queue.append(b, binding))
  const entry = createOutbox(root, { now: () => NOW }).entries()[0]
  assert.equal(entry.wire, JSON.stringify(b))
  assert.equal(queue.prune(binding), 0)
  assert.equal(
    createOutbox(root, { now: () => NOW + 7 * 86400000 + 1 }).prune(binding),
    1
  )
  assert.equal(queue.entries().length, 0)
})

test('queue rejects oversized, malformed and non-allowlisted batches without throwing', (t) => {
  const root = temp(t)
  const queue = createOutbox(root, { now: () => NOW })
  assert.equal(queue.append({ secret: 'sql' }, binding), false)
  fs.writeFileSync(path.join(root, 'not-directory'), 'x')
  assert.equal(
    createOutbox(path.join(root, 'not-directory')).append(
      batch(Date.now()),
      binding
    ),
    false
  )
})

test('local identity exists only after enable, and consent/enrollment changes invalidate copies', (t) => {
  const root = temp(t)
  assert.equal(effectivePolicy(root).mode, 'off')
  assert.deepEqual(fs.readdirSync(root), [])
  const local = writePolicy(root, 'local')
  assert.match(local.policy.installation_id, /^[0-9a-f-]{36}$/)
  const queue = createOutbox(root, { now: () => NOW })
  assert(queue.append(batch(), /** @type {string} */ (local.binding)))
  const org = enroll(root)
  queue.prune(org.binding)
  assert.equal(queue.entries().length, 0)
  assert(queue.append(batch(), /** @type {string} */ (org.binding)))
  const newOrg = enroll(root, 'org-b')
  assert.notEqual(org.binding, newOrg.binding)
  queue.prune(newOrg.binding)
  assert.equal(queue.entries().length, 0)
  const before = effectivePolicy(root)
  const id = JSON.parse(
    fs.readFileSync(path.join(root, 'identity.json'), 'utf8')
  )
  id.gateway_id = randomUUID()
  fs.writeFileSync(path.join(root, 'identity.json'), JSON.stringify(id))
  assert.equal(effectivePolicy(root).reason, 'enrollment_changed')
  assert(before.binding)
  writePolicy(root, 'off')
  assert.equal(effectivePolicy(root).mode, 'off')
})

test('lost acknowledgement retries byte-identically after sender restart', async (t) => {
  const root = temp(t)
  const policy = enroll(root)
  let now = NOW
  const queue = createOutbox(root, { now: () => now })
  queue.append(batch(), /** @type {string} */ (policy.binding))
  const sent = []
  let lost = true
  const fetchFn = /** @type {typeof fetch} */ (
    async (_, init) => {
      if (!init?.method) return capability()
      sent.push(init.body)
      if (lost) {
        lost = false
        throw new Error('lost ack')
      }
      return new Response(JSON.stringify({ status: 202, duplicate: true }), {
        status: 202
      })
    }
  )
  await createDelivery(root, {
    fetchFn,
    now: () => now,
    random: () => 0
  }).drain()
  assert.equal(queue.entries().length, 1)
  now += 10000
  await createDelivery(root, { fetchFn, now: () => now }).drain()
  assert.equal(queue.entries().length, 0)
  assert.equal(sent.length, 2)
  assert.equal(sent[0], sent[1])
})

for (const status of [404, 401, 429, 503, 413, 422, 409]) {
  test(`receiver ${status} is bounded and ${[413, 422, 409].includes(status) ? 'terminal' : 'retained'}`, async (t) => {
    const root = temp(t)
    const policy = enroll(root)
    const queue = createOutbox(root, { now: () => NOW })
    queue.append(batch(), /** @type {string} */ (policy.binding))
    const fetchFn = /** @type {typeof fetch} */ (
      async (_, init) =>
        !init?.method
          ? capability()
          : new Response('{}', { status, headers: { 'retry-after': '60' } })
    )
    await createDelivery(root, { fetchFn, now: () => NOW }).drain()
    assert.equal(
      queue.entries().length,
      [413, 422, 409].includes(status) ? 0 : 1
    )
    if ([429, 503].includes(status))
      assert(queue.readDelivery().next_at >= NOW + 60000)
  })
}

test('disable between capability and POST prevents sending the old copy', async (t) => {
  const root = temp(t)
  const policy = enroll(root)
  const queue = createOutbox(root, { now: () => NOW })
  queue.append(batch(), /** @type {string} */ (policy.binding))
  let posts = 0
  const fetchFn = /** @type {typeof fetch} */ (
    async (_, init) => {
      if (init?.method) posts++
      writePolicy(root, 'off')
      return capability()
    }
  )
  await createDelivery(root, { fetchFn, now: () => NOW }).drain()
  assert.equal(posts, 0)
})

test('Retry-After supports seconds and HTTP dates with a bounded maximum', () => {
  assert.equal(retryAfterMs('60', NOW), 60000)
  assert.equal(retryAfterMs(new Date(NOW + 120000).toUTCString(), NOW), 120000)
  assert.equal(retryAfterMs('0', NOW), 0)
  assert.equal(retryAfterMs('garbage', NOW), 0)
  assert.equal(retryAfterMs('9999999999', NOW), 86400000)
})

for (const [argv, expected] of [
  [['--version'], ['version', 'version', 'success']],
  [['--help'], ['help', 'help', 'success']],
  [
    ['private-command', 'secret'],
    ['unknown', 'unknown', 'failure']
  ]
]) {
  test(`outer dispatch covers ${argv[0]} with exactly one summary`, async (t) => {
    const home = temp(t)
    const env = { HYP_HOME: home, HYP_DEV_TELEMETRY: '1' }
    const root = productRoot(env)
    writePolicy(root, 'local')
    await dispatch(argv, {
      env,
      stdout: { write() {} },
      stderr: { write() {} }
    })
    const records = createOutbox(root)
      .entries()
      .flatMap((e) => JSON.parse(e.wire).records)
    const invocations = records.filter((r) => r.name === 'cli.invocation')
    assert.equal(invocations.length, 1)
    assert.deepEqual(
      ['command', 'invocation_kind', 'outcome'].map(
        (k) => invocations[0].attributes[k]
      ),
      expected
    )
    assert.equal(JSON.stringify(records).includes('private-command'), false)
  })
}

test('canonical aliases, nested setup commands and cancellation count only the outer invocation', async (t) => {
  const home = temp(t)
  const env = { HYP_HOME: home }
  const root = productRoot(env)
  writePolicy(root, 'local')
  const registry = createCommandRegistry()
  registry.register({
    name: 'setup',
    aliases: ['init'],
    summary: '',
    usage: '',
    run: async (_, ctx) => {
      await ctx.commands?.run('version', [])
      return 130
    }
  })
  registry.register({
    name: 'version',
    summary: '',
    usage: '',
    run: async () => 0
  })
  const kernel = createKernelRuntime({ cacheRoot: path.join(home, 'cache') })
  assert.equal(
    await dispatch(['init'], {
      registry,
      kernel,
      env,
      stdout: { write() {} },
      stderr: { write() {} }
    }),
    130
  )
  const records = createOutbox(root)
    .entries()
    .flatMap((e) => JSON.parse(e.wire).records)
  const summaries = records.filter((r) => r.name === 'cli.invocation')
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].attributes.command, 'setup')
  assert.equal(summaries[0].attributes.outcome, 'cancelled')
  assert.equal(records.filter((r) => r.name === 'setup.step').length, 1)
  assert(COMMANDS.includes('setup'))
})

/** @param {string[]} args */
function child(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    proc.stderr.on('data', (b) => {
      stderr += b
    })
    proc.on('error', reject)
    proc.on('exit', (code) =>
      code === 0 ? resolve(undefined) : reject(new Error(stderr))
    )
  })
}

test('close aborts in-flight delivery immediately without waiting for the receiver', async (t) => {
  const root = temp(t)
  const policy = enroll(root)
  createOutbox(root, { now: () => NOW }).append(
    batch(),
    /** @type {string} */ (policy.binding)
  )
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  let aborted = false
  const fetchFn = /** @type {typeof fetch} */ (
    async (_, init) =>
      new Promise((resolve, reject) => {
        started()
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error('aborted'))
          },
          { once: true }
        )
      })
  )
  const delivery = createDelivery(root, { fetchFn, now: () => NOW })
  const pending = delivery.drain()
  await ready
  assert.equal(delivery.close(), undefined)
  await pending
  assert(aborted)
  assert.equal(createOutbox(root).entries().length, 1)
})

test('a durable-looking HTTP response without the exact receipt does not acknowledge', async (t) => {
  const root = temp(t)
  const policy = enroll(root)
  const queue = createOutbox(root, { now: () => NOW })
  queue.append(batch(), /** @type {string} */ (policy.binding))
  await createDelivery(root, {
    now: () => NOW,
    fetchFn: /** @type {typeof fetch} */ (
      async (_, init) =>
        init?.method ? new Response('{}', { status: 202 }) : capability()
    )
  }).drain()
  assert.equal(queue.entries().length, 1)
})

test('sender lock survives a live owner and recovers a dead owner after restart', (t) => {
  const root = temp(t)
  const queue = createOutbox(root)
  const release = queue.claim()
  assert(release)
  assert.equal(createOutbox(root).claim(), null)
  release()
  fs.symlinkSync('2147483647-dead', path.join(root, 'sender.lock'))
  const recovered = createOutbox(root).claim()
  assert(recovered)
  recovered()
})

test('construction rejects coerced version and metric names rather than throwing', () => {
  const version = batch()
  assert(version)
  version.resource['service.version'] = /** @type {any} */ (['1.31.0'])
  assert.equal(validateBatch(version, NOW), 'invalid_resource')
  const metric = batch()
  assert(metric)
  metric.records = [
    {
      kind: 'metric',
      name: ['process.cpu'],
      timestamp: new Date(NOW).toISOString()
    }
  ]
  assert.equal(validateBatch(metric, NOW), 'invalid_metric')
})

test('import/bootstrap failure inside the outer boundary has one failure summary', async (t) => {
  const { withProductInvocation } = await import(
    '../../src/core/product_telemetry/client.js'
  )
  const home = temp(t)
  const env = { HYP_HOME: home }
  const root = productRoot(env)
  writePolicy(root, 'local')
  await assert.rejects(
    withProductInvocation(['query', 'sql', 'secret'], env, async () => {
      throw new Error('secret config path')
    })
  )
  const records = createOutbox(root)
    .entries()
    .flatMap((e) => JSON.parse(e.wire).records)
  assert.equal(records.filter((r) => r.name === 'cli.invocation').length, 1)
  assert.equal(
    records.find((r) => r.name === 'cli.invocation').attributes.outcome,
    'failure'
  )
  assert.equal(JSON.stringify(records).includes('secret'), false)
})

test('a custom plugin command is other and whole invocation duration includes work', async (t) => {
  const home = temp(t)
  const env = { HYP_HOME: home }
  const root = productRoot(env)
  writePolicy(root, 'local')
  const registry = createCommandRegistry()
  registry.register({
    name: 'customer-private-command',
    summary: '',
    usage: '',
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return 0
    }
  })
  const kernel = createKernelRuntime({ cacheRoot: path.join(home, 'cache') })
  await dispatch(['customer-private-command'], {
    registry,
    kernel,
    env,
    stdout: { write() {} },
    stderr: { write() {} }
  })
  const record = createOutbox(root)
    .entries()
    .flatMap((e) => JSON.parse(e.wire).records)
    .find((r) => r.name === 'cli.invocation')
  assert.equal(record.attributes.command, 'other')
  assert(record.attributes.duration_ms >= 20)
})

test('24-hour simulated receiver outage stays bounded and never starts a new retry window', async (t) => {
  const root = temp(t)
  const policy = enroll(root)
  let now = NOW
  const queue = createOutbox(root, { now: () => now })
  let attempts = 0
  const delivery = createDelivery(root, {
    now: () => now,
    random: () => 0.5,
    fetchFn: /** @type {typeof fetch} */ (
      async () => {
        attempts++
        return new Response('{}', {
          status: 503,
          headers: { 'retry-after': '3600' }
        })
      }
    )
  })
  for (let i = 0; i < 288; i++) {
    queue.append(batch(now), /** @type {string} */ (policy.binding))
    await delivery.drain()
    now += 300000
  }
  const status = queue.status()
  assert(status.queue_bytes <= QUEUE_BYTES)
  assert.equal(status.queue_batches, QUEUE_SLOTS)
  assert(attempts <= 24)
  assert.equal(status.dropped_lower_bound, 1)
  delivery.close()
})

test('replay validates the on-disk payload before any network request', async (t) => {
  const root = temp(t)
  const policy = enroll(root)
  const queue = createOutbox(root, { now: () => NOW })
  queue.append(batch(), /** @type {string} */ (policy.binding))
  const entry = queue.entries()[0]
  const file = path.join(root, 'queue-v1', `${entry.slot}.json`)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  const body = JSON.parse(stored.wire)
  body.records[0].attributes.argv = 'private SQL'
  stored.wire = JSON.stringify(body)
  fs.writeFileSync(file, JSON.stringify(stored))
  let requests = 0
  await createDelivery(root, {
    now: () => NOW,
    fetchFn: /** @type {typeof fetch} */ (
      async () => {
        requests++
        return capability()
      }
    )
  }).drain()
  assert.equal(requests, 0)
  assert.equal(queue.entries().length, 0)
})

test('corrupt complete JSON slots and torn writes are reclaimed after the grace period', (t) => {
  const root = temp(t)
  const queue = createOutbox(root, { now: () => NOW })
  fs.mkdirSync(path.join(root, 'queue-v1'))
  for (const [slot, body] of ['{"binding":"x","wire":"{}"}', '{'].entries()) {
    const file = path.join(root, 'queue-v1', `${slot}.json`)
    fs.writeFileSync(file, body)
    fs.utimesSync(file, (NOW - 120000) / 1000, (NOW - 120000) / 1000)
  }
  assert.equal(queue.prune(binding), 2)
  assert.deepEqual(fs.readdirSync(path.join(root, 'queue-v1')), [])
})
