/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { afterEach, expect, it, vi } from 'vitest'
import { UserError } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const members = deferred<unknown>()
  vi.mocked(Commands.prototype.lark).mockImplementationOnce(() => members.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ rules, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // The syncs the Runtime runs as it starts finish first.
  await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})
it('adds a further Source instance only of a kind that admits several, from the panel, and removes only further instances', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // Feishu admits one instance; a further one, an id of another kind, or one from a tool is refused before anything is saved.
  await expect(settings.save('source:feishu-two', { enabled: true, kind: 'feishu', config: {} }, 0, 'panel'))
    .rejects.toMatchObject({ code: 'sourceIdRefused' })
  await expect(settings.save('source:other', { enabled: true, kind: 'missing', config: {} }, 0, 'panel'))
    .rejects.toMatchObject({ code: 'sourceNotInstalled' })
  await expect(settings.remove('github', 0)).rejects.toMatchObject({ code: 'sourceNotRemovable' })
  await expect(settings.remove('github-gone', 0)).rejects.toMatchObject({ code: 'sourceNotRemovable' })
  expect(h.runtime.store.settings().sources['feishu-two']).toBeUndefined()
  const response = await h.api('DELETE', 'settings/source:github', { revision: 0 })
  expect(response).toMatchObject({ status: 400, body: { code: 'sourceNotRemovable' } })
})
it('takes an operator request as the message of the person it names: explicit from a listed account, on the Issue it names', async () => {
  h = await startRuntime()
  const issue = { id: 1012, number: 12, title: 'Login fails', body: '', state: 'open', created_at: '2026-09-09T00:00:00Z',
    html_url: 'https://github.com/acme/widgets/issues/12', user: { login: 'carol', type: 'User' } }
  vi.mocked(Commands.prototype.gh).mockImplementation(async args => args[1] === 'repos/acme/widgets/issues/12' ? issue : {})
  const asked = await h.api('POST', 'triggers', { source: 'github', number: 12, text: 'Please fix the login', requested_by: 'alice', request_id: 'chat-1' })
  expect(asked).toMatchObject({ status: 200, body: { thread: 'github:12', received: 'stored', sender: { source: 'github', id: 'alice', listed: true } } })
  const trigger = h.runtime.store.triggers.get(asked.body.trigger_id as string)!
  expect(trigger).toMatchObject({ source: 'github', actor: { source: 'github', id: 'alice' }, human: true, addressed: 'direct',
    channel: { source: 'github', thread: 'github:12', address: { number: '12', url: issue.html_url } }, meta: { number: 12, isPr: false, kind: 'operator', requestedBy: 'alice' } })
  await h.runtime.idle()
  expect(h.candidates()).toContain(trigger.id)
  // The router's card names the sender, whether the Source lists them, and the candidate's strength.
  expect(h.relays(h.runtime.masterId).find(item => item.trigger_id === trigger.id))
    .toMatchObject({ kind: 'candidate', strength: 'explicit', sender: { source: 'github', id: 'alice', listed: true, human: true } })
  // The same request id is the same Trigger; a request without an Issue starts a Thread of its own; a sender off the list is not explicit.
  expect((await h.api('POST', 'triggers', { source: 'github', number: 12, text: 'Please fix the login', requested_by: 'alice', request_id: 'chat-1' })).body)
    .toMatchObject({ trigger_id: trigger.id, received: 'duplicate' })
  const loose = await h.api('POST', 'triggers', { source: 'github', text: 'Look at the flaky test', requested_by: 'mallory' })
  expect(loose.body).toMatchObject({ thread: expect.stringMatching(/^github:operator:/), sender: { listed: false } })
  await h.runtime.idle()
  expect(h.candidates()).not.toContain(loose.body.trigger_id)
  expect(await h.api('POST', 'triggers', { source: 'feishu', text: 'x', requested_by: 'alice' }))
    .toMatchObject({ status: 400, body: { error: 'feishu is no forge Source that is on and set up' } })
})
