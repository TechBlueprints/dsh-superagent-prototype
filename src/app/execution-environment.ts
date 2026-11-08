/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment, ForgeAccount } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { forgeOf } from './forge-of.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
/**
 * The ticket's forge repository, whichever forge it is on (`forgeOf`); a ticket on no forge has them empty. Workers and
 * prepare commands read these; the GitHub Source still fills its `DSH_SUPERAGENT_GITHUB_*` for a GitHub ticket.
 */
export const FORGE_VARIABLES: readonly VariableSpec[] = [
  { key: 'DSH_SUPERAGENT_FORGE', description: { zh: '工单仓库所在的 forge：github 或 gitea', en: 'The forge of the ticket\'s repository: github or gitea' } },
  { key: 'DSH_SUPERAGENT_FORGE_SOURCE', description: { zh: '这个仓库的来源 id，它的资源以此开头', en: 'Its Source id, which its resources start with' } },
  { key: 'DSH_SUPERAGENT_FORGE_HOST', description: { zh: '它的主机', en: 'Its host' } },
  { key: 'DSH_SUPERAGENT_FORGE_API', description: { zh: '它的 API 地址', en: 'Its API base URL' } },
  { key: 'DSH_SUPERAGENT_FORGE_CLI', description: { zh: '在那里做一切操作的 CLI（gh 或 tea），已登录智能体账号', en: 'The CLI, gh or tea, signed in to the agent account, for every operation there' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY', description: { zh: '工单的仓库 owner/name；分支最后一段是 DSH_SUPERAGENT_NAME 的 PR 会关联到工单', en: 'The ticket\'s repository, owner/name; a PR from a branch whose last path segment is DSH_SUPERAGENT_NAME binds to the ticket' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY_URL', description: { zh: '它的 HTTPS 克隆地址', en: 'Its HTTPS clone URL' } },
  { key: 'DSH_SUPERAGENT_ACCOUNT', description: { zh: '智能体在那里的账号；不用其他账号或凭据', en: 'The agent\'s account there; never use another account or credential' } },
  { key: 'DSH_SUPERAGENT_COMMIT_EMAIL', description: { zh: '它的提交邮箱；git 没有身份，按提示词写明的作者提交，没写明时用这个账号和邮箱', en: 'Its commit email; git has no identity here: commit as the author these instructions name, else as this account with this email' } },
  { key: 'DSH_SUPERAGENT_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；不是从这个仓库来的时为空', en: 'The Issue or PR that started the ticket; empty when it did not start there' } },
  { key: 'DSH_SUPERAGENT_PR_HEAD', description: { zh: '那个 PR 的 head 引用 refs/pull/<编号>/head；不是 PR 时为空', en: 'Head ref refs/pull/<number>/head of that PR; empty when it was not a PR' } },
]
/** The forge variables' values for a ticket on `forge`, whose origin Trigger is `trigger`. */
export function forgeValues(forge: ForgeAccount | undefined, trigger?: Trigger): Record<string, string> {
  if (!forge) return {}
  const number = trigger?.threads[0]?.source === forge.id ? Number(trigger.meta.number) || 0 : 0
  return { DSH_SUPERAGENT_FORGE: forge.kind, DSH_SUPERAGENT_FORGE_SOURCE: forge.id, DSH_SUPERAGENT_FORGE_HOST: forge.host, DSH_SUPERAGENT_FORGE_API: forge.api,
    DSH_SUPERAGENT_FORGE_CLI: forge.shim, DSH_SUPERAGENT_REPOSITORY: forge.repository, DSH_SUPERAGENT_REPOSITORY_URL: forge.cloneUrl,
    DSH_SUPERAGENT_ACCOUNT: forge.login, DSH_SUPERAGENT_COMMIT_EMAIL: forge.commitEmail, DSH_SUPERAGENT_NUMBER: number ? String(number) : '',
    DSH_SUPERAGENT_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : '' }
}
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES }, { owner: 'forge', enabled: true, variables: FORGE_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

/**
 * The execution environment: the Executor's variables, a ticket's forge variables (only with a ticket), and each enabled
 * Source kind's, which see the ticket's forge as `forge`.
 */
export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string }; trigger?: Trigger; forge?: ForgeAccount }): Variable[] {
  const { deployment, sources, settings, ticket, trigger, forge } = input
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  if (ticket) {
    const values = forgeValues(forge, trigger)
    for (const spec of FORGE_VARIABLES) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: 'forge' })
  }
  for (const { kind, environment, config } of sources.environments(settings)) {
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {}, ...ticket ? { ticket: true, ...forge ? { forge } : {} } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, origin trigger and forge repository (`forgeOf`) with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '' }
  const forge = forgeOf(ticket, input.deployment, trigger, input.settings)
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {}, ...forge ? { forge } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
