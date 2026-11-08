/**
 * Gitea REST calls for one Gitea Source instance's repository, over Node's fetch with the agent's token file, normalized to
 * the records the forge Source reads (GitHub's REST shapes). Gitea's divergences are handled here: `page`/`limit` paging
 * with `Link`, no ETag or sort on lists, notifications that name every subject by its Issue address, reviews whose inline
 * comments carry no thread root, statuses without check runs, and 404 for a deleted Issue.
 */
import { z } from 'zod'
import { readTokenFile, type ForgeAccount } from '../deployment.ts'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { ForgeError, isWildcard, type CiSnapshot, type CommentKind, type ForgeClient, type ForgeConventions, type ForgeNotification, type StreamId,
  type StreamPage } from './forge-client.ts'
import { CommentSchema, IssueSchema, type ForgeComment, type ForgeIssue } from './forge-trigger.ts'

/** Gitea's largest page (`max_response_items` defaults to 50). */
export const GITEA_PAGE = 50
/** Most pages one list read follows; a longer list fails the read, so a stream's cursor stays where it was. */
export const GITEA_PAGES = 20
const TIMEOUT_MS = 90_000
/** Gitea's own accounts that are never a person: deleted users and the Actions runner. */
const AUTOMATED = new Set(['ghost', 'gitea-actions'])
/** Gitea's conventions on the host of `account`. */
export const giteaConventions = (account: Pick<ForgeAccount, 'web' | 'api'>): ForgeConventions => ({
  product: 'Gitea',
  page: (repository, number, pr) => `${account.web}/${repository}/${pr ? 'pulls' : 'issues'}/${number}`,
  commitPage: (repository, sha) => `${account.web}/${repository}/commit/${sha}`,
  address: (url, repository) => giteaAddress(url, repository, account),
  // Gitea marks no account as a bot; the Source's automated accounts and the Policy's bots name them.
  isHuman: user => !AUTOMATED.has(user.login.toLowerCase()) && (!user.type || user.type === 'User' || user.type === 'Individual'),
})
/**
 * Parses a web or API URL of an Issue, PR, or inline review comment in `repository` on a Gitea host: an inline comment's page
 * is the PR's files page with the comment's anchor (`/pulls/<n>/files#issuecomment-<id>`), which the client gives every inline
 * comment; the conversation's anchor (`/pulls/<n>#issuecomment-<id>`) names a top-level comment.
 */
export function giteaAddress(url: string, repository: string, host: Pick<ForgeAccount, 'web' | 'api'>):
  { number: number; pr: boolean; discussion?: number } | undefined {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const address = new RegExp(`^(?:${escape(host.api)}\\/repos|${escape(host.web)})\\/([^/]+\\/[^/]+)\\/(issues|pulls)\\/(\\d+)(\\/files)?\\/?(?:#issuecomment-(\\d+)|#[\\w-]*)?$`, 'i')
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() === 'pulls', ...match[4] && match[5] ? { discussion: Number(match[5]) } : {} }
}

/** Gitea writes times with the server's offset (`+02:00`); the forge Source compares and keys them as UTC ISO strings. */
const TIME_FIELDS = ['created_at', 'updated_at', 'submitted_at', 'merged_at', 'closed_at'] as const
function utc<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = { ...value as Record<string, unknown> }
  for (const field of TIME_FIELDS) {
    const time = record[field]
    if (typeof time === 'string' && time && !time.endsWith('Z') && Number.isFinite(Date.parse(time))) record[field] = new Date(time).toISOString()
  }
  return record as T
}
const ReviewSchema = z.looseObject({ id: z.number(), state: z.string().nullish(), submitted_at: z.string().nullish(), updated_at: z.string().nullish(),
  body: z.string().nullish(), user: z.unknown(), html_url: z.string().nullish(), commit_id: z.string().nullish() })
const ReviewCommentSchema = z.looseObject({ id: z.number(), path: z.string().nullish(), position: z.number().nullish(),
  original_position: z.number().nullish(), created_at: z.string().nullish(), resolver: z.unknown().nullish() })
const NotificationSchema = z.looseObject({ repository: z.looseObject({ full_name: z.string() }),
  subject: z.looseObject({ url: z.string().nullish(), type: z.string().nullish() }) })
const StatusSchema = z.looseObject({ id: z.number().optional(), context: z.string(), status: z.string().optional(), state: z.string().optional() })
/** Gitea's review states, by GitHub's names; a pending review and a review request are no decision of anyone yet. */
const REVIEW_STATES: Record<string, string> = { APPROVED: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }

