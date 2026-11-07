/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, FollowUpsSchema, type Settings } from '../policy.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'

type Stored = Settings['sources'][string]
/**
 * The health entry name of a kind's entry `name` on instance `id`: the declared name on the kind's own instance (the one
 * whose id is the kind's id), else `<id>` for the entry named after the kind and `<id>:<name>` for its other entries.
 */
export const instanceHealth = (kind: string, id: string, name: string): string => id === kind ? name : name === kind ? id : `${id}:${name}`
/** The kind of a stored Source instance: its `kind`, or its id when it names none (as the kinds' own instances do). */
export const kindOf = (id: string, settings: Pick<Settings, 'sources'>): string => settings.sources[id]?.kind ?? id
/**
 * Whether `id` may name a further instance of `kind`: the kind admits several (`multiple`), and the id starts with the
 * kind's id and a hyphen, so no instance's health entries or keys meet another kind's or dsh-superagent's own.
 */
export const instanceIdAllowed = (kind: Pick<SourceKind, 'kind' | 'multiple'>, id: string): boolean =>
  id === kind.kind || (!!kind.multiple && id.startsWith(`${kind.kind}-`) && /^[a-z][a-z0-9-]*[a-z0-9]$/.test(id))

/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * A kind has its own instance, whose id is the kind's id, and a kind that admits several (`multiple`) also has each stored
 * instance naming it as `kind`; Triggers, Threads, Channels, Policy parts and health entries name the instance id.
 * Claims each registered kind's health entries on HealthBoard for every instance and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /**
   * Registers a SourceKind, claims its health entries on HealthBoard for each of its instances the settings hold now
   * (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. An instance added later gets its
   * entries when the kind registers again, which the restart after saving a new instance does.
   */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    const release = () => { for (const [name, entry] of entries) { entry.release(); this.health.delete(name) } }
    for (const name of kind.health) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    // A further instance whose entry another part already reports goes without health rather than refusing the kind.
    for (const id of this.idsOf(kind as unknown as SourceKind).slice(1)) {
      for (const name of kind.health.map(entry => instanceHealth(kind.kind, id, entry))) {
        try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
        catch { /* Left without this entry. */ }
      }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => { this.kinds.delete(kind.kind); release(); unregistered() }
  }
  /**
   * Returns the active health entries for `names`. A Source context writes through the entries it received when built,
   * so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
  }
  /** The health entry names of instance `id`, in its kind's order; none for an instance whose kind is not installed. */
  healthNames(id: string, settings = this.settings()): string[] {
    const kind = this.kindFor(id, settings)
    return kind ? kind.health.map(name => instanceHealth(kind.kind, id, name)) : []
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  /** The installed kind of instance `id` (`undefined` when it is not installed or names no instance). */
  kindFor(id: string, settings = this.settings()): SourceKind | undefined {
    const kind = this.kinds.get(kindOf(id, settings))
    return kind && (id === kind.kind || settings.sources[id] !== undefined) ? kind : undefined
  }
  /** The ids of a kind's instances: its own, then the stored instances naming it, by id. */
  instancesOf(kind: string, settings = this.settings()): string[] {
    const registered = this.kinds.get(kind)
    return registered ? this.idsOf(registered, settings) : []
  }
  /** Every registered kind's instances ordered by kind and then id (each kind's own first), followed by stored instances whose kind is not installed (with their config kept as stored). */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const installed = [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind))
      .flatMap(kind => this.idsOf(kind, settings).map(id => ({ ...this.resolve(kind, id, settings.sources[id]), installed: true })))
    const listed = new Set(installed.map(instance => instance.id))
    const orphaned = Object.entries(settings.sources).filter(([id]) => !listed.has(id))
      .map(([id, stored]) => ({ id, kind: stored.kind ?? id, enabled: stored.enabled, config: stored.config, installed: false }))
    return [...installed, ...orphaned]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const kind = this.kindFor(id, settings)
    return kind ? this.resolve(kind, id, settings.sources[id]) as SourceInstance<C> : undefined
  }
  /**
   * Validates a submitted instance with its kind's schema: the kind `value` names, else the stored instance's, else the id's.
   * @throws when that kind is not installed, or `id` cannot name one of its instances (`instanceIdAllowed`).
   */
  validate(id: string, value: { enabled: boolean; kind?: string | undefined; config: unknown }, settings = this.settings()):
    { enabled: boolean; kind?: string; config: Record<string, unknown> } {
    const name = value.kind ?? kindOf(id, settings)
    const kind = this.kinds.get(name)
    if (!kind) throw new Error(`Source kind not installed: ${name}`)
    if (!instanceIdAllowed(kind, id)) throw new Error(`${id} cannot name an instance of the ${kind.kind} Source`)
    return { enabled: value.enabled, ...id !== kind.kind ? { kind: kind.kind } : {}, config: kind.schema.parse(value.config) }
  }
  /** Validates each Source's part of a submitted Policy against its instance's kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    const settings = this.settings()
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kinds.get(kindOf(id, settings))?.policy
      // `admission` and `followUps` are validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, followUps, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}),
        ...followUps === undefined ? {} : { followUps: FollowUpsSchema.parse(followUps) } } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kindFor(id, settings)?.policy
    if (!policy) return undefined
    const { admission, followUps, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    const follow = FollowUpsSchema.safeParse(followUps).data
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {},
      ...follow ? { followUps: follow } : {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kindFor(channel.source, settings)
    if (!kind) return false
    const instance = this.resolve(kind, channel.source, settings.sources[channel.source])
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  /** The kinds with environment variables and an enabled instance, each with its first enabled instance's id and configuration. */
  environments(settings = this.settings()) {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => {
      const instance = this.idsOf(kind, settings).map(id => this.resolve(kind, id, settings.sources[id])).find(item => item.enabled)
      return kind.environment && instance ? [{ kind, environment: kind.environment, config: instance.config, instance: instance.id }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kindFor(message.channel.source)
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands, instance: message.channel.source }, message) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.kindFor(channel.source)?.channel?.link(channel.address, links, channel.source)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const settings = this.settings()
    const found = [...this.kinds.values()].flatMap(kind => kind.find
      ? this.idsOf(kind, settings).map(id => kind.find!(query, id, this.resolve(kind, id, settings.sources[id]).config)) : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kindFor(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kindFor(trigger.source, settings)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const { config } = this.resolve(kind, trigger.source, settings.sources[trigger.source])
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kindFor(input.source, settings)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.resolve(kind, input.source, stored)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  private idsOf(kind: SourceKind, settings = this.settings()): string[] {
    const further = kind.multiple ? Object.entries(settings.sources)
      .filter(([id, stored]) => id !== kind.kind && stored.kind === kind.kind && instanceIdAllowed(kind, id)).map(([id]) => id).sort() : []
    return [kind.kind, ...further]
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(kind: SourceKind, id: string, stored: Stored | undefined): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
