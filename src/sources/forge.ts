/**
 * The generic forge Source: `forgeKind()` builds a forge's SourceKind (GitHub's, Gitea's) from its own fields, policy and
 * conventions, `forgeClient()` gives the client of an instance's resolved account, and `applyForge()` is a forge plugin's entry:
 * it registers the kind and runs one polling loop per instance.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { ForgeAccount, ForgeKind } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { covers, isWildcard, type ForgeClient, type ForgeConventions } from './forge-client.ts'
import { forgeThreadId } from './forge-trigger.ts'
import { GithubClient, githubConventions } from './github-client.ts'
import { GiteaClient, giteaConventions } from './gitea-client.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { FieldSpec, Localized, SourceKind, SourcePolicyPart, VariableSpec, EnvironmentInput } from './kind.ts'

/** The forge kinds' clients, by kind. */
const CLIENTS: Record<ForgeKind, { client(commands: Commands, account: ForgeAccount): ForgeClient; conventions(account: ForgeAccount): ForgeConventions }> = {
  github: { client: (commands, account) => new GithubClient(commands, account), conventions: githubConventions },
  gitea: { client: (commands, account) => new GiteaClient(commands, account), conventions: giteaConventions },
}
/** The client of forge Source instance `instance`, whose account setup resolved. */
export function forgeClient(commands: Commands, instance: string): ForgeClient {
  const account = commands.deployment.forges[instance]
  if (!account) throw new Error(`The ${instance} Source has no forge account; the management panel names what setup needs`)
  return CLIENTS[account.kind].client(commands, account)
}
/** The URL and naming conventions of a forge account. */
export const conventionsOf = (account: ForgeAccount): ForgeConventions => CLIENTS[account.kind].conventions(account)

/** What a forge instance observes across its repository, by admission row, and the switch that turns each on. */
export const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments', ci: 'observeCi' } as const
type Row = keyof typeof OBSERVED
const ObservedSchema = z.looseObject({ observeIssues: z.boolean().optional(), observePulls: z.boolean().optional(),
  observeComments: z.boolean().optional(), observeCi: z.boolean().optional() })
export interface ForgeConfig extends Record<string, unknown> {
  repository: string; pollSeconds: number; failuresBeforeError: number
  observeIssues: boolean; observePulls: boolean; observeComments: boolean; observeCi: boolean
  /** Accounts the instance counts as automated, for a forge that marks none (Gitea). */
  automatedAccounts?: { id: string }[]
}
/** Who counts as a person on an instance: whom its forge reports as one, unless the instance names the account as automated. */
export function humanOf(conventions: Pick<ForgeConventions, 'isHuman'>, config?: Record<string, unknown>) {
  const listed = Array.isArray(config?.automatedAccounts) ? config.automatedAccounts as { id?: unknown }[] : []
  const automated = new Set(listed.map(item => String(item.id ?? '').toLowerCase()))
  return (user: { login: string; type?: string | undefined }): boolean => conventions.isHuman(user) && !automated.has(user.login.toLowerCase())
}
function rowOf(meta: Record<string, unknown>): Row | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'review' ? 'comments' : undefined
}
/** A forge kind's own parts: everything its SourceKind holds that is not generic to forges. */
export interface ForgeSpec<C extends ForgeConfig> {
  kind: ForgeKind
  title: Localized
  description: Localized
  schema: z.ZodType<C>
  fields: FieldSpec[]
  policy: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
  /** The web hosts an Issue or PR page of an instance may be on, from its configuration (such as `github.com`). */
  host(config: Record<string, unknown>): string
  /** Off until saved (see `SourceKind.offUntilSaved`): every forge but GitHub, whose own instance has always existed unstored. */
  offUntilSaved?: true
  environment?: { variables: readonly VariableSpec[]; values(input: EnvironmentInput<C>): Record<string, string> }
}
const facts = (deployment: { forges: Record<string, ForgeAccount> } | undefined, instance: string): Record<string, Localized | string> => {
  const account = deployment?.forges[instance]
  return account ? { cli: { zh: `当前账号 @${account.login}`, en: `Current account @${account.login}` } } : {}
}
/** Builds a forge kind: the instances it admits, its scope by admission row, its Channel, thread context, searches, and facts. */
export function forgeKind<C extends ForgeConfig>(spec: ForgeSpec<C>, parts: Pick<SourceKind<C>, 'channel' | 'threadContext'>): SourceKind<C> {
  return {
    kind: spec.kind, multiple: true, ...spec.offUntilSaved ? { offUntilSaved: true } : {}, title: spec.title, description: spec.description,
    schema: spec.schema, fields: spec.fields,
    // What the Source observes across the repository it receives in full; elsewhere, only what addresses the agent.
    scope: ({ meta }, config) => {
      const row = rowOf(meta)
      return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
    },
    health: [spec.kind], ...parts,
    // `#12`, `12`, or the page of an Issue or PR of the instance's repository on its host, names Thread 12 of the instance; on a
    // wildcard instance, only the page of one of its repositories names a Thread, `owner/name#12`.
    find: (query, instance, config = {}) => {
      const host = spec.host(config), repository = typeof config.repository === 'string' ? config.repository : ''
      const page = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/(?:pulls?|issues)\/(\d+)/.exec(query.trim())
      const listed = page && sameName(page[1]!, host) && (!repository || covers(repository, page[2]!))
      if (isWildcard(repository)) return { threads: listed ? [`${instance}:${forgeThreadId(page[3]!, page[2]!)}`] : [], terms: [] }
      const number = (/^#?(\d+)$/.exec(query.trim()) ?? (listed ? [page[0], page[3]] : null))?.[1]
      return { threads: number ? [`${instance}:${number}`] : [], terms: [] }
    },
    policy: { ...spec.policy, rows(stored) {
      const config = ObservedSchema.parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Row, label: Localized) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('pulls', { zh: '新 PR', en: 'New pull requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        // CI has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'ci', label: { zh: '默认分支的 CI', en: 'Default branch CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    } },
    ...spec.environment ? { environment: spec.environment } : {},
    facts: (deployment, instance = spec.kind) => facts(deployment, instance),
  }
}
/** A forge plugin's entry: registers its kind, then polls each of its instances in its own loop until the plugin stops. */
export function applyForge(ctx: Context, kind: SourceKind, watch: (source: SourceContext, signal: AbortSignal) => Promise<void>): void {
  ctx.effect(() => ctx.orchestrator.sources.register(kind), `${kind.kind}: source kind`)
  ctx.effect(() => {
    const controller = new AbortController()
    const running = ctx.orchestrator.sources.instancesOf(kind.kind).map(instance => {
      const source = sourceContext(ctx.orchestrator, kind, instance)
      // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
      return watch(source, controller.signal).catch((error: unknown) => { source.report(kind.kind, { state: 'error', detail: String(error) }) })
    })
    return async () => { controller.abort(); await Promise.all(running) }
  })
}
export { health }