/**
 * The agent's account on one Gitea repository, read and written with the API token its token file holds, which is reread
 * on each call so a replaced token applies at once. Failures are `ForgeError`s with Gitea's HTTP status; an Issue or PR read
 * that answers 404 while the repository still reads answers 410, as Gitea says 404 for a deleted Issue.
 */
export class GiteaClient implements ForgeClient {
  readonly conventions: ForgeConventions
  private repositoryProbe?: Promise<boolean>
  constructor(readonly commands: Commands, readonly account: ForgeAccount) { this.conventions = giteaConventions(account) }
  withSignal(signal?: AbortSignal): GiteaClient { return signal ? new GiteaClient(this.commands.withSignal(signal), this.account) : this }
  forRepository(repository: string): GiteaClient {
    return sameName(repository, this.account.repository) ? this
      : new GiteaClient(this.commands, { ...this.account, repository, cloneUrl: `${this.account.web}/${repository}.git` })
  }
  async canPush(): Promise<boolean> {
    return z.looseObject({ permissions: z.looseObject({ push: z.boolean().nullish() }).nullish() }).parse(await this.get('')).permissions?.push === true
  }
  private get token(): string {
    if (this.account.credential.helper !== 'token-file') throw new Error(`The ${this.account.id} Source has no token file`)
    return readTokenFile(this.account.credential.path)
  }
  private get signal(): AbortSignal { return AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.commands.lifetime]) }
  /** Sends one request to a path of the account's repository (or, with a leading `/`, of the API root). */
  async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ value: unknown; headers: Headers }> {
    if (!path.startsWith('/') && isWildcard(this.account.repository)) throw new Error('A wildcard Gitea Source reads a repository through its client for that repository')
    const inside = path.startsWith('/') ? path.slice(1) : path ? `repos/${this.account.repository}/${path}` : `repos/${this.account.repository}`
    if (/(^|\/)\.\.?(\/|\?|$)/.test(inside)) throw new Error('Gitea calls are restricted to the configured repository')
    const token = this.token
    let response: Response
    try {
      response = await fetch(`${this.account.api}/${inside}`, { method: init.method ?? 'GET', signal: this.signal,
        headers: { authorization: `token ${token}`, accept: 'application/json', ...init.body === undefined ? {} : { 'content-type': 'application/json' } },
        ...init.body === undefined ? {} : { body: JSON.stringify(init.body) } })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new ForgeError(`Gitea did not answer: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    if (!response.ok) {
      let message = text.slice(0, 500)
      try { message = String((JSON.parse(text) as { message?: unknown }).message ?? message) } catch { /* Not JSON; keep the text. */ }
      throw new ForgeError(`Gitea: ${message || response.statusText} (HTTP ${response.status})`, response.status)
    }
    return { value: text ? JSON.parse(text) as unknown : null, headers: response.headers }
  }
  async get(path: string): Promise<unknown> { return (await this.request(path)).value }
  /**
   * Reads every page of a list (`limit` and `page` added to `path`), following `Link: rel="next"` up to `GITEA_PAGES` pages, or,
   * where Gitea sends no `Link` (its repository-wide comment list sends only `X-Total-Count`), until that count is read.
   */
  async list(path: string): Promise<unknown[]> {
    const items: unknown[] = []
    const join = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= GITEA_PAGES; page++) {
      const { value, headers } = await this.request(`${path}${join}limit=${GITEA_PAGE}&page=${page}`)
      const listed = z.array(z.unknown()).parse(value)
      items.push(...listed)
      const link = headers.get('link')
      const more = link ? /rel="next"/.test(link) : Number(headers.get('x-total-count') ?? 0) > items.length
      if (!more || listed.length === 0) return items
    }
    throw new ForgeError(`Gitea lists more than ${GITEA_PAGES * GITEA_PAGE} items for ${path.split('?')[0]}; nothing of it was taken in`)
  }
  /** Rereads 404 for an Issue or PR as 410 when the repository still reads, as Gitea answers 404 for a deleted Issue. */
  private async deletedWhenMissing<T>(read: () => Promise<T>): Promise<T> {
    try { return await read() }
    catch (error) {
      if (!(error instanceof ForgeError) || error.code !== 404) throw error
      this.repositoryProbe ??= this.get('').then(() => true, () => false)
      if (await this.repositoryProbe) throw new ForgeError(`${error.message}; the repository reads, so it was deleted`, 410)
      throw error
    }
  }
  async notifications(since: string, tally?: Tally): Promise<{ items: ForgeNotification[] }> {
    // A wildcard instance reads the account's notifications, which name every repository; another reads its repository's.
    const path = `${isWildcard(this.account.repository) ? '/' : ''}notifications?all=true&since=${encodeURIComponent(since)}`
    const listed = validItems(NotificationSchema, await this.list(path), tally)
    // Gitea names a PR, too, by its Issue address, and says it is one in `subject.type`.
    return { items: listed.map(item => {
      const number = Number(/\/issues\/(\d+)$/.exec(item.subject.url ?? '')?.[1]) || undefined
      const kind = item.subject.type ?? ''
      return { repository: item.repository.full_name, pr: kind === 'Pull', ...number && (kind === 'Issue' || kind === 'Pull') ? { number } : {} }
    }) }
  }
  /** Gitea ignores `sort`, so a stream reads every page since its cursor and sorts it here; it has no repository-wide inline comments. */
  async stream(id: StreamId, since: string): Promise<StreamPage | undefined> {
    if (id === 'review-comments') return undefined
    const path = id === 'issues' ? `issues?state=all&since=${encodeURIComponent(since)}` : `issues/comments?since=${encodeURIComponent(since)}`
    const items = (await this.list(path)).map(item => {
      const record = utc(item) as Record<string, unknown>
      // A PR's conversation comment names its PR in `pull_request_url` and leaves `issue_url` empty.
      return id === 'comments' && !record.issue_url && record.pull_request_url ? { ...record, issue_url: record.pull_request_url } : record
    })
    const at = (item: Record<string, unknown>) => Date.parse(String(item.updated_at ?? item.created_at ?? ''))
    return { items: items.sort((a, b) => at(a) - at(b)) }
  }
  async defaultBranch(): Promise<string> { return z.looseObject({ default_branch: z.string() }).parse(await this.get('')).default_branch }
  async commitSha(ref: string): Promise<string> {
    return z.looseObject({ commit: z.looseObject({ id: z.string() }) }).parse(await this.get(`branches/${encodeURIComponent(ref)}`)).commit.id
  }
  async issue(number: number): Promise<ForgeIssue> { return IssueSchema.parse(utc(await this.deletedWhenMissing(() => this.get(`issues/${number}`)))) }
  async pull(number: number): Promise<unknown> { return utc(await this.deletedWhenMissing(() => this.get(`pulls/${number}`))) }
  /** A PR's submitted reviews, decisions named as GitHub names them; pending reviews and review requests are left out. */
  private async reviews(number: number): Promise<z.infer<typeof ReviewSchema>[]> {
    return validItems(ReviewSchema, await this.list(`pulls/${number}/reviews`)).flatMap(review => {
      const state = REVIEW_STATES[review.state ?? '']
      // A submitted review's body cannot change, but Gitea moves its updated_at when a later review of the same reviewer marks
      // it stale and dismissed, which would read as an edit and deliver it again; its version is when it was submitted.
      return state ? [utc({ ...review, state, updated_at: review.submitted_at ?? review.updated_at })] : []
    })
  }
  /**
   * Every inline review comment of a PR, from each of its reviews, with GitHub's fields: `line` and `original_line` from
   * Gitea's positions, and `in_reply_to_id`, the earliest comment on the same file and line, which roots its thread.
   */
  private async inline(number: number, tally?: Tally): Promise<ForgeComment[]> {
    const reviews = await this.list(`pulls/${number}/reviews`).then(items => validItems(ReviewSchema, items))
    const comments: Record<string, unknown>[] = []
    for (const review of reviews.filter(item => item.state !== 'PENDING')) {
      const listed = z.array(z.unknown()).parse(await this.get(`pulls/${number}/reviews/${review.id}/comments`))
      comments.push(...listed.map(item => utc(item) as Record<string, unknown>))
    }
    const valid = validItems(ReviewCommentSchema, comments, tally)
    // Gitea gives a comment on the new side of the diff its line as `position`, and one on the old side as `original_position`.
    const place = (comment: z.infer<typeof ReviewCommentSchema>) => `${comment.path}\u0000${comment.position ? `+${comment.position}` : `-${comment.original_position ?? 0}`}`
    const roots = new Map<string, number>()
    for (const comment of [...valid].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id - b.id)) {
      if (!roots.has(place(comment))) roots.set(place(comment), comment.id)
    }
    // Gitea 28 gives an inline comment the conversation's address (`/pulls/<n>#issuecomment-<id>`), as it gives a top-level
    // comment; its address on the files page (which anchors it too) is what marks it as a review thread's.
    const page = (id: number) => `${this.account.web}/${this.account.repository}/pulls/${number}/files#issuecomment-${id}`
    return validItems(CommentSchema, valid.map(comment => {
      const root = roots.get(place(comment))
      // Resolving a comment moves its `updated_at`, which would read as an edit and deliver it again; a resolved comment keeps
      // the time it was written (an edit made after it was resolved is not delivered).
      return { ...comment, html_url: page(comment.id), ...comment.resolver ? { updated_at: comment.created_at } : {},
        line: comment.position || null, original_line: comment.original_position || null,
        ...root !== undefined && root !== comment.id ? { in_reply_to_id: root } : {} }
    }), tally)
  }
  async comments(number: number, kind: CommentKind, since?: string, tally?: Tally): Promise<ForgeComment[]> {
    if (kind === 'review') return validItems(CommentSchema, await this.reviews(number), tally)
    const after = (comment: ForgeComment) => !since || Date.parse(comment.updated_at ?? comment.created_at ?? '') >= Date.parse(since)
    if (kind === 'inline') return (await this.inline(number, tally)).filter(after)
    const suffix = since ? `?since=${encodeURIComponent(since)}` : ''
    const listed = z.array(z.unknown()).parse(await this.get(`issues/${number}/comments${suffix}`))
    return validItems(CommentSchema, listed.map(utc), tally)
  }
  /** One page of a conversation (Gitea lists an Issue's comments whole, so they are paged here), a PR's inline comments, or its reviews. */
  async commentPage(number: number, section: 'comments' | 'reviews', page: number, size: number, pr: boolean) {
    const all: unknown[] = section === 'reviews' ? await this.reviews(number) : pr ? await this.inline(number)
      : z.array(z.unknown()).parse(await this.get(`issues/${number}/comments`)).map(utc)
    return { items: all.slice((page - 1) * size, page * size), more: all.length > page * size }
  }
  async reviewThread(number: number, comment: number, tally?: Tally): Promise<ForgeComment[]> {
    const comments = await this.inline(number, tally)
    const root = comments.find(item => item.id === comment)?.in_reply_to_id ?? comment
    return comments.filter(item => item.id === root || item.in_reply_to_id === root)
      .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
  }
  async reviewComment(number: number, id: number) {
    const comment = (await this.inline(number).catch((error: unknown) => {
      if (error instanceof ForgeError && (error.code === 404 || error.code === 410)) return []
      throw error
    })).find(item => item.id === id)
    return comment ? { id: comment.id, in_reply_to_id: comment.in_reply_to_id } : undefined
  }
  /** A commit's statuses (Gitea Actions report as statuses; there are no check runs), the latest per context. */
  async checks(sha: string, tally?: Tally): Promise<CiSnapshot> {
    const statuses = validItems(StatusSchema, await this.list(`commits/${encodeURIComponent(sha)}/statuses`), tally)
    const latest = new Map<string, string>()
    for (const status of statuses.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))) {
      if (!latest.has(status.context)) latest.set(status.context, status.status ?? status.state ?? 'pending')
    }
    return { head: sha, checks: [], statuses: [...latest].map(([context, state]) => ({ context, state })).sort((a, b) => a.context.localeCompare(b.context)) }
  }
  async contents(path: string, kind: 'file' | 'directory'): Promise<string> {
    const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    if (kind === 'file') return this.raw(`raw/${encoded}`)
    const entries = await this.get(encoded ? `contents/${encoded}` : 'contents')
    if (!Array.isArray(entries)) throw new Error(`${path} is not a directory`)
    return validItems(z.looseObject({ name: z.string() }), entries).map(entry => entry.name)
      .filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
  }
  /** Reads a repository path's body as text, as a raw file is. */
  private async raw(path: string): Promise<string> {
    const response = await fetch(`${this.account.api}/repos/${this.account.repository}/${path}`, {
      headers: { authorization: `token ${this.token}` }, signal: this.signal })
    if (!response.ok) throw new ForgeError(`Gitea: ${response.statusText} (HTTP ${response.status})`, response.status)
    return response.text()
  }
  async posted(number: number, root?: number) {
    if (root === undefined) return validItems(CommentSchema, z.array(z.unknown()).parse(await this.get(`issues/${number}/comments`)))
    return (await this.inline(number)).filter(comment => comment.in_reply_to_id === root)
  }
  async post(number: number, body: string, root?: number): Promise<void> {
    await this.request(root === undefined ? `issues/${number}/comments` : `pulls/${number}/comments/${root}/replies`, { method: 'POST', body: { body } })
  }
}
/** The Gitea client of Source instance `instance`, whose account setup resolved. */
export function giteaClient(commands: Commands, instance: string): GiteaClient {
  const account = commands.deployment.forges[instance]
  if (!account || account.kind !== 'gitea') throw new Error(`The ${instance} Source has no Gitea account; the management panel names what setup needs`)
  return new GiteaClient(commands, account)
}
