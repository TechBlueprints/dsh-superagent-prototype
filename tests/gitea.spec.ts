/** The Gitea Source against a stubbed Gitea API: paging, normalization, threads, CI, the 404 rule, the Channel, a poll round and setup. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { GITEA_PAGE, GiteaClient, giteaAddress } from '../src/sources/gitea-client.ts'
import { giteaKind } from '../src/sources/gitea.ts'
import { pollRound } from '../src/sources/forge-poll.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { resolveGitea, type ForgeAccount } from '../src/deployment.ts'
import { testDeployment, testForge, testMachine } from './fixtures/deployment.ts'

let dir: string
let account: ForgeAccount
const API = 'https://git.example.com/api/v1'
const REPO = `${API}/repos/home/app`
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitea-'))
  const tokenFile = join(dir, 'token')
  writeFileSync(tokenFile, 'secret-token\n', { mode: 0o600 })
  account = testForge({ id: 'gitea', kind: 'gitea', host: 'git.example.com', repository: 'home/app', web: 'https://git.example.com', api: API,
    cloneUrl: 'https://git.example.com/home/app.git', login: 'ziggy', commitEmail: 'ziggy@example.com', cli: '/opt/tea-agent', shim: 'tea',
    credential: { helper: 'token-file', path: tokenFile } })
})
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })

type Route = unknown | ((url: URL, init: RequestInit) => unknown)
/** Stubs `fetch` with `routes` by method and URL without its query (`GET repos/...`); a value may be a `Response`. Returns the requests. */
function gitea(routes: Record<string, Route>) {
  const requests: { method: string; url: string; body?: unknown; authorization?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    const headers = init.headers as Record<string, string>
    requests.push({ method, url: input, ...init.body ? { body: JSON.parse(String(init.body)) } : {}, authorization: headers.authorization })
    const route = routes[`${method} ${url.origin}${url.pathname}`]
    const value = typeof route === 'function' ? (route as (url: URL, init: RequestInit) => unknown)(url, init) : route
    if (value instanceof Response) return value
    if (value === undefined) return new Response(JSON.stringify({ message: 'The target couldn\'t be found.' }), { status: 404 })
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 })
  }))
  return requests
}
/** Answers one page of `items` for each `page` a request names, with Gitea's `Link` header while more pages follow. */
const paged = (items: unknown[]) => (url: URL) => {
  const page = Number(url.searchParams.get('page') ?? 1), limit = Number(url.searchParams.get('limit') ?? GITEA_PAGE)
  const more = page * limit < items.length
  return new Response(JSON.stringify(items.slice((page - 1) * limit, page * limit)), { status: 200,
    headers: { 'x-total-count': String(items.length), ...more ? { link: `<${url.origin}${url.pathname}?page=${page + 1}&limit=${limit}>; rel="next"` } : {} } })
}
const user = (login: string) => ({ id: login.length, login, email: '' })
const issue = (number: number, fields: Record<string, unknown> = {}) => ({ id: 900 + number, number, title: `Issue ${number}`, body: '', state: 'open',
  user: user('alice'), created_at: '2026-11-07T10:00:00+02:00', updated_at: '2026-11-07T10:00:00+02:00',
  html_url: `https://git.example.com/home/app/issues/${number}`, pull_request: null, ...fields })
const client = () => new GiteaClient(new Commands(() => testDeployment({ forges: { gitea: account } }), {}, new AbortController().signal), account)

