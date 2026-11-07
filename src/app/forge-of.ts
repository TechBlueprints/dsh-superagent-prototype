/** Which forge repository a Ticket works on, which its execution environment, PR claims and prompts name. */
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment, ForgeAccount } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import { covers, isWildcard } from '../sources/forge-client.ts'
import { parseThreadId } from '../sources/forge-trigger.ts'

/**
 * The forge account of a Ticket's repository: the forge Source of a Thread the Ticket follows (such as the PR it opened),
 * else its origin Trigger's Source when that is a forge, else the Execution settings' `defaultForge`, else the only resolved
 * forge; none when several forges resolved and nothing names one, so the Ticket cannot claim a PR.
 */
export function forgeOf(ticket: Pick<Ticket, 'follows'>, deployment: Pick<Deployment, 'forges'>, trigger?: Pick<Trigger, 'source'> & Partial<Pick<Trigger, 'meta'>>,
  settings?: Pick<Settings, 'executor'>): ForgeAccount | undefined {
  const { forges } = deployment
  // A wildcard instance's account names one of its repositories only where a Thread id or a Trigger names it.
  const at = (account: ForgeAccount, repository: unknown): ForgeAccount | undefined => !isWildcard(account.repository) ? account
    : typeof repository === 'string' && covers(account.repository, repository)
      ? { ...account, repository, cloneUrl: `${account.web}/${repository}.git` } : undefined
  for (const follow of ticket.follows ?? []) {
    const split = follow.thread.indexOf(':')
    const account = split > 0 ? forges[follow.thread.slice(0, split)] : undefined
    const found = account && at(account, parseThreadId(follow.thread.slice(split + 1))?.repository)
    if (found) return found
  }
  if (trigger && trigger.source in forges) return at(forges[trigger.source]!, trigger.meta?.repository)
  const named = settings?.executor.defaultForge
  if (named && named in forges) return at(forges[named]!, undefined)
  const all = Object.values(forges)
  return all.length === 1 ? at(all[0]!, undefined) : undefined
}
