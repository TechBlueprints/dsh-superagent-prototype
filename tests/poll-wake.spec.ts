import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pause, Waker, WAKE_MIN_MS } from '../src/sources/poll.ts'
import { missedWebhookLine, watchForge } from '../src/sources/forge-poll.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Trigger } from '../src/core/index.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { giteaKind } from '../src/sources/gitea.ts'
import { githubKind } from '../src/sources/github.ts'
import { SettingsSchema } from '../src/policy.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const settled = (promise: Promise<unknown>) => { let done = false; void promise.then(() => { done = true }); return () => done }

it('ends a pause on a wake, but not before the minimum gap', async () => {
  const waker = new Waker()
  const done = settled(pause(86_400_000, new AbortController().signal, waker))
  await vi.advanceTimersByTimeAsync(1000)
  waker.wake()
  await vi.advanceTimersByTimeAsync(WAKE_MIN_MS - 1000 - 1)
  expect(done()).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(done()).toBe(true)
  expect(waker.take()).toBe(false)
})

it('runs one more round for wakes that arrive while no pause is waiting, however many', async () => {
  const waker = new Waker()
  waker.wake(); waker.wake()
  const first = settled(pause(86_400_000, new AbortController().signal, waker))
  await vi.advanceTimersByTimeAsync(WAKE_MIN_MS)
  expect(first()).toBe(true)
  const second = settled(pause(86_400_000, new AbortController().signal, waker))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(second()).toBe(false)
})

it('waits out a longer minimum (the forge\'s own interval) before a wake ends the pause', async () => {
  const waker = new Waker()
  const done = settled(pause(120_000, new AbortController().signal, waker, 60_000))
  waker.wake()
  await vi.advanceTimersByTimeAsync(59_999)
  expect(done()).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(done()).toBe(true)
})

it('reports whether a Source instance has a polling loop to wake', () => {
  const registry = new SourceRegistry(() => SettingsSchema.parse({}))
  let woken = 0
  const release = registry.wakeable('gitea-sandbox', () => { woken += 1 })
  expect(registry.poll('gitea-sandbox')).toBe(true)
  expect(registry.poll('gitea')).toBe(false)
  release()
  expect(registry.poll('gitea-sandbox')).toBe(false)
  expect(woken).toBe(1)
})

it('accepts a Gitea polling interval of one day', () => {
  const base = { host: 'git.example.com', repository: 'acme/widgets', tokenFile: '/t', cli: 'tea' }
  expect(giteaKind.schema.safeParse({ ...base, pollSeconds: 86_400 }).success).toBe(true)
  expect(giteaKind.schema.safeParse({ ...base, pollSeconds: 86_401 }).success).toBe(false)
})

it('accepts a GitHub polling interval of one day', () => {
  const base = { repository: 'acme/widgets', cli: 'gh' }
  expect(githubKind.schema.safeParse({ ...base, pollSeconds: 86_400 }).success).toBe(true)
  expect(githubKind.schema.safeParse({ ...base, pollSeconds: 86_401 }).success).toBe(false)
})

it('says what ended a pause: a wake, its time, or the signal', async () => {
  const waker = new Waker()
  const woken = pause(86_400_000, new AbortController().signal, waker)
  waker.wake()
  await vi.advanceTimersByTimeAsync(WAKE_MIN_MS)
  expect(await woken).toBe('wake')
  const timed = pause(60_000, new AbortController().signal, waker)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await timed).toBe('timer')
  const controller = new AbortController()
  const aborted = pause(60_000, controller.signal, waker)
  controller.abort()
  expect(await aborted).toBe('abort')
  // A wake still pending when the time runs out is the wake the next round answers.
  waker.wake()
  const both = pause(1000, new AbortController().signal, waker, 60_000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await both).toBe('wake')
  expect(waker.take()).toBe(false)
})

const trigger = (id: string): Trigger => ({ id: `t-${id}`, source: 'gitea-x', threads: [{ source: 'gitea-x', id }],
  actor: { id: 'alice' }, human: true, at: '2026-11-17T00:00:00Z', text: 'secret words', meta: {} }) as unknown as Trigger

