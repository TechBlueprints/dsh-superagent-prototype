/**
 * Operator requests: a Trigger the operator (or a tool acting for one, such as a chat gateway) sends through the Management
 * API on behalf of a person, `requested_by`, on a forge Source instance, optionally on one of its Issues or pull requests.
 * The Policy treats it as that person's message to the agent: explicit when the person is on the Source's `allowed` list,
 * else as the Source's admission table says for a sender off the list who addresses the agent.
 */
import { z } from 'zod'
import { key, type ReceiveResult, type Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import { allowedSender, type Settings } from '../policy.ts'
import { covers, isWildcard } from '../sources/forge-client.ts'
import { forgeClient } from '../sources/forge.ts'
import { forgeChannel, forgeThreadId } from '../sources/forge-trigger.ts'
import type { SourceRegistry } from '../sources/registry.ts'

export const OperatorRequestSchema = z.object({
  source: z.string().regex(/^[a-z][a-z0-9-]*$/).describe('The forge Source instance id, such as github or gitea'),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional()
    .describe('owner/name: required with number on a wildcard (owner/*) Source, else the Source\'s own when given'),
  number: z.number().int().positive().optional().describe('The Issue or pull request the request is about; replies go there'),
  text: z.string().trim().min(1).max(20000),
  requested_by: z.string().trim().min(1).max(200).describe('The account on the Source of the person the request is from'),
  request_id: z.string().regex(/^[\w.:-]{1,100}$/).optional().describe('Makes a repeated request one Trigger'),
}).strict()
export type OperatorRequest = z.infer<typeof OperatorRequestSchema>
export interface OperatorHost {
  readonly deployment: Deployment
  readonly commands: Commands
  readonly sources: Pick<SourceRegistry, 'instance'>
  settings(): Settings
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
}
/**
 * Builds and receives the Trigger of an operator request. On an Issue or pull request, the Trigger joins its Thread and replies
 * go there; without one, it starts a Thread of its own (`<source>:operator:<id>`), which has no Channel.
 * @throws when the Source is not an enabled forge instance, or the Issue or pull request cannot be read.
 */
export async function operatorTrigger(host: OperatorHost, request: OperatorRequest, now = new Date().toISOString()) {
  const { source, number, text, requested_by: requestedBy } = request
  const instance = host.sources.instance(source)
  const account = host.deployment.forges[source]
  if (!instance?.enabled || !account) throw new Error(`${source} is no forge Source that is on and set up`)
  const wildcard = isWildcard(account.repository)
  const repository = request.repository ?? (wildcard ? undefined : account.repository)
  if (number !== undefined && (!repository || !covers(account.repository, repository))) {
    throw new Error(wildcard ? `Name one of the ${account.repository} repositories as repository` : `The ${source} Source watches ${account.repository}`)
  }
  const requestId = request.request_id ?? key(now, requestedBy, text)
  const id = key('operator', source, requestId)
  const at = { source, id: `operator:${requestId}` }
  let place: Partial<Trigger> & Pick<Trigger, 'threads'> = { threads: [at] }
  let meta: Record<string, unknown> = { kind: 'operator', requestedBy }
  if (number !== undefined) {
    const client = forgeClient(host.commands, source)
    const issue = await (wildcard ? client.forRepository(repository!) : client).issue(number)
    const named = wildcard ? repository : undefined
    place = { threads: [{ source, id: forgeThreadId(number, named) }], channel: forgeChannel(source, number, issue.html_url, named), url: issue.html_url }
    meta = { ...meta, number, isPr: !!issue.pull_request, ...named ? { repository: named } : {} }
  }
  const trigger: Trigger = { id, source, ...place, actor: { source, id: requestedBy }, human: true, at: now, text, addressed: 'direct', meta } as Trigger
  const received = await host.receive(trigger)
  return { trigger_id: id, thread: `${trigger.threads[0]!.source}:${trigger.threads[0]!.id}`, received,
    sender: { source, id: requestedBy, listed: !!allowedSender(host.settings(), { source, id: requestedBy }) } }
}
