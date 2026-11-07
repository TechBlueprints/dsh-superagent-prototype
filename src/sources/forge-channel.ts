/** Forge outbound channel: posts Issue/PR comments and review thread replies under the agent account of the Channel's Source instance. */
import type { OutboundMessage } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { forgeStatus } from './forge-client.ts'
import { conventionsOf, forgeClient } from './forge.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/** True when an Issue is permanently deleted (410) or locked (403); 404 is retried because it can indicate temporary permission loss on a private repo. */
const gone = (error: unknown): boolean => { const status = forgeStatus(error); return status === 410 || (status === 403 && /locked/i.test((error as Error).message)) }
/** Posts a comment or review-thread reply with an embedded HTML marker so retries do not create duplicate comments. */
export async function sendForge(host: Pick<SourceContext, 'commands'> & { instance: string }, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const client = forgeClient(host.commands, host.instance)
  const { repository, login } = client.account
  const number = Number(message.channel.address.number)
  if (!number) throw new Error(`Missing ${client.conventions.product} reply target`)
  try {
    // Retained trigger URLs also route replies queued before thread-aware delivery.
    const address = client.conventions.address(message.channel.address.url ?? '', repository)
    let rootId: number | undefined
    if (address?.pr && address.discussion && address.number === number) {
      // Fall back to a top-level PR comment if the target inline review comment was deleted.
      const source = await client.reviewComment(number, address.discussion)
      rootId = source ? source.in_reply_to_id ?? source.id : undefined
    }
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const mine = (comment: { body?: string | null | undefined; user?: { login: string } | null | undefined }) =>
      sameName(comment.user?.login ?? '', login) && (comment.body ?? '').includes(marker)
    if ((await client.posted(number, rootId)).some(mine)) return 'sent'
    await client.post(number, `${message.text}\n\n${marker}`, rootId)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** The page and label of a forge Channel's address on instance `instance`, with no page while its account is not resolved. */
export function forgeLink(address: Record<string, string>, links: ChannelLinks, instance: string, product: string): ChannelLink {
  const number = address.number ?? ''
  const forge = links.forges?.[instance]
  const conventions = forge && conventionsOf(forge)
  const review = !!forge && !!conventions?.address(address.url ?? '', forge.repository)?.discussion
  return { url: address.url ?? (forge && conventions ? conventions.page(forge.repository, Number(number)) : ''),
    label: review ? { zh: `${product} #${number} 的 review 讨论`, en: `Review discussion on ${product} #${number}` }
      : { zh: `${product} #${number}`, en: `${product} #${number}` } }
}
