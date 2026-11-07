/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, ForgeAccount, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
/** The GitHub Source's account on acme/widgets at github.com, as setup resolves it. */
export const testForge = (overrides: Partial<ForgeAccount> = {}): ForgeAccount => ({
  id: 'github', kind: 'github', host: 'github.com', repository: 'acme/widgets', web: 'https://github.com', api: 'https://api.github.com',
  cloneUrl: 'https://github.com/acme/widgets.git', login: 'agent-bot', commitEmail: '7+agent-bot@users.noreply.github.com', cli: '/bin/false',
  shim: 'gh', credential: { helper: 'gh' }, ...overrides,
} as ForgeAccount)
/** @param overrides - `forge` changes the GitHub Source's account; `forges` replaces every forge account. */
export const testDeployment = (overrides: Partial<Deployment> & { forge?: Partial<ForgeAccount> } = {}): Deployment => {
  const { forge, ...rest } = overrides
  return {
    ...testMachine(), forges: { github: testForge(forge) },
    feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
    ...rest,
  }
}
