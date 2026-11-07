import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Commands } from '../src/infra/commands.ts'
import { GithubClient, githubClient } from '../src/sources/github-client.ts'
import { testDeployment, testForge } from './fixtures/deployment.ts'

afterEach(() => { vi.restoreAllMocks() })
const corp = testForge({ id: 'github-corp', host: 'ghe.example.com', repository: 'corp/app', web: 'https://ghe.example.com',
  api: 'https://ghe.example.com/api/v3', cli: '/opt/gh-corp' })
const deployment = testDeployment({ forges: { github: testForge(), 'github-corp': corp } })
const commands = new Commands(() => deployment, {}, new AbortController().signal)

it('calls gh as it always has for github.com, and names a GitHub Enterprise Server host after the path and flags', async () => {
  const run = vi.spyOn(commands, 'run').mockResolvedValue('{"number":3}')
  await githubClient(commands, 'github').api(z.unknown(), 'issues/3')
  expect(run).toHaveBeenLastCalledWith('/bin/false', ['api', 'repos/acme/widgets/issues/3'])
  await githubClient(commands, 'github-corp').api(z.unknown(), 'issues/3', '--method', 'GET')
  expect(run).toHaveBeenLastCalledWith('/opt/gh-corp', ['api', 'repos/corp/app/issues/3', '--method', 'GET', '--hostname', 'ghe.example.com'])
  run.mockResolvedValue('[[{"id":1}]]')
  await githubClient(commands, 'github-corp').pages(z.unknown(), 'issues/3/comments')
  expect(run).toHaveBeenLastCalledWith('/opt/gh-corp', ['api', 'repos/corp/app/issues/3/comments', '--paginate', '--slurp', '--hostname', 'ghe.example.com'])
  run.mockResolvedValue('raw')
  expect(await githubClient(commands, 'github-corp').api('contents/README.md', '-H', 'Accept: application/vnd.github.raw')).toBe('raw')
  expect(run).toHaveBeenLastCalledWith('/opt/gh-corp', ['api', 'repos/corp/app/contents/README.md', '-H', 'Accept: application/vnd.github.raw', '--hostname', 'ghe.example.com'])
})
it('stays inside its repository and refuses an instance setup did not resolve', async () => {
  const run = vi.spyOn(commands, 'run')
  for (const path of ['../other/repo/issues', '/repos/x/y', 'https://ghe.example.com/x']) {
    await expect(new GithubClient(commands, corp).api(z.unknown(), path)).rejects.toThrow('restricted to the configured repository')
  }
  expect(run).not.toHaveBeenCalled()
  expect(() => githubClient(commands, 'github-missing')).toThrow('has no GitHub account')
})