describe('Gitea client', () => {
  it('reads every page of a list by limit and page, sorts it by update time, and refuses a list longer than it reads', async () => {
    const comments = Array.from({ length: 60 }, (_, index) => ({ id: index, body: `c${index}`, user: user('alice'),
      created_at: `2026-11-07T10:${String(59 - index).padStart(2, '0')}:00+02:00`, updated_at: `2026-11-07T10:${String(59 - index).padStart(2, '0')}:00+02:00`,
      html_url: `https://git.example.com/home/app/issues/3#issuecomment-${index}`, issue_url: '', pull_request_url: 'https://git.example.com/home/app/pulls/3' }))
    const requests = gitea({ [`GET ${REPO}/issues/comments`]: paged(comments) })
    const page = await client().stream('comments', '2026-11-07T00:00:00.000Z')
    expect(requests.map(request => new URL(request.url).searchParams.get('page'))).toEqual(['1', '2'])
    expect(requests[0]!.url).toContain(`limit=${GITEA_PAGE}`)
    expect(requests[0]!.authorization).toBe('token secret-token')
    const items = (page as { items: Record<string, unknown>[] }).items
    // Oldest first, in UTC, and a PR's conversation comment names its PR as its issue.
    expect(items.map(item => item.id)).toEqual(comments.map(comment => comment.id).reverse())
    expect(items[0]).toMatchObject({ updated_at: '2026-11-07T08:00:00.000Z', issue_url: 'https://git.example.com/home/app/pulls/3' })
    gitea({ [`GET ${REPO}/issues`]: paged(Array.from({ length: GITEA_PAGE * 21 }, (_, index) => issue(index + 1))) })
    await expect(client().stream('issues', '2026-11-07T00:00:00.000Z')).rejects.toThrow('nothing of it was taken in')
    // Gitea lists no inline comments across the repository.
    expect(await client().stream('review-comments', '2026-11-07T00:00:00.000Z')).toBeUndefined()
  })
  it('reads a notification\'s Issue address as the PR its type names, and nothing of other subjects', async () => {
    const at = (number: number, type: string) => ({ id: number, repository: { full_name: 'home/app' },
      subject: { url: `${REPO}/issues/${number}`, type, title: '' } })
    gitea({ [`GET ${REPO}/notifications`]: paged([at(3, 'Issue'), at(4, 'Pull'), at(5, 'Commit')]) })
    expect((await client().notifications('2026-11-07T00:00:00.000Z')).items).toEqual([{ repository: 'home/app', pr: false, number: 3 },
      { repository: 'home/app', pr: true, number: 4 }, { repository: 'home/app', pr: false }])
  })
  it('gives inline comments the thread root GitHub would, decisions GitHub\'s names, and leaves pending reviews out', async () => {
    const comment = (id: number, path: string, position: number, minute: number, original = 0) => ({ id, body: `inline ${id}`, user: user('carol'),
      path, position, original_position: original, diff_hunk: '@@ -1 +1 @@', created_at: `2026-11-07T10:0${minute}:00Z`, updated_at: `2026-11-07T10:0${minute}:00Z`,
      html_url: `https://git.example.com/home/app/pulls/7/files#issuecomment-${id}` })
    gitea({ [`GET ${REPO}/pulls/7/reviews`]: paged([{ id: 1, state: 'REQUEST_CHANGES', body: 'Fix it', user: user('carol'), submitted_at: '2026-11-07T10:00:00Z' },
      { id: 2, state: 'COMMENT', body: '', user: user('dave'), submitted_at: '2026-11-07T10:05:00Z' }, { id: 3, state: 'PENDING', body: '', user: user('dave') }]),
    [`GET ${REPO}/pulls/7/reviews/1/comments`]: [comment(11, 'a.ts', 4, 1), comment(12, 'b.ts', 0, 2, 4)],
    [`GET ${REPO}/pulls/7/reviews/2/comments`]: [comment(21, 'a.ts', 4, 6), comment(22, 'b.ts', 4, 7)] })
    const inline = await client().comments(7, 'inline')
    expect(inline.map(item => [item.id, item.line, item.original_line, item.in_reply_to_id])).toEqual([[11, 4, null, undefined],
      [12, null, 4, undefined], [21, 4, null, 11], [22, 4, null, undefined]])
    expect((await client().reviewThread(7, 21)).map(item => item.id)).toEqual([11, 21])
    expect((await client().comments(7, 'review')).map(item => [item.id, item.state])).toEqual([[1, 'CHANGES_REQUESTED'], [2, 'COMMENTED']])
    expect(await client().reviewComment(7, 21)).toEqual({ id: 21, in_reply_to_id: 11 })
    expect(giteaAddress('https://git.example.com/home/app/pulls/7/files#issuecomment-21', 'home/app', account)).toEqual({ number: 7, pr: true, discussion: 21 })
    expect(giteaAddress('https://git.example.com/home/app/pulls/7#issuecomment-21', 'home/app', account)).toEqual({ number: 7, pr: true })
    expect(giteaAddress('https://git.example.com/other/app/issues/7', 'home/app', account)).toBeUndefined()
  })
  it('reads a commit\'s CI from its statuses, the latest per context, and a deleted Issue as gone while its repository reads', async () => {
    gitea({ [`GET ${REPO}/commits/abc/statuses`]: paged([{ id: 1, context: 'build', status: 'failure' }, { id: 3, context: 'build', status: 'success' },
      { id: 2, context: 'lint', status: 'warning' }]), [`GET ${REPO}`]: { full_name: 'home/app', default_branch: 'main' } })
    expect(await client().checks('abc')).toEqual({ head: 'abc', checks: [], statuses: [{ context: 'build', state: 'success' }, { context: 'lint', state: 'warning' }] })
    await expect(client().issue(9)).rejects.toMatchObject({ code: 410 })
    gitea({})
    await expect(client().issue(9)).rejects.toMatchObject({ code: 404 })
  })
  it('replies in a review thread at its root and on the conversation otherwise, once per message', async () => {
    const replies = [] as unknown[]
    const requests = gitea({ [`GET ${REPO}/pulls/7/reviews`]: paged([{ id: 1, state: 'COMMENT', user: user('carol') }]),
      [`GET ${REPO}/pulls/7/reviews/1/comments`]: [{ id: 11, path: 'a.ts', position: 4, body: 'why?', user: user('carol'), created_at: '2026-11-07T10:00:00Z' }],
      [`POST ${REPO}/pulls/7/comments/11/replies`]: (_url: URL, init: RequestInit) => { replies.push(JSON.parse(String(init.body))); return { id: 30 } },
      [`GET ${REPO}/issues/7/comments`]: [{ id: 5, body: 'done\n\n<!-- dsh-superagent:m2 -->', user: user('ziggy') }] })
    const commands = new Commands(() => testDeployment({ forges: { gitea: account } }), {}, new AbortController().signal)
    const send = (id: string, url?: string) => giteaKind.channel!.send({ commands, instance: 'gitea' },
      { id, kind: 'reply', text: 'Fixed', channel: { source: 'gitea', thread: 'gitea:7', address: { number: '7', ...url ? { url } : {} } } })
    expect(await send('m1', 'https://git.example.com/home/app/pulls/7/files#issuecomment-11')).toBe('sent')
    expect(replies).toEqual([{ body: 'Fixed\n\n<!-- dsh-superagent:m1 -->' }])
    // The conversation already holds the reply with this marker, so nothing is posted again.
    expect(await send('m2')).toBe('sent')
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(giteaKind.channel!.link({ number: '7' }, { forges: { gitea: account } }, 'gitea'))
      .toEqual({ url: 'https://git.example.com/home/app/issues/7', label: { zh: 'Gitea #7', en: 'Gitea #7' } })
  })
})

