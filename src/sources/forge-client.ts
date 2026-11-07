/**
 * The forge client contract that the generic forge Source (`forge*.ts`) polls, reads and replies through, and the records it
 * normalizes every forge's answers to (GitHub's REST shapes, which the GitHub client returns as they are).
 */
import type { ForgeAccount } from '../deployment.ts'
import { CliError, type Tally } from '../infra/commands.ts'
import type { ForgeComment, ForgeIssue } from './forge-trigger.ts'

/** True for a wildcard instance's repository, `owner/*`, which names every repository of the owner. */
export const isWildcard = (repository: string): boolean => repository.endsWith('/*')
/** Whether `repository` (owner/name) is one the instance's `configured` repository names: itself, or one of a wildcard owner's. */
export function covers(configured: string, repository: string): boolean {
  const lower = (text: string) => text.toLowerCase()
  return isWildcard(configured) ? lower(repository.split('/')[0] ?? '') === lower(configured.slice(0, -2)) && repository.includes('/')
    : lower(configured) === lower(repository)
}
/** A failed forge call; `code` is the forge's HTTP status (410 for a deleted Issue or PR, 304 for an unchanged list). */
export class ForgeError extends CliError {}
/** The HTTP status of a failed forge call, if it has one. */
export const forgeStatus = (error: unknown): number | undefined => error instanceof CliError ? error.code : undefined

/** One notification of the agent's account: the repository and the Issue or PR it names, or none for other subjects (such as a discussion). */
export interface ForgeNotification { repository: string; number?: number; pr: boolean; discussion?: true }
/** The repository-wide event streams: new Issues and PRs, conversation comments, and inline review comments. */
export type StreamId = 'issues' | 'comments' | 'review-comments'
/** A list read since a cursor; `etag` lets the next read of the same cursor answer `'unchanged'` where the forge supports it. */
export interface StreamPage { items: unknown[]; etag?: string }
export interface CiCheck { name: string; status: string; conclusion: string | null }
export interface CiStatus { context: string; state: string }
/** A commit's CI: check runs (GitHub only) and the latest status per context, each sorted. */
export interface CiSnapshot { head: string; checks: CiCheck[]; statuses: CiStatus[] }
/** What kind of comment list of an Issue or PR a read asks for. */
export type CommentKind = 'conversation' | 'inline' | 'review'

/**
 * A forge's URL and naming conventions for one account: its pages, its addresses, and whom it counts as a person.
 * A GitHub account's are GitHub's; a Gitea account's are Gitea's.
 */
export interface ForgeConventions {
  /** The product name, such as GitHub or Gitea, in labels and texts. */
  readonly product: string
  /** The web page of an Issue or PR of `repository`. */
  page(repository: string, number: number, pr?: boolean): string
  /** The web page of a commit of `repository`. */
  commitPage(repository: string, sha: string): string
  /** Parses a web or API URL of an Issue, PR or inline review comment in `repository`; undefined for other URLs or repositories. */
  address(url: string, repository: string): { number: number; pr: boolean; discussion?: number } | undefined
  /** True when the forge reports the account as a person rather than a bot or app. */
  isHuman(user: { login: string; type?: string | undefined }): boolean
}

/**
 * The agent's account on one forge repository, as the forge Source reads and writes through it. A forge's own client
 * (`GithubClient`, `GiteaClient`) maps each call to its API and its answers to the normalized records; a call the forge
 * cannot serve says so (`stream` answers `undefined`). Failures are `CliError`s carrying the forge's HTTP status.
 */
export interface ForgeClient {
  readonly account: ForgeAccount
  readonly conventions: ForgeConventions
  /** The same client whose calls also stop with `signal`. */
  withSignal(signal?: AbortSignal): ForgeClient
  /** The client of another repository of the same account, such as one of a wildcard (`owner/*`) instance's. */
  forRepository(repository: string): ForgeClient
  /** The agent's push access to the client's repository. */
  canPush(): Promise<boolean>
  /**
   * The agent's notifications since `since`, oldest last as the forge lists them, and the polling interval the forge asks
   * for, in seconds, if any.
   */
  notifications(since: string, tally?: Tally): Promise<{ items: ForgeNotification[]; interval?: number }>
  /**
   * One repository-wide stream since `since`, oldest first; `'unchanged'` when `etag` still holds, `undefined` when the forge
   * has no such stream.
   */
  stream(id: StreamId, since: string, etag?: string): Promise<StreamPage | 'unchanged' | undefined>
  /** The repository's default branch. */
  defaultBranch(): Promise<string>
  /** The commit a branch points at. */
  commitSha(ref: string): Promise<string>
  /** An Issue or PR by number, with `pull_request` set for a PR. */
  issue(number: number): Promise<ForgeIssue>
  /** A PR by number, in the shape `PullSchema` reads. */
  pull(number: number): Promise<unknown>
  /** Every comment of one kind on an Issue or PR updated since `since` (reviews carry their decision in `state`). */
  comments(number: number, kind: CommentKind, since?: string, tally?: Tally): Promise<ForgeComment[]>
  /** One page of an Issue's or PR's conversation comments or a PR's reviews, and whether a further page may follow. */
  commentPage(number: number, section: 'comments' | 'reviews', page: number, size: number, pr: boolean): Promise<{ items: unknown[]; more: boolean }>
  /** The comments of the review thread an inline review comment belongs to, root first. */
  reviewThread(number: number, comment: number, tally?: Tally): Promise<ForgeComment[]>
  /** An inline review comment by id, with the root it replies to; undefined when it is gone. */
  reviewComment(number: number, id: number): Promise<{ id: number; in_reply_to_id?: number | null | undefined } | undefined>
  /** A commit's CI. */
  checks(sha: string, tally?: Tally): Promise<CiSnapshot>
  /** A file's text, or a directory's entry names, on the default branch; `path` is relative and already checked. */
  contents(path: string, kind: 'file' | 'directory'): Promise<string>
  /** The agent's own and others' comments on an Issue or PR conversation, or in one review thread (by its root). */
  posted(number: number, root?: number): Promise<{ body?: string | null | undefined; user?: { login: string } | null | undefined }[]>
  /** Posts a comment on an Issue or PR conversation, or a reply in the review thread whose root is `root`. */
  post(number: number, body: string, root?: number): Promise<void>
}
