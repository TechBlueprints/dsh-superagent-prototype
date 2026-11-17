import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pause, Waker, WAKE_MIN_MS } from '../src/sources/poll.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { giteaKind } from '../src/sources/gitea.ts'
import { githubKind } from '../src/sources/github.ts'
import { SettingsSchema } from '../src/policy.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const settled = (promise: Promise<void>) => { let done = false; void promise.then(() => { done = true }); return () => done }

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
