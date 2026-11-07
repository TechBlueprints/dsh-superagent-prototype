/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.ts'

/** Where a setup problem is fixed: the Deployment settings, or the card of the Source instance it names by id. */
export type SetupPlace = 'deployment' | (string & {})
/**
 * Each problem's default place and English text. A Source problem's place is the instance whose check failed, which defaults
 * to the kind's own instance named here; `{forge}` names the forge's product (GitHub unless the values say otherwise).
 */
export const SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} was not written by dsh-superagent; move it, or choose another state directory.'],
  gitTooOld: ['deployment', 'git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.'],
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
  noForge: ['deployment', 'No GitHub or Gitea Source is on; switch one on and name its repository.'],
  repositoryUnset: ['github', 'The {forge} Source names no repository.'],
  agentCliUnset: ['github', 'The agent {forge} CLI is not set.'],
  agentCliMissing: ['github', 'The agent {forge} CLI was not found.'],
  agentCliSignedOut: ['github', 'The agent {forge} CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent {forge} CLI did not report a {forge} account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent {forge} CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  forgeCliDiffers: ['github', 'The {source} Source names the agent CLI {cli}, and the {other} Source names {otherCli}; every {forge} Source uses one agent CLI, which workers run as {shim}.'],
  hostUnset: ['gitea', 'The {forge} Source names no host.'],
  tokenFileUnset: ['gitea', 'The {forge} Source names no token file.'],
  tokenFileUnreadable: ['gitea', 'The token file {file} cannot be read, or other users may read it; it must be a file of mode 0600 or stricter.'],
  tokenRejected: ['gitea', '{host} did not accept the token in {file}.'],
  cliAccountDiffers: ['gitea', 'The agent {forge} CLI acts as @{login}, and the token file reads @{account}; sign the CLI in to @{account}.'],
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  feishuBotNotReady: ['feishu', 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.'],
  feishuUserIdentity: ['feishu', 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.'],
  feishuNoBot: ['feishu', 'The Feishu bot API did not return the bot\'s open_id.'],
} as const satisfies Record<string, readonly [string, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }
/** The text of a setup problem with its values, naming GitHub as the forge unless the values name another. */
export const setupSentence = (code: SetupCode, values: Record<string, string>): string => fill(SETUP_PROBLEMS[code][1], { forge: 'GitHub', ...values })

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 * @param place - the Source instance whose check failed, for a Source problem of an instance other than the kind's own.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}, place?: string) {
    const [defaultPlace] = SETUP_PROBLEMS[code]
    const sentence = setupSentence(code, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = defaultPlace === 'deployment' ? defaultPlace : place ?? defaultPlace
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
  /** The same problem placed on Source instance `place`. */
  at(place: string): SetupError { return new SetupError(this.code, this.values, place) }
}