it('names the instance, its repository and the Threads in the missed-webhook line, never the text', () => {
  const line = missedWebhookLine('gitea-x', 'acme/widgets', 86_400, [trigger('12'), trigger('3'), trigger('12'), trigger('ci:main')])
  expect(line).toBe('dsh-superagent: webhook missed: gitea-x (acme/widgets) stored 4 new Triggers on #3, #12, ci:main'
    + ' in a poll round its 86400s interval started, with no wake')
  expect(line).not.toContain('secret')
  expect(missedWebhookLine('gitea-x', 'acme/widgets', 60, [trigger('7')])).toContain('stored 1 new Trigger on #7 ')
})

describe('the missed-webhook line', () => {
  const config = { repository: 'acme/widgets', pollSeconds: 60, failuresBeforeError: 3, webhook: true }
  let written: string[]
  beforeEach(() => {
    written = []
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true })
  })
  afterEach(() => { vi.restoreAllMocks() })
  /** Runs watchForge on a fake instance whose rounds store `plan`'s Triggers in turn (the last one when it runs out). */
  function watch(plan: (Trigger[] | Error)[], settings: Record<string, unknown> = config, instance = 'gitea-x', kind = 'gitea') {
    const waker = new Waker()
    const controller = new AbortController()
    let rounds = 0
    const ctx = { instance, ready: Promise.resolve(), configured: () => true, report: vi.fn(),
      deployment: { forges: { [instance]: { kind, repository: 'acme/widgets' } } },
      config: () => settings } as unknown as SourceContext
    const running = watchForge(ctx, controller.signal, kind, waker, async (_ctx, _signal, stored) => {
      const step = plan[Math.min(rounds, plan.length - 1)]!
      rounds += 1
      if (step instanceof Error) { stored.push(trigger('9')); throw step }
      stored.push(...step)
      return 0
    })
    return { waker, rounds: () => rounds, stop: async () => { controller.abort(); await running } }
  }

  it('is written by a round its interval started that stores something, and by no other', async () => {
    const w = watch([[trigger('1')], [trigger('2')], [trigger('3')], []])
    await vi.advanceTimersByTimeAsync(0)
    expect(w.rounds()).toBe(1)                     // the first round after a start: no line, whatever it finds
    expect(written).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)      // the interval ran out: the webhook missed #2
    expect(w.rounds()).toBe(2)
    expect(written).toEqual(['dsh-superagent: webhook missed: gitea-x (acme/widgets) stored 1 new Trigger on #2'
      + ' in a poll round its 60s interval started, with no wake\n'])
    w.waker.wake()                                 // a wake: what it finds is no miss
    await vi.advanceTimersByTimeAsync(WAKE_MIN_MS)
    expect(w.rounds()).toBe(3)
    await vi.advanceTimersByTimeAsync(60_000)      // the interval again, finding nothing
    expect(w.rounds()).toBe(4)
    expect(written).toHaveLength(1)
    await w.stop()
  })

  it('counts what a failed round stored before it failed', async () => {
    const w = watch([[], new Error('gitea: Bad Gateway')])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.rounds()).toBe(2)
    expect(written).toEqual([expect.stringContaining('webhook missed: gitea-x (acme/widgets) stored 1 new Trigger on #9')])
    await w.stop()
  })

  it('is written for a GitHub instance a webhook wakes, whose settings take the switch', async () => {
    const base = { repository: 'acme/widgets', cli: 'gh' }
    const parsed = githubKind.schema.parse({ ...base, pollSeconds: 86_400, webhook: true })
    expect(parsed.webhook).toBe(true)
    expect(githubKind.schema.parse(base).webhook).toBe(false)
    expect(githubKind.fields?.find(field => field.key === 'webhook')).toMatchObject({ type: 'switch', advanced: true })
    const w = watch([[], [trigger('3')]], parsed as unknown as Record<string, unknown>, 'github', 'github')
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(w.rounds()).toBe(2)
    expect(written).toEqual(['dsh-superagent: webhook missed: github (acme/widgets) stored 1 new Trigger on #3'
      + ' in a poll round its 86400s interval started, with no wake\n'])
    await w.stop()
  })

  it('is not written on an instance no webhook wakes', async () => {
    const w = watch([[trigger('1')]], { ...config, webhook: false })
    await vi.advanceTimersByTimeAsync(180_000)
    expect(w.rounds()).toBe(4)
    expect(written).toEqual([])
    await w.stop()
  })
})
