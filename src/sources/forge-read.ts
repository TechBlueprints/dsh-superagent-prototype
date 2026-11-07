/** Read-only forge repository, conversation, and CI check inspection for assessments and workers, through each instance's forge client. */
import { z } from 'zod'
import type { ThreadFact } from '../core/index.ts'
import { validItems } from '../infra/commands.ts'
import type { CiSnapshot, ForgeClient } from './forge-client.ts'
import { forgeClient, humanOf } from './forge.ts'
import { CommentSchema, IssueSchema, reviewPlace, type ForgeComment } from './forge-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

export type { CiSnapshot } from './forge-client.ts'
/** Check conclusions and status states that count as failures; `success`, `neutral`, `skipped`, `stale` and Gitea's `warning` do not. */
const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'])
export function ciCounts(snapshot: CiSnapshot): { failed: number; running: number } {
  const statuses = snapshot.statuses ?? []
  return {
    failed: snapshot.checks.filter(check => FAILING.has(check.conclusion ?? '')).length + statuses.filter(status => FAILING.has(status.state)).length,
    running: snapshot.checks.filter(check => check.status !== 'completed').length + statuses.filter(status => status.state === 'pending').length,
  }
}
export function ciSummary(snapshot: CiSnapshot, where: string, read: string): string {
  const checks = snapshot.checks.map(check => ({ name: check.name, failed: FAILING.has(check.conclusion ?? ''), running: check.status !== 'completed' }))
  const statuses = (snapshot.statuses ?? []).map(status => ({ name: status.context, failed: FAILING.has(status.state), running: status.state === 'pending' }))
  const results = [...checks, ...statuses]
  const failed = results.filter(result => result.failed).map(result => result.name)
  const running = results.filter(result => result.running).map(result => result.name)
  const names = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  const at = `on ${where} at ${snapshot.head.slice(0, 7)}`
  const still = running.length ? `; ${running.length} still running` : ''
  const line = failed.length ? `CI failed ${failed.length}/${results.length} ${at}: ${names(failed)}${still}`
    : running.length ? `CI running ${running.length}/${results.length} ${at}: ${names(running)}`
      : `CI passed ${results.length}/${results.length} ${at}`
  return `${line}\nRead ${read} for every check.`
}
export function ciFailures(snapshot: CiSnapshot): string[] {
  return [...snapshot.checks.filter(check => FAILING.has(check.conclusion ?? '')).map(check => check.name),
    ...(snapshot.statuses ?? []).filter(status => FAILING.has(status.state)).map(status => status.context)].sort()
}
export function ciFact(counts: { failed: number; running: number }): ThreadFact {
  if (counts.failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
  if (counts.running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}

/** Reads a non-hidden file or directory listing from the repository's default branch; hidden entries and `node_modules` are rejected. */
export async function readRepositoryPath(client: ForgeClient, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  return client.contents(parts.join('/'), kind)
}
/** Reads check runs and commit statuses for a commit without emitting a trigger. */
export const pullChecks = (client: ForgeClient, head: string, tally?: { skipped: number }): Promise<CiSnapshot> => client.checks(head, tally)

/** Formats a forge comment, review, or issue as a model-facing ContextMessage, marking bots and apps because bot messages never authorize work. */
function forgeMessage(client: ForgeClient, item: ForgeComment, text: string, id: string, config?: Record<string, unknown>): ContextMessage {
  const line = item.line ?? item.original_line
  return { id, from: item.user.login, at: item.created_at ?? item.submitted_at ?? '', text,
    ...!humanOf(client.conventions, config)(item.user) ? { bot: true } : {}, ...item.html_url ? { url: item.html_url } : {},
    ...item.path ? { path: item.path, ...line != null ? { line } : {} } : {} }
}
const reviewText = (review: ForgeComment): string =>
  [review.state && review.state !== 'COMMENTED' ? review.state : '', review.body ?? ''].filter(Boolean).join('\n\n')
const DescriptionSchema = IssueSchema.extend({
  labels: z.array(z.looseObject({ name: z.string() })).nullish(), draft: z.boolean().nullish(), merged: z.boolean().nullish(),
  head: z.looseObject({ ref: z.string() }).nullish(), base: z.looseObject({ ref: z.string() }).nullish(),
})
function threadMessages(client: ForgeClient, thread: ForgeComment[], id: (comment: ForgeComment) => string, config?: Record<string, unknown>): ContextMessage[] {
  const [first] = thread
  return thread.map(item => item === first
    ? forgeMessage(client, item, [reviewPlace(item), item.body ?? ''].filter(Boolean).join('\n\n'), id(item), config)
    : { ...forgeMessage(client, item, item.body ?? '', id(item), config), ...first ? { reply_to: id(first) } : {} })
}

/**
 * Reads an Issue or PR, a page of its comments or reviews, a review thread, or a CI snapshot of the instance whose
 * resources start with `prefix` (its id) as model-facing `{ id, from, at, text, reply_to?, path?, line?, url }` messages
 * rather than raw forge API records.
 */
export async function readForge(client: ForgeClient, resource: string, prefix = 'github'): Promise<unknown> {
  if (!resource.startsWith(`${prefix}/`)) throw new Error(`A resource of this Source starts with ${prefix}/`)
  const rest = resource.slice(prefix.length + 1)
  // A commit's CI, such as the default branch's, which no PR names.
  const commit = /^commits\/([0-9a-f]{7,40})\/checks$/.exec(rest)
  if (commit) return client.checks(commit[1]!)
  const match = /^(issues|pulls)\/([1-9]\d*)(?:\/(comments|reviews|checks|thread)(?:\/([1-9]\d*))?)?$/.exec(rest)
  if (!match) {
    throw new Error(`Use ${prefix}/issues/<number>, ${prefix}/pulls/<number>, or append /comments/<page>, /reviews/<page>, /thread/<comment-id> or /checks; or ${prefix}/commits/<sha>/checks`)
  }
  const [, kind, number, section, page = '1'] = match
  if (kind === 'issues' && (section === 'reviews' || section === 'checks' || section === 'thread')) {
    throw new Error('Reviews, review threads and checks require a pull request')
  }
  const pr = kind === 'pulls'
  if (section === 'checks') {
    if (match[4]) throw new Error('Checks do not take a page number')
    const pull = z.looseObject({ head: z.looseObject({ sha: z.string() }) }).parse(await client.pull(Number(number)))
    return client.checks(pull.head.sha)
  }
  if (section === 'thread') {
    if (!match[4]) throw new Error(`Name the review thread by one of its comments: ${prefix}/pulls/<number>/thread/<comment-id>`)
    const thread = await client.reviewThread(Number(number), Number(match[4]))
    if (!thread.length) throw new Error('No review comment of this PR has that id')
    return { messages: threadMessages(client, thread, item => String(item.id)) }
  }
  if (!section) {
    const item = DescriptionSchema.parse(pr ? await client.pull(Number(number)) : await client.issue(Number(number)))
    const branches = item.head && item.base ? { head: item.head.ref, base: item.base.ref } : {}
    const labels = item.labels?.length ? { labels: item.labels.map(label => label.name) } : {}
    return { number: item.number, title: item.title, state: item.state, ...item.merged ? { merged: true } : {},
      ...item.draft ? { draft: true } : {}, ...branches, ...labels, ...forgeMessage(client, item, item.body ?? '', String(item.number)) }
  }
  const listed = await client.commentPage(Number(number), section as 'comments' | 'reviews', Number(page), 20, pr)
  const tally = { skipped: 0 }
  const items = validItems(CommentSchema, listed.items, tally)
  const messages = items.map(item => section === 'reviews'
    ? forgeMessage(client, { ...item, created_at: item.submitted_at ?? item.created_at }, reviewText(item), String(item.id))
    : { ...forgeMessage(client, item, item.body ?? '', String(item.id)), ...item.in_reply_to_id ? { reply_to: String(item.in_reply_to_id) } : {} })
  return { messages, ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.more ? { next_resource: `${prefix}/${kind}/${number}/${section}/${Number(page) + 1}` } : {} }
}
/** Reads one page of an Issue or PR conversation (with the Issue/PR description first on page 1), using comment URLs as message IDs. */
async function conversationPage(client: ForgeClient, number: number, page: number, config?: Record<string, unknown>) {
  const messages: ContextMessage[] = []
  if (page === 1) {
    const issue = await client.issue(number)
    messages.push(forgeMessage(client, issue, `${issue.title}\n\n${issue.body ?? ''}`, issue.html_url, config))
  }
  const listed = await client.commentPage(number, 'comments', page, 100, false)
  const tally = { skipped: 0 }
  const comments = validItems(CommentSchema, listed.items, tally)
  messages.push(...comments.map(comment => forgeMessage(client, comment, comment.body ?? '', comment.html_url ?? String(comment.id), config)))
  return { messages, next_resource: listed.more ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}
/**
 * Context reader for a forge Trigger: reads the review thread for an inline review comment (whose first comment is its
 * root and parent), or the Issue/PR conversation by page otherwise (whose first page is its root and parent).
 */
export const forgeThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part, cursor, config) => {
    // The default branch's CI has no conversation; its Trigger is its context.
    if (typeof trigger.meta.branch === 'string') {
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [message], body: { status: 'branch_ci', messages: [message] }, status: 'branch_ci' }
    }
    const client = forgeClient(commands, trigger.source)
    const number = Number(trigger.meta.number)
    if (trigger.meta.kind === 'inline' && typeof trigger.meta.commentId === 'number') {
      const thread = await client.reviewThread(number, trigger.meta.commentId)
      const messages = threadMessages(client, thread, item => item.html_url ?? String(item.id), config)
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      return { messages: read, body: { status: 'review_thread', messages: read }, status: 'review_thread' }
    }
    const body = await conversationPage(client, number, Number(cursor ?? '1'), config)
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}
/** @deprecated The GitHub name of `forgeThreadContext`. */
export const githubThreadContext = forgeThreadContext
/** @deprecated The GitHub name of `readForge`. */
export const readGithub = (client: ForgeClient, resource: string): Promise<unknown> => readForge(client, resource, 'github')
