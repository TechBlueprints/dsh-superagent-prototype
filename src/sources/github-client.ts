/** GitHub REST calls through the agent's gh for one GitHub Source instance's repository, on github.com or a GitHub Enterprise Server. */
import { z } from 'zod'
import { hostFlag, type ForgeAccount } from '../deployment.ts'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'

/**
 * Calls the GitHub API with the agent's gh, restricted to the repository of one forge account. A GitHub Enterprise Server
 * host is named with `--hostname`, after the path and flags so the arguments for github.com stay as gh has always been called.
 * Failures are `CliError`s whose `code` is GitHub's HTTP status.
 */
export class GithubClient {
  constructor(readonly commands: Commands, readonly account: ForgeAccount) {}
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
