/** Gitea source kind definition, built on the generic forge Source, and its Cordis plugin entry (`dsh-superagent-gitea`, `./gitea-watch`). */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GiteaAccountsSchema } from '../deployment.ts'
import { forgeChannel } from './forge-trigger.ts'
import { forgeLink, sendForge } from './forge-channel.ts'
import { forgeThreadContext } from './forge-read.ts'
import { applyForge, forgeKind, type ForgeConfig } from './forge.ts'
import { watchForge } from './forge-poll.ts'
import type { ChannelLinks, SourceKind } from './kind.ts'

export const SOURCE = 'gitea'
/** A Gitea reply address on instance `source` (by default the Gitea Source's own). */
export const giteaChannel = (number: number, url?: string, source = SOURCE) => forgeChannel(source, number, url)
export const giteaLink = (address: Record<string, string>, links: ChannelLinks, instance = SOURCE) => forgeLink(address, links, instance, 'Gitea')
const Login = z.string().regex(/^[A-Za-z0-9_.-]+$/)
const GiteaConfigSchema = GiteaAccountsSchema.extend({
  // Gitea asks for no polling interval, so the configured one is the interval; it may be shorter than GitHub's.
  pollSeconds: z.number().int().min(15).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false), observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false),
  // Gitea marks no account as a bot, so the accounts of automated reviewers and CI are named here.
  automatedAccounts: z.array(z.object({ id: Login }).strict()).default([]),
}).strict()
export type GiteaConfig = z.infer<typeof GiteaConfigSchema> & ForgeConfig
export const giteaKind: SourceKind<GiteaConfig> = forgeKind<GiteaConfig>({
  kind: SOURCE,
  offUntilSaved: true,
  title: { zh: 'Gitea', en: 'Gitea' },
  description: { zh: '智能体的 Gitea 账号；接收仓库里发给它的通知、已订阅 Issue 与 PR 的讨论、CI 状态变化和 PR 合并关闭。', en: 'The agent\'s Gitea account; receives notifications to it in the repository, discussion on subscribed Issues and PRs, CI status changes, and PR merge or close.' },
  schema: GiteaConfigSchema as unknown as z.ZodType<GiteaConfig>,
  host: config => typeof config.host === 'string' ? config.host : '',
  fields: [
    { key: 'host', type: 'text', pattern: '[A-Za-z0-9.\\-]+(:[0-9]+)?', label: { zh: 'Gitea 主机', en: 'Gitea host' },
      hint: { zh: 'Gitea 服务器的主机名，例如 git.example.com；API 在 https://<主机>/api/v1。保存时检查令牌，然后重启 dsh-superagent。', en: 'The Gitea server\'s host name, such as git.example.com, whose API is https://<host>/api/v1. Saving checks the token, then restarts dsh-superagent.' } },
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/([A-Za-z0-9_.\\-]+|\\*)', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name，或者 owner/* 表示这个 owner 的所有仓库：那样只接收发给智能体的通知，不观察整个仓库，推送权限在每个仓库第一次通知时检查。保存时检查令牌的账号能否推送到它，然后重启 dsh-superagent。', en: 'Written owner/name, or owner/* for every repository of the owner, which receives only the agent\'s notifications, observes no repository as a whole, and reads push access per repository when it first notifies. Saving checks that the token\'s account can push to it, then restarts dsh-superagent.' } },
    { key: 'tokenFile', type: 'text', label: { zh: '智能体的令牌文件', en: 'Agent token file' },
      hint: { zh: '绝对路径，文件权限 0600，第一行是智能体账号的 Gitea API 令牌。轮询读它；执行器的 git 通过 dsh-superagent 的凭据脚本用它推送。', en: 'An absolute path to a file of mode 0600 whose first line is the agent account\'s Gitea API token. Polling reads it, and the Executor\'s git pushes with it through dsh-superagent\'s credential helper.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 tea', en: 'Agent tea CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 XDG_CONFIG_HOME 登录智能体账号的 tea 包装脚本（用同一个令牌）。执行器以 tea 调用它；保存时检查它登录的账号就是令牌的账号。', en: 'A command name or absolute path, usually a tea wrapper signed in to the agent account through XDG_CONFIG_HOME, with the same token. The Executor calls it as tea; saving checks that it acts as the token\'s account.' } },
    { key: 'automatedAccounts', type: 'rows', label: { zh: '自动化账号', en: 'Automated accounts' },
      hint: { zh: 'Gitea 不标记机器人：名单里的账号（例如评审或 CI 机器人）当作非人类，它们的消息不能发起工作。', en: 'Gitea marks no account as a bot: the accounts listed here, such as review or CI bots, count as automated, and their messages never originate work.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 15, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 PR 也会收到，由策略的接收表决定是否成为候选。', en: 'New pull requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，Issue 和 PR 上没有 @ 智能体的评论也会收到；Gitea 没有全仓库的代码评论列表，代码评论只在已订阅的 PR 上收到。', en: 'Comments on Issues and PRs that do not mention the agent are received too. Gitea lists no review comments across the repository, so those arrive only on subscribed PRs.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的 CI', en: 'Receive the default branch\'s CI' },
      hint: { zh: '打开后，默认分支的提交状态（Gitea Actions 也报告为状态）失败和恢复会收到。', en: 'Failures of the default branch\'s commit statuses, which Gitea Actions report too, and their recovery are received.' } }],
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: Login }).strict()).default([]), bots: z.array(z.object({ id: Login }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Gitea 账号', en: 'Gitea accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的自动化账号的评论在来源收到时成为推断的候选，交给评估。它们不能发起明确的请求，也不能停止工单。', en: 'A comment of an automated account on this list becomes an inferred candidate for an assessment when the Source receives it. Such a comment never makes an explicit request or stops a ticket.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
  },
}, { channel: { send: sendForge, link: giteaLink }, threadContext: forgeThreadContext })
export const name = 'dsh-superagent-gitea'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  applyForge(ctx, giteaKind as unknown as SourceKind, (source, signal) => watchForge(source, signal, SOURCE))
}
