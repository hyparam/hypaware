import { describe, expect, it, vi } from 'vitest'
import { createScheduler, nextFireAt, parseTime } from '../../src/upload/scheduler.js'

describe('parseTime', () => {
  it('parses HH:MM', () => {
    expect(parseTime('00:10')).toEqual([0, 10])
    expect(parseTime('23:59')).toEqual([23, 59])
  })
  it('rejects malformed values', () => {
    expect(() => parseTime('1:00')).toThrow()
    expect(() => parseTime('25:00')).toThrow()
    expect(() => parseTime('00:60')).toThrow()
  })
})

describe('nextFireAt', () => {
  it('returns today\'s HH:MM if it is in the future', () => {
    const from = new Date('2026-05-07T08:00:00Z')
    const next = nextFireAt(from, 12, 0)
    expect(next.toISOString()).toBe('2026-05-07T12:00:00.000Z')
  })
  it('returns tomorrow\'s HH:MM if today\'s is in the past or now', () => {
    const from = new Date('2026-05-07T12:00:00Z')
    const next = nextFireAt(from, 12, 0)
    expect(next.toISOString()).toBe('2026-05-08T12:00:00.000Z')
  })
  it('handles midnight UTC', () => {
    const from = new Date('2026-05-07T23:30:00Z')
    const next = nextFireAt(from, 0, 10)
    expect(next.toISOString()).toBe('2026-05-08T00:10:00.000Z')
  })
})

describe('createScheduler', () => {
  it('runs the tick once on start, then schedules the next fire at HH:MM UTC', async () => {
    let now = new Date('2026-05-07T08:00:00Z')
    /** @type {Array<{ delay: number, handler: () => void }>} */
    const timers = []

    let ticks = 0
    const scheduler = createScheduler({
      time: '12:00',
      tick: () => { ticks++; return Promise.resolve() },
    }, {
      now: () => now,
      setTimeoutFn: (handler, delay) => {
        const handle = timers.length + 1
        timers.push({ delay, handler })
        return handle
      },
      clearTimeoutFn: () => {},
    })

    await scheduler.start()
    expect(ticks).toBe(1)
    expect(timers).toHaveLength(1)
    // 4 hours from 08:00 → 12:00
    expect(timers[0].delay).toBe(4 * 60 * 60 * 1000)

    // Advance time to the firing moment and run the timer's handler.
    now = new Date('2026-05-07T12:00:00Z')
    timers[0].handler()
    // Allow microtasks to drain the chained tick promise.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(ticks).toBe(2)
    expect(timers).toHaveLength(2)
    // Next firing is the following day at 12:00 → 24h.
    expect(timers[1].delay).toBe(24 * 60 * 60 * 1000)

    await scheduler.stop()
  })

  it('skipInitialTick: true skips the catch-up tick and only schedules the next fire', async () => {
    const now = new Date('2026-05-07T08:00:00Z')
    /** @type {Array<{ delay: number, handler: () => void }>} */
    const timers = []

    let ticks = 0
    const scheduler = createScheduler({
      time: '12:00',
      skipInitialTick: true,
      tick: () => { ticks++; return Promise.resolve() },
    }, {
      now: () => now,
      setTimeoutFn: (handler, delay) => {
        timers.push({ delay, handler })
        return timers.length
      },
      clearTimeoutFn: () => {},
    })

    await scheduler.start()
    expect(ticks).toBe(0)
    expect(timers).toHaveLength(1)
    expect(timers[0].delay).toBe(4 * 60 * 60 * 1000)

    await scheduler.stop()
  })

  it('schedules a fast retry when the previous tick reports retry: true', async () => {
    let now = new Date('2026-05-07T08:00:00Z')
    /** @type {Array<{ delay: number, handler: () => void }>} */
    const timers = []

    let tickCount = 0
    const scheduler = createScheduler({
      time: '12:00',
      retryDelayMs: 15 * 60 * 1000,
      tick: () => {
        tickCount++
        return Promise.resolve({ retry: tickCount === 1 })
      },
    }, {
      now: () => now,
      setTimeoutFn: (handler, delay) => {
        const handle = timers.length + 1
        timers.push({ delay, handler })
        return handle
      },
      clearTimeoutFn: () => {},
    })

    await scheduler.start()
    expect(tickCount).toBe(1)
    // First tick reported retry → next fire is 15min from 08:00, not 4h to 12:00.
    expect(timers).toHaveLength(1)
    expect(timers[0].delay).toBe(15 * 60 * 1000)

    now = new Date('2026-05-07T08:15:00Z')
    timers[0].handler()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(tickCount).toBe(2)
    // Second tick succeeded → back to normal daily cadence (12:00 - 08:15 = 3h45m).
    expect(timers).toHaveLength(2)
    expect(timers[1].delay).toBe((3 * 60 + 45) * 60 * 1000)

    await scheduler.stop()
  })

  it('schedules a fast retry when the tick throws', async () => {
    const now = new Date('2026-05-07T08:00:00Z')
    /** @type {Array<{ delay: number, handler: () => void }>} */
    const timers = []

    let tickCount = 0
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scheduler = createScheduler({
      time: '12:00',
      retryDelayMs: 15 * 60 * 1000,
      tick: () => {
        tickCount++
        return Promise.reject(new Error('boom'))
      },
    }, {
      now: () => now,
      setTimeoutFn: (handler, delay) => {
        const handle = timers.length + 1
        timers.push({ delay, handler })
        return handle
      },
      clearTimeoutFn: () => {},
    })

    await scheduler.start()
    errSpy.mockRestore()
    expect(tickCount).toBe(1)
    expect(timers).toHaveLength(1)
    expect(timers[0].delay).toBe(15 * 60 * 1000)

    await scheduler.stop()
  })
})
