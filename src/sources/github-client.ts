/** GitHub REST calls through the agent's gh for one GitHub Source instance's repository, on github.com or a GitHub Enterprise Server. */
import { z } from 'zod'
import { hostFlag, type ForgeAccount } from '../deployment.ts'
import { CliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import type { CiSnapshot, CommentKind, ForgeClient, ForgeConventions, ForgeNotification, StreamId, StreamPage } from './forge-client.ts'
import { CommentSchema, IssueSchema, isHumanLogin, type ForgeComment, type ForgeIssue } from './forge-trigger.ts'

const GITHUB_COM = { web: 'https://github.com', api: 'https://api.github.com' }
export const githubPage = (repository: string, number: number, pr = false, web = GITHUB_COM.web): string =>
  `${web}/${repository}/${pr ? 'pull' : 'issues'}/${number}`
/**
 * Parses a web or API URL for an Issue, PR, or review comment in `repository` on the GitHub host whose web and API
 * addresses `host` names (github.com by default); returns undefined for other URLs, hosts or repositories.
 */
export function githubAddress(url: string, repository: string, host: { web: string; api: string } = GITHUB_COM):
  { number: number; pr: boolean; discussion?: number } | undefined {
  const bases = [`${escapeRegExp(host.api)}\\/repos`, escapeRegExp(host.web)].join('|')
  const address = new RegExp(`^(?:${bases})\\/([^/]+\\/[^/]+)\\/(issues|pulls?)\\/(\\d+)\\/?(?:#discussion_r(\\d+)|#[\\w-]*)?$`, 'i')
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues', ...match[4] ? { discussion: Number(match[4]) } : {} }
}
/** GitHub's conventions on the host of `account`. */
export const githubConventions = (account: Pick<ForgeAccount, 'web' | 'api'>): ForgeConventions => ({
  product: 'GitHub',
  page: (repository, number, pr) => githubPage(repository, number, pr, account.web),
  commitPage: (repository, sha) => `${account.web}/${repository}/commit/${sha}`,
  address: (url, repository) => githubAddress(url, repository, account),
  isHuman: isHumanLogin,
})

/** A notification of the agent account; `subject.url` is the API address of its Issue or PR. */
const NotificationSchema = z.looseObject({
  repository: z.looseObject({ full_name: z.string() }), subject: z.looseObject({ url: z.string().nullish() }),
})
const CheckSchema = z.looseObject({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })
const StatusSchema = z.looseObject({ context: z.string(), state: z.string() })
const ReviewCommentSchema = z.looseObject({ id: z.number(), in_reply_to_id: z.number().nullish() })
const PostedSchema = z.looseObject({ id: z.number(), body: z.string().nullish(), in_reply_to_id: z.number().nullish(),
  user: z.looseObject({ login: z.string() }).nullish() })
/** Repository-wide event streams; GitHub's `/issues` endpoint includes PRs, and `/issues/comments` covers issue and PR conversation comments (excluding inline review comments). */
const STREAMS: Record<StreamId, string> = { issues: 'issues?state=all', comments: 'issues/comments?', 'review-comments': 'pulls/comments?' }
function included(raw: string): { headers: string; body: string } {
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  return { headers: raw.slice(0, split), body: raw.slice(split).trim() }
}
const missing = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)

/**
 * Calls the GitHub API with the agent's gh, restricted to the repository of one forge account. A GitHub Enterprise Server
 * host is named with `--hostname`, after the path and flags so the arguments for github.com stay as gh has always been called.
 * Failures are `CliError`s whose `code` is GitHub's HTTP status.
 */
