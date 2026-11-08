/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { sameName } from './infra/text.ts'
import { SetupError, type SetupCode, type SetupProblem } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

/** A forge Source's repository: owner/name, `owner/*` for every repository of the owner, or empty while unset. */
const REPOSITORY = /^([A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+|\*))?$/
/** A forge host name, optionally with a port, such as github.com or git.example.com:8443. */
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/
export const GithubAccountsSchema = z.object({
  host: z.string().trim().toLowerCase().regex(HOST, 'a host name such as github.com').default('github.com'),
  repository: z.string().trim().regex(REPOSITORY, 'owner/name, or owner/* for every repository of the owner').default(''),
  cli: z.string().trim().default(''),
})
/** A Gitea Source's accounts: the host, the repository, the agent's API token in a file only its owner reads, and its tea CLI. */
export const GiteaAccountsSchema = z.object({
  host: z.string().trim().toLowerCase().regex(/^([a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?)?$/, 'a host name such as git.example.com').default(''),
  repository: z.string().trim().regex(REPOSITORY, 'owner/name, or owner/* for every repository of the owner').default(''),
  tokenFile: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'an absolute path').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** The part of each Source kind's configuration that deployment setup reads, by Source kind. */
const SETUP_SCHEMAS = { github: GithubAccountsSchema, gitea: GiteaAccountsSchema, feishu: FeishuBotSchema } as const
/** Source configuration keys, by Source kind, that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(Object.entries(SETUP_SCHEMAS)
  .map(([kind, schema]) => [kind, Object.keys(schema.shape)]))
/** The setup fields of a stored configuration of `kind` with their defaults, so a default left out equals one written. */
export function setupValues(kind: string, config: unknown): Record<string, unknown> {
  const schema = (SETUP_SCHEMAS as Record<string, z.ZodObject>)[kind]
  const parsed = schema?.safeParse(config ?? {})
  return parsed?.success ? parsed.data : (config ?? {}) as Record<string, unknown>
}
/** Source kinds whose instances are forges: each enabled instance resolves to a `ForgeAccount`. */
export const FORGE_KINDS = ['github', 'gitea'] as const
export type ForgeKind = typeof FORGE_KINDS[number]

/**
 * The agent's account on one forge repository, which setup resolved for one forge Source instance (`id`): the forge's web,
 * API and clone addresses, the agent's login and commit email there, its CLI (which workers run as `shim`), and how git
 * gets the account's credential for `host`.
 */
export interface ForgeAccount {
  id: string
  kind: ForgeKind
  /** Host name, with a port when it is not the default, such as github.com. */
  host: string
  /** owner/name, as the forge names it now. */
  repository: string
  web: string
  api: string
  cloneUrl: string
  login: string
  commitEmail: string
  /** The resolved executable of the agent's CLI on this forge. */
  cli: string
  /** The name workers run that CLI by: gh for GitHub, tea for Gitea. */
  shim: 'gh' | 'tea'
  /** How git gets the account's credential: gh's own helper, or the token file through a dsh-superagent credential shim. */
  credential: { helper: 'gh' } | { helper: 'token-file'; path: string }
}
export interface Deployment extends Machine {
  /** The resolved forge Source instances, by instance id. */
  forges: Record<string, ForgeAccount>
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
/** The first forge account of a kind, by instance id (the kind's own instance sorts first among its ids). */
export function forgeOfKind(deployment: Pick<Deployment, 'forges'>, kind: ForgeKind): ForgeAccount | undefined {
  return Object.values(deployment.forges).filter(account => account.kind === kind).sort((a, b) => a.id === kind ? -1 : b.id === kind ? 1
    : a.id.localeCompare(b.id))[0]
}
/** Web, API and clone addresses of a GitHub host: github.com, or a GitHub Enterprise Server. */
export function githubAddresses(host: string, repository: string): Pick<ForgeAccount, 'web' | 'api' | 'cloneUrl'> {
  const web = `https://${host}`
  return { web, api: host === 'github.com' ? 'https://api.github.com' : `${web}/api/v3`, cloneUrl: `${web}/${repository}.git` }
}

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** gh's flag naming a GitHub Enterprise Server host; github.com is gh's default host, whose calls name none. */
export const hostFlag = (host: string): string[] => host === 'github.com' ? [] : ['--hostname', host]
/**
 * Verify the agent's GitHub CLI identity and push access to the repository a GitHub Source instance names, on github.com
 * or the GitHub Enterprise Server host it names.
 * @throws SetupError placed on instance `id`.
 */
export async function resolveGithub(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? '', id = 'github'): Promise<ForgeAccount> {
  const fail = (code: SetupCode, values: Record<string, string> = {}): never => { throw new SetupError(code, values, id) }
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const { host, repository: remote } = accounts
  if (!remote) fail('repositoryUnset')
  if (!accounts.cli) fail('agentCliUnset')
  let cli = ''
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { fail('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user', ...hostFlag(host)]).catch((error: unknown) => fail('agentCliSignedOut', { output: reason(error) }))
  const agent = parsed(GithubUser, text) ?? fail('agentCliNoAccount')
  // A wildcard names every repository of an owner: the owner must exist; push access is read per repository when it first notifies.
  if (remote.endsWith('/*')) {
    const owner = parsed(z.looseObject({ login: z.string() }), await probe([cli, 'api', `users/${remote.slice(0, -2)}`, ...hostFlag(host)])
      .catch((error: unknown) => fail('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })))
      ?? fail('repositoryUnreported', { repository: remote })
    const repository = `${owner.login}/*`
    return { id, kind: 'github', host, repository, ...githubAddresses(host, repository), login: agent.login,
      commitEmail: `${agent.id}+${agent.login}@users.noreply.${host}`, cli, shim: 'gh', credential: { helper: 'gh' } }
  }
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}', ...hostFlag(host)])
    .catch((error: unknown) => fail('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) }))) ?? fail('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) fail('repositoryReadOnly', { account: agent.login, repository })
  return { id, kind: 'github', host, repository, ...githubAddresses(host, repository), login: agent.login,
    commitEmail: `${agent.id}+${agent.login}@users.noreply.${host}`, cli, shim: 'gh', credential: { helper: 'gh' } }
}
/** A forge Source instance setup resolves: its id, kind and stored configuration. */
export interface ForgeInstance { id: string; kind: ForgeKind; config: unknown }
/**
 * The forge Source instances setup resolves: every enabled one, or, when none is on, the kinds' own instances, as setup has
 * always read the GitHub Source's accounts whether it was on or not.
 */
export function forgeInstances(settings: { sources: Record<string, { enabled: boolean; kind?: string | undefined; config: unknown }> }): ForgeInstance[] {
  const kinds = new Set<string>(FORGE_KINDS)
  const stored = Object.entries(settings.sources).flatMap(([id, value]) => kinds.has(value.kind ?? id)
    ? [{ id, kind: (value.kind ?? id) as ForgeKind, config: value.config, enabled: value.enabled }] : [])
  // The GitHub Source's own instance exists unstored, as it always has; another forge's instances exist once saved.
  const own = (['github'] as const).filter(kind => !settings.sources[kind]).map(kind => ({ id: kind, kind, config: {}, enabled: true }))
  const all = [...own, ...stored].sort((a, b) => a.id.localeCompare(b.id))
  const enabled = all.filter(instance => instance.enabled)
  // With none on, an installation of the GitHub Source alone still has setup read it, as it always has; one that saved another
  // forge's instance has no forge on (`noForge`), rather than a GitHub Source it switched off that names no repository.
  const legacy = stored.every(instance => instance.kind === 'github')
  return (enabled.length ? enabled : legacy ? all.filter(instance => instance.id === instance.kind) : []).map(({ id, kind, config }) => ({ id, kind, config }))
}
/** Reads a Gitea API token file: a regular file that only its owner may read, holding the token on its first line. */
export function readTokenFile(file: string): string {
  const stat = statSync(file)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`${file} must be a regular file of mode 0600 or stricter`)
  const token = readFileSync(file, 'utf8').split('\n')[0]!.trim()
  if (!token) throw new Error(`${file} holds no token`)
  return token
}
/** The HTTP client setup uses for Gitea; tests replace `fetch`. */
export type Http = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>
const GiteaUser = z.looseObject({ login: z.string().regex(/^[A-Za-z0-9_.-]+$/), id: z.number().int(), email: z.string().nullish() })
const GiteaRepository = z.looseObject({ full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  permissions: z.looseObject({ push: z.boolean().nullish() }).nullish() })
const TeaLogins = z.array(z.looseObject({ url: z.string().optional(), user: z.string().optional() }))
/** The Gitea web and API addresses of `host`. */
export function giteaAddresses(host: string, repository: string): Pick<ForgeAccount, 'web' | 'api' | 'cloneUrl'> {
  const web = `https://${host}`
  return { web, api: `${web}/api/v1`, cloneUrl: `${web}/${repository}.git` }
}
/**
 * Verify a Gitea Source instance: the token in its token file reads the agent's account and can push to the repository, and
 * its tea CLI is signed in to the same account on the same host, which workers act through.
 * @throws SetupError placed on instance `id`.
 */
export async function resolveGitea(machine: Machine, gitea: unknown, probe: Probe, path = process.env.PATH ?? '', id = 'gitea',
  http: Http = (url, init) => fetch(url, init)): Promise<ForgeAccount> {
  const values = { forge: 'Gitea' }
  const fail = (code: SetupCode, more: Record<string, string> = {}): never => { throw new SetupError(code, { ...values, ...more }, id) }
  const accounts = GiteaAccountsSchema.parse(gitea ?? {})
  const { host, repository: remote, tokenFile } = accounts
  if (!host) fail('hostUnset')
  if (!remote) fail('repositoryUnset')
  if (!tokenFile) fail('tokenFileUnset')
  if (!accounts.cli) fail('agentCliUnset')
  let cli = ''
  try { cli = executable(accounts.cli, path, workerBin(machine.stateDir)) } catch (error) { fail('agentCliMissing', { output: reason(error) }) }
  let token = ''
  try { token = readTokenFile(tokenFile) } catch (error) { fail('tokenFileUnreadable', { file: tokenFile, output: reason(error) }) }
  const { api } = giteaAddresses(host, remote)
  const get = async (resource: string) => {
    const response = await http(`${api}/${resource}`, { headers: { authorization: `token ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(60_000) })
    const body = await response.json().catch(() => undefined) as unknown
    return { status: response.status, body: response.ok ? body : undefined,
      message: response.ok ? '' : z.looseObject({ message: z.string() }).safeParse(body).data?.message ?? `HTTP ${response.status}` }
  }
  const user = await get('user').catch((error: unknown) => fail('tokenRejected', { host, file: tokenFile, output: reason(error) }))
  if (user.status === 401 || user.status === 403) fail('tokenRejected', { host, file: tokenFile })
  const agent = GiteaUser.safeParse(user.body).data ?? fail('agentCliNoAccount')
  // Polling starts from the account's notifications, which a token without the read:notification scope cannot read.
  const notifications = await get('notifications?limit=1').catch((error: unknown) => fail('tokenScopeMissing',
    { host, file: tokenFile, account: agent.login, scope: 'read:notification', output: reason(error) }))
  if (notifications.status !== 200) fail('tokenScopeMissing', { host, file: tokenFile, account: agent.login, scope: 'read:notification', output: notifications.message })
  let repository: string
  if (remote.endsWith('/*')) {
    // A wildcard names every repository of an owner, an organization or a user; push access is read per repository when it first notifies.
    const name = remote.slice(0, -2)
    const unreadable = (error: unknown): never => fail('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
    const org = await get(`orgs/${name}`).catch(unreadable)
    const owner = org.body ? org.body : (await get(`users/${name}`).catch(unreadable)).body
    const found = z.looseObject({ username: z.string().optional(), login: z.string().optional(), name: z.string().optional() }).safeParse(owner).data
    if (!found) fail('repositoryUnreadable', { account: agent.login, repository: remote, output: `HTTP ${org.status}` })
    repository = `${found!.username ?? found!.login ?? name}/*`
  } else {
    const access = await get(`repos/${remote}`).catch((error: unknown) => fail('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) }))
    if (!access.body) fail('repositoryUnreadable', { account: agent.login, repository: remote, output: `HTTP ${access.status}` })
    const repo = GiteaRepository.safeParse(access.body).data ?? fail('repositoryUnreported', { repository: remote })
    repository = repo.full_name
    if (repo.permissions?.push !== true) fail('repositoryReadOnly', { account: agent.login, repository })
  }
  // Workers act through tea, which must be signed in to the same account on this host.
  const listed = await probe([cli, 'logins', 'list', '--output', 'json']).catch((error: unknown) => fail('agentCliSignedOut', { output: reason(error) }))
  const logins = parsed(TeaLogins, listed) ?? fail('agentCliNoAccount')
  const login = logins.find(item => item.url && sameName(new URL(item.url).host, host))
  if (!login?.user) fail('agentCliSignedOut', { output: `tea has no login for ${host}` })
  if (!sameName(login!.user!, agent.login)) fail('cliAccountDiffers', { login: login!.user!, account: agent.login })
  // Gitea shows the account's own email to itself; without one, a noreply address on the host.
  const email = agent.email ? agent.email : `${agent.login}@noreply.${host}`
  return { id, kind: 'gitea', host, repository, ...giteaAddresses(host, repository), login: agent.login, commitEmail: email,
    cli, shim: 'tea', credential: { helper: 'token-file', path: tokenFile } }
}
/** Resolves one forge Source instance by its kind. */
export async function resolveForge(machine: Machine, instance: ForgeInstance, probe: Probe, path = process.env.PATH ?? '', http?: Http): Promise<ForgeAccount> {
  return instance.kind === 'gitea' ? resolveGitea(machine, instance.config, probe, path, instance.id, http)
    : resolveGithub(machine, instance.config, probe, path, instance.id)
}
/**
 * Resolves each forge Source instance, collecting each failed one's problem by instance id, and refuses two instances of a kind
 * that name different agent CLIs, since workers run one CLI per kind.
 */
export async function resolveForges(machine: Machine, instances: readonly ForgeInstance[], probe: Probe, path = process.env.PATH ?? '',
  http?: Http): Promise<{ forges: Record<string, ForgeAccount>; problems: Record<string, SetupProblem> }> {
  const forges: Record<string, ForgeAccount> = {}, problems: Record<string, SetupProblem> = {}
  for (const instance of instances) {
    try { forges[instance.id] = await resolveForge(machine, instance, probe, path, http) }
    catch (error) { if (!(error instanceof SetupError)) throw error; problems[instance.id] = error.problem }
  }
  for (const kind of FORGE_KINDS) {
    const first = forgeOfKind({ forges }, kind)
    for (const account of Object.values(forges)) {
      if (!first || account.kind !== kind || account.cli === first.cli) continue
      delete forges[account.id]
      problems[account.id] = new SetupError('forgeCliDiffers', { source: account.id, cli: account.cli, other: first.id, otherCli: first.cli,
        shim: first.shim, ...kind === 'github' ? {} : { forge: 'Gitea' } }, account.id).problem
    }
  }
  return { forges, problems }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
