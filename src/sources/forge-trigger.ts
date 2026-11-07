/** Normalizes forge Issues, pull requests, comments, reviews, and CI transitions into domain Triggers of one forge Source instance. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

/**
 * The forge Source instance a Trigger comes from: `source`, the instance id that names its Threads and Channels, and `kind`,
 * its forge kind, which prefixes Trigger ids. Ids of a kind's own instance (`source === kind`) are as GitHub's have always
 * been; a further instance's name the instance too, as Issue numbers repeat across repositories.
 */
export interface Origin { source: string; kind: string }
/** The GitHub Source's own instance. */
export const GITHUB_ORIGIN: Origin = { source: 'github', kind: 'github' }
/** The parts a Trigger id of `origin` starts with: its kind's prefix, and the instance unless it is the kind's own. */
const idParts = (origin: Origin, name: string): string[] => [`${origin.kind}-${name}`, ...origin.source === origin.kind ? [] : [origin.source]]
/** A forge reply address: an Issue or PR conversation, or a review thread when `url` points at an inline review comment. */
export const forgeChannel = (source: string, number: number, url?: string): ChannelRef =>
  ({ source, thread: `${source}:${number}`, address: { number: String(number), ...(url ? { url } : {}) } })
/** GitHub returns a deleted account as `null` and displays it as `ghost`; Gitea answers `Ghost` (id -1). */
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
/**
 * A forge comment or review; a review carries `state` and `commit_id`, and an inline review comment carries its file,
 * line, diff hunk, and `in_reply_to_id` (the root comment ID of its review thread).
 */
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type ForgeComment = z.infer<typeof CommentSchema>
/** An Issue as `issues/<number>` returns it; the forge sets `pull_request` when the number is a pull request. */
export const IssueSchema = CommentSchema.extend({
  number: z.number(), title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
  pull_request: z.looseObject({}).nullish(),
})
export type ForgeIssue = z.infer<typeof IssueSchema>
/** @deprecated GitHub names of the forge records, kept for callers that imported them. */
export type GithubComment = ForgeComment
/** @deprecated See `GithubComment`. */
export type GithubIssue = ForgeIssue
type Opened = Pick<ForgeIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
export interface PullRef { number: number; isPr: boolean; url?: string; prAuthor?: string }
/**
 * True when GitHub reports the account as a regular user rather than a bot or GitHub App.
 * Review bots running under ordinary user accounts count as human here; the prompts identify which accounts are automated.
 */
export const isHumanLogin = (user: { login: string; type?: string | undefined }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')
/** Formats an inline review comment's file:line and the trailing lines of its diff hunk, which the forge ends at the commented line. */
export function reviewPlace(comment: ForgeComment): string {
  const line = comment.line ?? comment.original_line
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  return [`${comment.path}${line != null ? `:${line}` : ''}`, hunk].filter(Boolean).join('\n')
}
function commentText(comment: ForgeComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
/** Who wrote a message, as the forge's `isHuman` sees the account, and never the agent itself as a person. */
export type Humans = (user: { login: string; type?: string | undefined }) => boolean
const author = (origin: Origin, user: { login: string; type?: string | undefined }, agent: string, human: Humans) =>
  ({ actor: { source: origin.source, id: user.login }, human: human(user) && !sameName(user.login, agent) })
/** Builds a trigger for a comment or review; text is empty for a bodyless comment or a `COMMENTED` review without a body. */
export function commentTrigger(comment: ForgeComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string,
  origin: Origin = GITHUB_ORIGIN, human: Humans = isHumanLogin): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const id = key(`${origin.kind}-comment`, comment.html_url ?? `${origin.source}:${ref.number}`, String(comment.id), version)
  const { source } = origin
  return { id, source, threads: [{ source, id: String(ref.number) }], ...author(origin, comment.user, agent, human), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: forgeChannel(source, ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {} } }
}
/**
 * Builds the trigger for a newly opened Issue's title and body.
 * The ID is the same as when Issue bodies were stored previously, so already-stored bodies are not ingested again.
 */
export function issueTrigger(issue: Opened, agent: string, origin: Origin = GITHUB_ORIGIN, human: Humans = isHumanLogin): Trigger {
  const body = issue.body ?? ''
  const { source } = origin
  return { id: key(...idParts(origin, 'issue'), String(issue.number)), source,
    threads: [{ source, id: String(issue.number) }], ...author(origin, issue.user, agent, human), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: forgeChannel(source, issue.number, issue.html_url), url: issue.html_url, meta: { number: issue.number, isPr: false, kind: 'issue' } }
}
/**
 * Builds the trigger for a newly opened PR's title and description.
 * PR and Issue numbers share one sequence on GitHub and Gitea and never collide, so this reuses `issueTrigger`'s id format.
 */
export function pullTrigger(pull: Opened, agent: string, origin: Origin = GITHUB_ORIGIN, human: Humans = isHumanLogin): Trigger {
  return { ...issueTrigger(pull, agent, origin, human), meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' } }
}
/** Builds a trigger for a default-branch CI transition; default-branch CI has no person to reply to, so it has no `channel`. */
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string, origin: Origin = GITHUB_ORIGIN): Trigger {
  const { source } = origin
  return { id: key(...idParts(origin, 'ci'), `branch:${branch}`, String(revision)), source,
    threads: [{ source, id: `ci:${branch}` }], actor: { source, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision } }
}
export function ciTrigger(pr: { number: number; html_url: string; user: { login: string } }, revision: number, summary: string,
  origin: Origin = GITHUB_ORIGIN): Trigger {
  const { source } = origin
  return { id: key(...idParts(origin, 'ci'), String(pr.number), String(revision)), source, threads: [{ source, id: String(pr.number) }],
    actor: { source, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: forgeChannel(source, pr.number), url: pr.html_url,
    meta: { number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision } }
}
