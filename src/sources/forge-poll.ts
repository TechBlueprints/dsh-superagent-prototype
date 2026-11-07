/** The forge Source's polling: notifications, repository streams, the PRs of open tickets with their CI, and subscribed Threads, for one instance. */
import { z } from 'zod'
import { key, type Thread } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { forgeStatus, type ForgeClient, type StreamId } from './forge-client.ts'
import { forgeClient } from './forge.ts'
import { ciCounts, ciFact, ciFailures, ciSummary } from './forge-read.ts'
import { branchCiTrigger, ciTrigger, commentTrigger, CommentSchema, issueTrigger, IssueSchema, pullTrigger, type Origin, type PullRef }
  from './forge-trigger.ts'
import { observePull, pullsOf, readPull, type Pull } from './forge-pull.ts'
import { health, type Health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import type { ForgeConfig } from './forge.ts'

/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
/** The client of the context's instance, whose account setup resolved, also stopping with `signal`. */
const client = (ctx: SourceContext, signal?: AbortSignal): ForgeClient => forgeClient(ctx.commands, ctx.instance).withSignal(signal)
/** The health entry the forge kind of the context's instance declares: its kind's id. */
const entry = (ctx: SourceContext): string => ctx.deployment.forges[ctx.instance]?.kind ?? ctx.instance
const configOf = (ctx: SourceContext) => ctx.config<ForgeConfig>(ctx.instance)
/**
 * Polls one forge instance until `signal` aborts, at the interval its configuration and its forge ask for.
 * @param name - the health entry its kind declares (the kind's id), which reports this instance's entry.
 */
export async function watchForge(ctx: SourceContext, signal: AbortSignal, name: string): Promise<void> {
  let interval = 0
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report(name, health('paused', 'setupPending')); return }
  // An instance setup left out waits for its fix, which a check or a save restarts dsh-superagent for.
  if (!ctx.deployment.forges[ctx.instance]) {
    const problem = ctx.problem
    ctx.report(name, problem ? { state: 'paused', detail: problem.detail } : health('paused', 'setupPending'))
    return
  }
  while (!signal.aborted) {
    const config = configOf(ctx)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report(name, health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report(name, failed)
    }
    await pause(Math.max(interval, configOf(ctx)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined
  pulls: Map<number, Promise<Pull>>; read: Set<number>; failures: string[]; dropped: number[]; abandoned: number[]
  tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, pulls: new Map(), read: new Set(),
  failures: [], dropped: [], abandoned: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !configOf(ctx)
export interface Retry { since: string; pr: boolean; failedAt?: string; attempts?: number }
const RETRY_WINDOW_MS = 24 * 3600_000
/** True when the forge answers HTTP 410 (Gone); HTTP 404 is retried because it can indicate revoked access to a private repository. */
const deleted = (error: unknown): boolean => forgeStatus(error) === 410
/** The Origin of the context's instance, which its Triggers carry. */
const originOf = (ctx: SourceContext): Origin => ({ source: ctx.instance, kind: entry(ctx) })
const keys = (ctx: SourceContext) => KV.forge(ctx.instance)
const threadKey = (ctx: SourceContext, number: number | string) => `${ctx.instance}:${number}`
/** Records a failed read on the Thread and in the round; deleted (410) or abandoned (24h+) threads do not fail the round. */
function failed(ctx: SourceContext, round: Round, number: number, error: unknown, abandoned = false): void {
  if (deleted(error)) round.dropped.push(number)
  else if (abandoned) round.abandoned.push(number)
  else round.failures.push(`#${number}: ${String(error)}`)
  ctx.threads.patch(threadKey(ctx, number), { pollError: String(error) })
}
const ListedSchema = CommentSchema.extend({ issue_url: z.string().nullish(), pull_request_url: z.string().nullish() })
/** Repository-wide event streams; `issues` includes PRs, and `comments` covers Issue and PR conversation comments (excluding inline review comments). */
const STREAMS = [
  { id: 'issues', observed: (config: ForgeConfig) => config.observeIssues || config.observePulls },
  { id: 'comments', observed: (config: ForgeConfig) => config.observeComments },
  { id: 'review-comments', observed: (config: ForgeConfig) => config.observeComments },
] as const satisfies readonly { id: StreamId; observed(config: ForgeConfig): boolean }[]
/** Polls repository-wide streams (new Issues/PRs, comments, default-branch CI); each stream reads from when it was switched on, resets when switched off, and fails independently. */
async function pollRepository(ctx: SourceContext, round: Round): Promise<void> {
  const config = configOf(ctx)
  if (!config) return
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    if (!stream.observed(config)) { ctx.state.set(keys(ctx).stream(stream.id), undefined); continue }
    try { await readStream(ctx, round, stream.id, config) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream.id}: ${String(error)}`) }
  }
  // When CI observation is turned off, clear the failure baseline but preserve the revision counter so future triggers have unique IDs.
  if (!config.observeCi) {
    const seen = ctx.state.get(keys(ctx).branchCi)
    ctx.state.set(keys(ctx).branchCi, seen && { revision: seen.revision })
    return
  }
  try { await pollBranchCi(ctx, round) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`default branch CI: ${String(error)}`) }
}
/**
 * Polls one repository-wide event stream (oldest first) since its cursor and steps the cursor to five seconds before the
 * newest item (`cursorAt`), relying on Trigger ID deduplication so repeated messages are no-ops. While the cursor stays
 * unchanged (including when clamped to the hourly horizon), sending the last page's ETag lets a forge that supports it answer
 * an unchanged list at no cost. Items from before their kind was switched on or beyond the horizon are ignored; a forge without
 * the stream reads nothing for it.
 */
async function readStream(ctx: SourceContext, round: Round, id: StreamId, config: ForgeConfig): Promise<void> {
  const name = keys(ctx).stream(id)
  const stored = ctx.state.get(name)
  const kinds = id === 'issues' ? [...config.observeIssues ? ['issues'] : [], ...config.observePulls ? ['pulls'] : []] : ['comments']
  const before = typeof stored?.started === 'object' ? stored.started : {}
  const started: Record<string, string> = Object.fromEntries(kinds.map(kind => [kind, before[kind] ?? round.started]))
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), horizon)).toISOString()
  const forge = client(ctx, round.signal)
  const page = await forge.stream(id, since, stored?.etag && stored.since === since ? stored.etag : undefined)
  if (page === 'unchanged') return
  if (page === undefined) { ctx.state.set(name, { since, started }); return }
  const items = validItems(ListedSchema, page.items, round.tally)
  const { login } = forge.account
  const origin = originOf(ctx), human = forge.conventions.isHuman
  const fresh = (at: string | null | undefined, kind: string) =>
    kind in started && Date.parse(at ?? '') >= Math.max(Date.parse(started[kind]!), horizon)
  for (const item of items) {
    // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
    if (stopped(ctx, round)) throw new Error(`The ${forge.conventions.product} Source stopped during the poll`)
    if (sameName(item.user.login, login)) continue
    if (id === 'issues') {
      const issue = IssueSchema.safeParse(item)
      const pr = issue.success && !!issue.data.pull_request
      if (!issue.success || !fresh(issue.data.created_at, pr ? 'pulls' : 'issues')) continue
      await ctx.receive(pr ? pullTrigger(issue.data, login, origin, human) : issueTrigger(issue.data, login, origin, human))
      nameThread(ctx, issue.data.number, issue.data.title)
      continue
    }
    const number = Number(/\/(?:issues|pulls)\/(\d+)$/.exec((id === 'comments' ? item.issue_url : item.pull_request_url) ?? '')?.[1])
    if (!number || !fresh(item.updated_at ?? item.created_at, 'comments')) continue
    const isPr = id === 'review-comments' || /\/pulls?\//.test(item.html_url ?? '')
    const ref = { number, isPr, ...item.html_url ? { url: item.html_url } : {} }
    const trigger = commentTrigger(item, ref, id === 'comments' ? 'conversation' : 'inline', login, origin, human)
    if (trigger.text) await ctx.receive(trigger)
  }
  const newest = Math.max(...items.map(item => Date.parse(item.updated_at ?? '')).filter(Number.isFinite))
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  const next = Date.parse(moved) > Date.parse(since) ? moved : since
  // The ETag belongs to this request, which the next round repeats only while the cursor stays unchanged.
  ctx.state.set(name, { since: next, started, ...page.etag && next === since ? { etag: page.etag } : {} })
}
/** Polls default-branch CI checks, emitting a trigger only when the set of failing checks changes after the initial baseline. */
async function pollBranchCi(ctx: SourceContext, round: Round): Promise<void> {
  const forge = client(ctx, round.signal)
  const branch = await forge.defaultBranch()
  const head = await forge.commitSha(branch)
  const snapshot = await forge.checks(head, round.tally)
  const previous = ctx.state.get(keys(ctx).branchCi)
  // The first observation after switching on or renaming the default branch establishes the baseline.
  const known = previous?.branch === branch ? previous.failures : undefined
  const failures = ciFailures(snapshot)
  const counts = ciCounts(snapshot)
  // Retain previous failures while checks are still running so recovery is reported only once all checks pass.
  const now = failures.length || !counts.running ? failures : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    const summary = ciSummary(snapshot, branch, `${ctx.instance}/commits/${head}/checks`)
    const url = forge.conventions.commitPage(forge.account.repository, head)
    await ctx.receive(branchCiTrigger(branch, head, revision, summary, url, originOf(ctx)))
    ctx.threads.describe(threadKey(ctx, `ci:${branch}`), { label: `CI on ${branch}`, facts: { ci: ciFact(counts) } })
  }
  ctx.state.set(keys(ctx).branchCi, { branch, failures: now, revision })
}
/**
 * One polling round: notifications, then observed repository streams, then the PRs of open tickets with their CI, then
 * subscribed Threads. Each step and each Issue, PR, or Thread fails independently so all steps run before the round fails.
 * Other read failures (including 404) fail the round toward the error threshold, whereas deleted (410) or abandoned
 * (24h+) threads are recorded only on the thread and in health detail.
 * @returns the polling interval the forge asked for, in seconds (0 when it asks for none).
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const notified = await pollNotifications(ctx, round).then(value => ({ value }), (error: unknown) => ({ error }))
  await pollRepository(ctx, round)
  await pollTicketPulls(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if ('error' in notified) throw notified.error
  const { count, interval } = notified.value
  if (signal?.aborted) return interval
  const product = client(ctx).conventions.product
  if (round.failures.length) throw new Error(`${round.failures.length} ${product} reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const named = (numbers: number[]) => [...new Set(numbers)].sort((a, b) => a - b).map(number => `#${number}`).join(', ')
  const dropped = (round.dropped.length ? `; deleted on ${product}: ${named(round.dropped)}` : '')
    + (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  // A forge that asks for no interval polls at the configured one.
  const next = interval || (configOf(ctx)?.pollSeconds ?? 0)
  ctx.report(entry(ctx), { state: 'ready', detail: `${count} notifications; next poll ≥ ${next}s${dropped}`, at: round.started })
  return interval
}
/** Reads notifications since the cursor and each Issue or PR they name, advancing the cursor atomically with the retry map for failed reads; deleted (410) Issues are dropped once their error is recorded. */
async function pollNotifications(ctx: SourceContext, round: Round): Promise<{ count: number; interval: number }> {
  const { state } = ctx
  const { since: cursor, retries: retryKey } = keys(ctx)
  const forge = client(ctx, round.signal)
  const since = state.get(cursor) ?? round.started
  if (state.get(cursor) === undefined) state.set(cursor, since)
  const { repository } = forge.account
  const listed = await forge.notifications(since, round.tally)
  const notifications = listed.items
  const interval = listed.interval ?? 0
  const retries = { ...state.get(retryKey) }
  // Failed items from the previous round run first, followed by newly notified items in chronological order; each is read once.
  const items = new Map(Object.entries(retries).map(([number, retry]) => [Number(number), retry]))
  for (const notification of [...notifications].reverse()) {
    if (!sameName(notification.repository, repository)) continue
    const { number, pr } = notification
    if (number === undefined || notification.discussion || items.has(number)) continue
    items.set(number, { since: [state.get(keys(ctx).cursor(number)) ?? since, since].sort().at(-1)!, pr })
  }
  for (const [number, item] of items) {
    if (stopped(ctx, round)) return { count: notifications.length, interval }
    round.read.add(number)
    try {
      await readNotified(ctx, round, number, item)
      delete retries[number]
    } catch (error) {
      if (stopped(ctx, round)) return { count: notifications.length, interval }
      const retry = { ...item, failedAt: item.failedAt ?? round.started, attempts: (item.attempts ?? 0) + 1 }
      // Abandon notification retries after 24 hours of failures so a permanently unreadable thread does not hold source health in error; its cursor stays so a later notification or thread poll still reads what was missed.
      const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
      failed(ctx, round, number, error, abandoned)
      if (!deleted(error) && !abandoned) { retries[number] = retry; continue }
      delete retries[number]
    }
  }
  ctx.atomic(() => { state.set(cursor, cursorAt(round.started)); state.set(retryKey, retries) })
  return { count: notifications.length, interval }
}
async function readNotified(ctx: SourceContext, round: Round, number: number, item: Retry): Promise<void> {
  const { since } = item
  const forge = client(ctx, round.signal)
  const origin = originOf(ctx), human = forge.conventions.isHuman
  const { login } = forge.account
  let isPr = item.pr
  if (!isPr) {
    const issue = await forge.issue(number)
    // `issues/<n>` also returns PRs with `pull_request` set; handle them in the PR branch below.
    isPr = !!issue.pull_request
    if (!isPr) {
      // An Issue opened by someone other than the agent since the cursor brings its body so a mention in it reaches the gate.
      // A mention added by a later edit to the body is not read: only the author can be the actor of the body.
      const opened = Date.parse(issue.created_at) >= Date.parse(since) && !sameName(issue.user.login, login)
      if (opened) await ctx.receive(issueTrigger(issue, login, origin, human))
      await intakeComments(ctx, { number, isPr: false, url: issue.html_url }, since, round)
      nameThread(ctx, number, issue.title)
    }
  }
  if (isPr) {
    const pr = await pull(ctx, round, number)
    // Emit a PR description trigger for PRs opened since the cursor; its ID is the same as the one produced by the repository PR stream.
    if (pr.created_at && Date.parse(pr.created_at) >= Date.parse(since) && !sameName(pr.user.login, login)) {
      const opened = { number, title: pr.title ?? '', body: pr.body, user: pr.user, created_at: pr.created_at, html_url: pr.html_url }
      await ctx.receive(pullTrigger(opened, login, origin, human))
    }
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since, round)
    if (pr.title) nameThread(ctx, number, pr.title)
  }
  ctx.state.set(keys(ctx).cursor(number), cursorAt(round.started))
  ctx.threads.patch(threadKey(ctx, number), { pollError: undefined })
}
/** Reads and observes a PR at most once per polling round. */
function pull(ctx: SourceContext, round: Round, number: number): Promise<Pull> {
  let read = round.pulls.get(number)
  if (!read) {
    read = readPull(ctx, number, round.signal).then(async pr => { await observePull(ctx, pr); return pr })
    round.pulls.set(number, read)
  }
  return read
}
async function intakeComments(ctx: SourceContext, ref: PullRef, since: string, round: Round): Promise<void> {
  const forge = client(ctx, round.signal)
  const { login } = forge.account
  const origin = originOf(ctx), human = forge.conventions.isHuman
  const kinds = ref.isPr ? ['conversation', 'inline', 'review'] as const : ['conversation'] as const
  for (const kind of kinds) {
    const comments = await forge.comments(ref.number, kind, since, round.tally)
    for (const comment of comments) {
      // Stopping mid-read throws so the thread's cursor stays where it was.
      if (stopped(ctx, round)) throw new Error(`The ${forge.conventions.product} Source stopped during the poll`)
      const timestamp = Date.parse(comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? '')
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
      if (sameName(comment.user.login, login)) continue
      // A review decision without a body still reaches the ticket: a worker may be waiting for that approval.
      const trigger = commentTrigger(comment, ref, kind, login, origin, human)
      if (trigger.text) await ctx.receive(trigger)
    }
  }
}
export async function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const numbers = [...new Set(ctx.tickets.open().flatMap(ticket => pullsOf(ticket, true, ctx.instance)))]
  for (const number of numbers) {
    if (stopped(ctx, round)) return
    try {
      const pr = await pull(ctx, round, number)
      if (pr.state !== 'closed' && !pr.merged) await pollChecks(ctx, round, number, pr)
    } catch (error) { if (!stopped(ctx, round)) failed(ctx, round, number, error) }
  }
}
/** Polls a PR's CI checks; only changes after the first baseline observation become Triggers. */
async function pollChecks(ctx: SourceContext, round: Round, number: number, pr: Pull): Promise<void> {
  const snapshot = await client(ctx, round.signal).checks(pr.head.sha, round.tally)
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(keys(ctx).ci(number))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) await ctx.receive(ciTrigger(pr, revision, ciSummary(snapshot, `PR #${number}`, `${ctx.instance}/pulls/${number}/checks`), originOf(ctx)))
  ctx.state.set(keys(ctx).ci(number), { fingerprint, revision })
  ctx.threads.describe(threadKey(ctx, number), { facts: { ci: ciFact(ciCounts(snapshot)) } })
}
function nameThread(ctx: SourceContext, number: number, title: string): void {
  ctx.threads.patch(threadKey(ctx, number), { title })
  ctx.threads.describe(threadKey(ctx, number), { label: `#${number} ${title}`, facts: { number: { value: `#${number}` } } })
}
/** Polls subscribed Issue and PR Threads not already read in this round; a deleted (410) Issue is still polled within the horizon (costing one read) and does not fail the round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, ctx.instance, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (deleted(error)) round.dropped.push(Number(thread.ref.id)); else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(Number(thread.ref.id)))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // The default branch's CI Thread has no Issue or PR to read; its CI arrives as Triggers.
  if (thread.ref.id.startsWith('ci:')) return
  const number = Number(thread.ref.id)
  const forge = client(ctx, round.signal)
  if (!number) throw new Error(`Subscribed thread has no ${forge.conventions.product} issue or PR number`)
  round.read.add(number)
  if (typeof thread.meta.isPr !== 'boolean' || typeof thread.meta.title !== 'string') {
    const issue = await forge.issue(number)
    ctx.threads.patch(thread.key, { number, isPr: !!issue.pull_request, url: issue.html_url })
    if (issue.title) nameThread(ctx, number, issue.title)
    thread = ctx.threads.get(thread.key) ?? thread
  }
  const checkpoint = keys(ctx).cursor(number)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  if (thread.meta.isPr === true) {
    const pr = await pull(ctx, round, number)
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since, round)
  } else await intakeComments(ctx, { number, isPr: false }, since, round)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
