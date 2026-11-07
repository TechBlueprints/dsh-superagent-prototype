/** Which forge repository a Ticket works on, which its execution environment, PR claims and prompts name. */
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment, ForgeAccount } from '../deployment.ts'
import type { Settings } from '../policy.ts'

/**
 * The forge account of a Ticket's repository: the forge Source of a Thread the Ticket follows (such as the PR it opened),
 * else its origin Trigger's Source when that is a forge, else the Execution settings' `defaultForge`, else the only resolved
 * forge; none when several forges resolved and nothing names one, so the Ticket cannot claim a PR.
 */
export function forgeOf(ticket: Pick<Ticket, 'follows'>, deployment: Pick<Deployment, 'forges'>, trigger?: Pick<Trigger, 'source'>,
  settings?: Pick<Settings, 'executor'>): ForgeAccount | undefined {
  const { forges } = deployment
  const followed = (ticket.follows ?? []).map(follow => follow.thread.slice(0, Math.max(0, follow.thread.indexOf(':'))))
    .find(source => source in forges)
  if (followed) return forges[followed]
  if (trigger && trigger.source in forges) return forges[trigger.source]
  const named = settings?.executor.defaultForge
  if (named && named in forges) return forges[named]
  const all = Object.values(forges)
  return all.length === 1 ? all[0] : undefined
}