it('polls a Gitea instance into its own Threads, Triggers and records, with a mention from an allowed sender as explicit', async () => {
  const store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { sources: { gitea: { allowed: [{ id: 'alice' }] } } },
    sources: { gitea: { enabled: true, config: { host: 'git.example.com', repository: 'home/app', tokenFile: join(dir, 'token'), cli: '/opt/tea-agent' } } } }))
  const sources = new SourceRegistry(() => store.settings(), new HealthBoard())
  sources.register(giteaKind)
  const deployment = testDeployment({ forges: { gitea: account } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn(async () => {}) }, executor: { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const ctx = sourceContextOf({ store, engine, outbox: { send: () => {} }, commands, sources, deployment, ready: Promise.resolve(),
    configured: () => true, receive }, giteaKind, 'gitea')
  const mention = issue(3, { body: '@ziggy please fix the login', created_at: '2026-11-07T12:00:00+02:00', updated_at: '2026-11-07T12:00:00+02:00' })
  gitea({ [`GET ${REPO}/notifications`]: paged([{ id: 1, repository: { full_name: 'home/app' }, subject: { url: `${REPO}/issues/3`, type: 'Issue' } }]),
    [`GET ${REPO}/issues/3`]: mention, [`GET ${REPO}/issues/3/comments`]: [] })
  store.set(KV.forge('gitea').since, '2026-11-07T09:00:00.000Z')
  expect(await pollRound(ctx)).toBe(0)
  const id = key('gitea-issue', '3')
  expect(receive.mock.calls.map(([trigger]) => trigger)).toEqual([expect.objectContaining({ id, source: 'gitea', threads: [{ source: 'gitea', id: '3' }],
    actor: { source: 'gitea', id: 'alice' }, human: true, at: '2026-11-07T10:00:00.000Z', addressed: 'mention',
    channel: { source: 'gitea', thread: 'gitea:3', address: { number: '3', url: mention.html_url } } })])
  expect(engine.candidate(id)?.strength).toBe('explicit')
  expect(store.threads.get('gitea:3')?.meta).toMatchObject({ title: 'Issue 3', label: '#3 Issue 3' })
  expect(store.get(KV.forge('gitea').cursor(3))).toBeDefined()
  // Gitea asks for no interval, so the round says the configured one.
  expect(sources.healthEntries(['gitea']).get('gitea')?.get()).toMatchObject({ state: 'ready', detail: '1 notifications; next poll ≥ 60s' })
  store.close()
})