export class GithubClient implements ForgeClient {
  readonly conventions: ForgeConventions
  constructor(readonly commands: Commands, readonly account: ForgeAccount) { this.conventions = githubConventions(account) }
  withSignal(signal?: AbortSignal): GithubClient { return signal ? new GithubClient(this.commands.withSignal(signal), this.account) : this }
  /**
   * Calls the GitHub API on a path within the account's repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    const host = hostFlag(this.account.host)
    if (typeof schema === 'string') return this.commands.run(this.account.cli, ['api', this.path(schema), ...rest, ...host])
    const [path = '', ...flags] = rest
    return schema.parse(await this.commands.gh(['api', this.path(path), ...flags, ...host], this.account.cli))
  }
  /** Fetches all pages of a GitHub API list within the account's repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const output = await this.commands.gh(['api', this.path(path), '--paginate', '--slurp', ...hostFlag(this.account.host)], this.account.cli)
    return validItems(item, z.array(z.array(z.unknown())).parse(output).flat(), tally)
  }
  /** The repository's notifications; GitHub asks for its polling interval in `X-Poll-Interval`, which is at least 60 seconds. */
  async notifications(since: string, tally?: Tally): Promise<{ items: ForgeNotification[]; interval: number }> {
    const path = `notifications?all=true&per_page=50&since=${encodeURIComponent(since)}`
    const { headers, body } = included(await this.api(path, '--include'))
    const asked = Number(/x-poll-interval:\s*(\d+)/i.exec(headers)?.[1] ?? 60)
    const interval = Math.max(60, Number.isFinite(asked) ? asked : 60)
    const listed = /rel="next"/.test(headers) ? await this.pages(NotificationSchema, path, tally)
      : validItems(NotificationSchema, z.array(z.unknown()).parse(JSON.parse(body)), tally)
    return { interval, items: listed.map(item => {
      const repository = item.repository.full_name
      const address = githubAddress(item.subject.url ?? '', repository, this.account)
      return address ? { repository, number: address.number, pr: address.pr, ...address.discussion ? { discussion: true as const } : {} }
        : { repository, pr: false }
    }) }
  }
  /** One stream since `since`, oldest updated first; sending the last page's ETag makes an unchanged list answer HTTP 304 and cost no rate limit. */
  async stream(id: StreamId, since: string, etag?: string): Promise<StreamPage | 'unchanged'> {
    const conditional = etag ? ['-H', `If-None-Match: ${etag}`] : []
    const listed = `${STREAMS[id]}&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`
    let raw: string
    try { raw = await this.api(listed, '--include', ...conditional) }
    catch (error) {
      if (error instanceof CliError && error.code === 304) return 'unchanged'
      throw error
    }
    const { headers, body } = included(raw)
    const tag = /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim()
    return { items: z.array(z.unknown()).parse(JSON.parse(body)), ...tag ? { etag: tag } : {} }
  }
  async defaultBranch(): Promise<string> { return (await this.api(z.looseObject({ default_branch: z.string() }), '')).default_branch }
  async commitSha(ref: string): Promise<string> { return (await this.api(z.looseObject({ sha: z.string() }), `commits/${encodeURIComponent(ref)}`)).sha }
  issue(number: number): Promise<ForgeIssue> { return this.api(IssueSchema, `issues/${number}`) }
  pull(number: number): Promise<unknown> { return this.api(z.unknown(), `pulls/${number}`) }
  comments(number: number, kind: CommentKind, since?: string, tally?: Tally): Promise<ForgeComment[]> {
    const suffix = since ? `&since=${encodeURIComponent(since)}` : ''
    const path = kind === 'conversation' ? `issues/${number}/comments?per_page=100${suffix}` : kind === 'inline'
      ? `pulls/${number}/comments?per_page=100${suffix}` : `pulls/${number}/reviews?per_page=100`
    return this.pages(CommentSchema, path, tally)
  }
  async commentPage(number: number, section: 'comments' | 'reviews', page: number, size: number, pr: boolean) {
    const items = await this.api(z.array(z.unknown()), `${pr ? 'pulls' : 'issues'}/${number}/${section}?per_page=${size}&page=${page}`)
    return { items, more: items.length === size }
  }
  async reviewThread(number: number, comment: number, tally?: Tally): Promise<ForgeComment[]> {
    const comments = await this.pages(CommentSchema, `pulls/${number}/comments?per_page=100`, tally)
    const root = comments.find(item => item.id === comment)?.in_reply_to_id ?? comment
    return comments.filter(item => item.id === root || item.in_reply_to_id === root)
      .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
  }
  reviewComment(_number: number, id: number) {
    return this.api(ReviewCommentSchema, `pulls/comments/${id}`).catch((error: unknown) => { if (missing(error)) return undefined; throw error })
  }
  /** Reads check runs and commit statuses for a commit, keeping the latest status per context. */
  async checks(sha: string, tally?: Tally): Promise<CiSnapshot> {
    const page = z.looseObject({ check_runs: z.array(z.unknown()) })
    const pages = await this.api(z.array(page), `commits/${sha}/check-runs?per_page=100`, '--paginate', '--slurp')
    const runs = validItems(CheckSchema, pages.flatMap(item => item.check_runs), tally)
    const statuses = await this.pages(StatusSchema, `commits/${sha}/statuses?per_page=100`, tally)
    const latest = new Map<string, string>()
    for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status.state)
    const checks = runs.map(({ name, status, conclusion }) => ({ name, status, conclusion }))
    return { head: sha, checks: checks.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      statuses: [...latest].map(([context, state]) => ({ context, state })).sort((a, b) => a.context.localeCompare(b.context)) }
  }
  async contents(path: string, kind: 'file' | 'directory'): Promise<string> {
    const resource = `contents/${path.split('/').map(encodeURIComponent).join('/')}`
    if (kind === 'file') return this.api(resource, '-H', 'Accept: application/vnd.github.raw')
    // GitHub returns an entry array for a directory and a single object for a file.
    const entries = await this.api(z.union([z.array(z.looseObject({ name: z.string() })), z.looseObject({})]), resource)
    if (!Array.isArray(entries)) throw new Error(`${path} is not a directory`)
    return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
  }
  async posted(number: number, root?: number) {
    const comments = await this.pages(PostedSchema, root === undefined ? `issues/${number}/comments` : `pulls/${number}/comments`)
    return root === undefined ? comments : comments.filter(comment => comment.in_reply_to_id === root)
  }
  async post(number: number, body: string, root?: number): Promise<void> {
    const target = root === undefined ? `issues/${number}/comments` : `pulls/${number}/comments/${root}/replies`
    await this.api(z.unknown(), target, '--method', 'POST', '-f', `body=${body}`)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    const { repository } = this.account
    return path ? `repos/${repository}/${path}` : `repos/${repository}`
  }
}
/** The GitHub client of Source instance `instance`, whose account setup resolved. */
export function githubClient(commands: Commands, instance: string): GithubClient {
  const account = commands.deployment.forges[instance]
  if (!account || account.kind !== 'github') throw new Error(`The ${instance} Source has no GitHub account; the management panel names what setup needs`)
  return new GithubClient(commands, account)
}
