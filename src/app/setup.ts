/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, setupValues, forgeInstances, resolveForge, resolveForges, resolveFeishuBot, workerProbe, type Deployment, type ForgeKind,
  type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

/**
 * What setup reads of the settings: each Source instance's setup fields (`SETUP_FIELDS` of its kind) by instance id, the
 * kinds' own instances whether stored or not, and which forge instances setup resolves.
 */
const setupFields = (settings: Settings) => {
  const ids = [...new Set([...Object.keys(SETUP_FIELDS), ...Object.keys(settings.sources)])].sort()
  const fields = ids.flatMap(id => {
    const kind = settings.sources[id]?.kind ?? id, keys = SETUP_FIELDS[kind]
    const values = setupValues(kind, settings.sources[id]?.config)
    return keys ? [[id, kind, ...keys.map(key => values[key] ?? '')]] : []
  })
  return JSON.stringify([fields, forgeInstances(settings).map(instance => instance.id)])
}
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  /** The problem that keeps setup from completing, which stops every Source. */
  problem?: SetupProblem
  /** Why a Source instance's account did not resolve though the rest of setup went on, by instance id; that instance is paused. */
  readonly problems: Record<string, SetupProblem> = {}
  /** Why the Feishu bot is unavailable even though the Feishu Source names a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.problems.feishu }
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`problems` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !Object.keys(this.problems).length) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const id = block.slice('source:'.length), stored = settings.sources[id]
    const kind = stored?.kind ?? id
    // A switched-off forge instance is not resolved, so its accounts are checked when it is switched on.
    const forge = forgeInstances(settings).find(instance => instance.id === id)
    const check = kind === 'feishu' ? resolveFeishuBot(machine, stored?.config, this.probe())
      : forge ? resolveForge(machine, forge, this.probe()) : stored?.enabled === false ? Promise.resolve()
        : SETUP_FIELDS[kind] ? resolveForge(machine, { id, kind: kind as ForgeKind, config: stored?.config }, this.probe()) : Promise.resolve()
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === id) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const instances = forgeInstances(settings)
    const { forges, problems } = await resolveForges(machine, instances, probe)
    // Without any forge, nothing can be worked on: the first forge's problem (or that none is on) stops setup.
    if (!Object.keys(forges).length) {
      const first = instances.map(instance => problems[instance.id]).find(problem => problem !== undefined)
      throw first ? new SetupError(first.code, first.values, first.place) : new SetupError('noForge')
    }
    for (const [id, problem] of Object.entries(problems)) {
      this.problems[id] = problem
      context.logger.warn('dsh-superagent leaves the %s Source out: %s', id, problem.detail)
    }
    const deployment = { ...machine, forges }
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.problems.feishu = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