it('resolves a Gitea account from its token file and tea\'s login, and names what setup still needs', async () => {
  const tea = join(dir, 'tea-agent')
  writeFileSync(tea, '#!/bin/sh\n'); chmodSync(tea, 0o755)
  const config = { host: 'git.example.com', repository: 'home/app', tokenFile: join(dir, 'token'), cli: tea }
  const logins = (user: string) => async () => JSON.stringify([{ name: 'agent', url: 'https://git.example.com', user, default: true }])
  const http = vi.fn(async (url: string) => url.endsWith('/user') ? { ok: true, status: 200, json: async () => ({ id: 4, login: 'ziggy', email: 'ziggy@example.com' }) }
    : { ok: true, status: 200, json: async () => ({ full_name: 'Home/App', permissions: { push: true } }) })
  expect(await resolveGitea(testMachine({ stateDir: dir }), config, logins('ziggy'), dir, 'gitea', http)).toEqual({ id: 'gitea', kind: 'gitea',
    host: 'git.example.com', repository: 'Home/App', web: 'https://git.example.com', api: API, cloneUrl: 'https://git.example.com/Home/App.git',
    login: 'ziggy', commitEmail: 'ziggy@example.com', cli: tea, shim: 'tea', credential: { helper: 'token-file', path: join(dir, 'token') } })
  expect(http.mock.calls[0]).toEqual([`${API}/user`, expect.objectContaining({ headers: expect.objectContaining({ authorization: 'token secret-token' }) })])
  const needs = (code: string, values: Record<string, unknown>, overrides: Record<string, unknown>, probe = logins('ziggy')) =>
    expect(resolveGitea(testMachine({ stateDir: dir }), { ...config, ...overrides }, probe, dir, 'gitea-home', http)).rejects
      .toMatchObject({ place: 'gitea-home', code, values: expect.objectContaining({ forge: 'Gitea', ...values }) })
  await needs('hostUnset', {}, { host: '' })
  await needs('tokenFileUnset', {}, { tokenFile: '' })
  chmodSync(join(dir, 'token'), 0o644)
  await needs('tokenFileUnreadable', { file: join(dir, 'token') }, {})
  chmodSync(join(dir, 'token'), 0o600)
  await needs('cliAccountDiffers', { login: 'clint', account: 'ziggy' }, {}, logins('clint'))
  http.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as never)
  await needs('tokenRejected', { host: 'git.example.com' }, {})
})
