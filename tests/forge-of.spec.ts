import { expect, it } from 'vitest'
import { forgeOf } from '../src/app/forge-of.ts'
import { forgeValues } from '../src/app/execution-environment.ts'
import { sessionMarker } from '../src/app/sessions.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { testForge } from './fixtures/deployment.ts'

const github = testForge(), gitea = testForge({ id: 'gitea', kind: 'gitea' as never, host: 'git.example.com', repository: 'home/app',
  api: 'https://git.example.com/api/v1', web: 'https://git.example.com', cloneUrl: 'https://git.example.com/home/app.git', shim: 'tea' as never })
const settings = (defaultForge = '') => ({ executor: ExecutorConfigSchema.parse({ defaultForge }) })

it('names a ticket\'s repository by the forge thread it follows, then its origin, then the default forge, then the only forge', () => {
  const forges = { github, gitea }
  expect(forgeOf({ follows: [{ thread: 'feishu:oc_1:om_1', own: false }, { thread: 'gitea:7', own: true }] }, { forges }, { source: 'github' })).toBe(gitea)
  expect(forgeOf({}, { forges }, { source: 'github' })).toBe(github)
  // A ticket from Feishu works where the Execution settings say, or nowhere while several forges are on.
  expect(forgeOf({}, { forges }, { source: 'feishu' }, settings('gitea'))).toBe(gitea)
  expect(forgeOf({}, { forges }, { source: 'feishu' }, settings('gitea-gone'))).toBeUndefined()
  expect(forgeOf({}, { forges }, { source: 'feishu' })).toBeUndefined()
  expect(forgeOf({}, { forges: { gitea } }, { source: 'feishu' })).toBe(gitea)
})
it('fills the forge variables of a ticket on its forge, with the number and head of its origin there only', () => {
  const trigger = { threads: [{ source: 'gitea', id: '7' }], meta: { number: 7, isPr: true } }
  expect(forgeValues(gitea, trigger as never)).toEqual({ DSH_SUPERAGENT_FORGE: 'gitea', DSH_SUPERAGENT_FORGE_SOURCE: 'gitea',
    DSH_SUPERAGENT_FORGE_HOST: 'git.example.com', DSH_SUPERAGENT_FORGE_API: 'https://git.example.com/api/v1', DSH_SUPERAGENT_FORGE_CLI: 'tea',
    DSH_SUPERAGENT_REPOSITORY: 'home/app', DSH_SUPERAGENT_REPOSITORY_URL: 'https://git.example.com/home/app.git', DSH_SUPERAGENT_ACCOUNT: 'agent-bot',
    DSH_SUPERAGENT_COMMIT_EMAIL: '7+agent-bot@users.noreply.github.com', DSH_SUPERAGENT_NUMBER: '7', DSH_SUPERAGENT_PR_HEAD: 'refs/pull/7/head' })
  expect(forgeValues(github, trigger as never)).toMatchObject({ DSH_SUPERAGENT_NUMBER: '', DSH_SUPERAGENT_PR_HEAD: '' })
  expect(forgeValues(undefined)).toEqual({})
})
it('names each Session on the first line of its system prompt, with - for what it has none of', () => {
  expect(sessionMarker('main')).toBe('[dsh-superagent session role=main ticket=- name=-]')
  expect(sessionMarker('worker', { id: 'k3x9', execution: { name: 'fix-login', directory: '/w', assignment: '' } }))
    .toBe('[dsh-superagent session role=worker ticket=k3x9 name=fix-login]')
  expect(sessionMarker('worker', { id: 'k3x9' })).toBe('[dsh-superagent session role=worker ticket=k3x9 name=-]')
  // A value that would break the line's shape is left out.
  expect(sessionMarker('worker', { id: 'a b]', execution: { name: '', directory: '', assignment: '' } })).toBe('[dsh-superagent session role=worker ticket=- name=-]')
})
