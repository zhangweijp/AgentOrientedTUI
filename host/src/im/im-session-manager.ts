import { EventEmitter } from 'events'
import { AOTUIError, type IDesktop } from '@aotui/runtime'
import { IMDrivenSource } from './im-driven-source.js'
import type { SourceControlsSnapshot } from '../core/source-controls.js'
import { checkCloseTasks, checkDesktopClose, rethrowAfterCleanup, rethrowAfterDesktopClose } from '../core/desktop-close.js'
import type {
  IMInboundMessage,
  IMSession,
  IMAgentDriverLike,
} from './types.js'

export interface IMCreatedAgentDriver {
  agentDriver: IMAgentDriverLike
  sourceControls?: SourceControlsSnapshot
  disposeSources?: () => void | Promise<void>
}

type ManagedIMSession = IMSession & {
  closing?: Promise<void>
  pendingSaves: Set<Promise<void>>
  disposeSources?: IMCreatedAgentDriver['disposeSources']
}
type OpeningIMSession = { completion: Promise<ManagedIMSession>; session?: ManagedIMSession; closing?: Promise<void> }

export interface IMSessionManagerOptions {
  createDesktop: (sessionKey: string) => Promise<IDesktop>
  createAgentDriver: (input: {
    sessionKey: string
    agentId: string
    desktop: IDesktop
    source: IMDrivenSource
  }) => IMAgentDriverLike | IMCreatedAgentDriver | Promise<IMAgentDriverLike | IMCreatedAgentDriver>
  createSource?: (input: { sessionKey: string }) => IMDrivenSource
  persistSession?: (session: IMSession) => void | Promise<void>
  deletePersistedSession?: (sessionKey: string) => void | Promise<void>
  now?: () => number
  maxSessions?: number
}

function parseSessionParts(sessionKey: string): { channel: string; chatType: 'direct' | 'group'; peerId: string; botIdentity?: string } {
  const parts = sessionKey.split(':')
  if (parts.length < 5) {
    return { channel: 'unknown', chatType: 'direct', peerId: 'unknown' }
  }

  if (parts.length >= 7 && parts[3] === 'bot') {
    return {
      channel: parts[2] || 'unknown',
      botIdentity: parts[4] || undefined,
      chatType: parts[5] === 'group' ? 'group' : 'direct',
      peerId: parts.slice(6).join(':') || 'unknown',
    }
  }

  return {
    channel: parts[2] || 'unknown',
    chatType: parts[3] === 'group' ? 'group' : 'direct',
    peerId: parts.slice(4).join(':') || 'unknown',
  }
}

function requireNonEmpty(value: string, fieldName: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`${fieldName} is required`)
  }
  return normalized
}

export class IMSessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedIMSession>()
  private readonly inFlight = new Map<string, OpeningIMSession>()
  private readonly now: () => number
  private readonly maxSessions: number
  private readonly options: IMSessionManagerOptions

  constructor(options: IMSessionManagerOptions) {
    super()
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.maxSessions = options.maxSessions ?? 100
  }

  getSession(sessionKey: string): IMSession | undefined {
    const session = this.sessions.get(sessionKey)
    return session?.closing || session?.desktop.isClosing ? undefined : session
  }

  ownsSource(sessionKey: string, source: IMDrivenSource): boolean {
    return this.sessions.get(sessionKey)?.source === source
  }

  async ensureSession(sessionKey: string, agentId: string): Promise<ManagedIMSession> {
    const normalizedSessionKey = requireNonEmpty(sessionKey, 'sessionKey')
    const normalizedAgentId = requireNonEmpty(agentId, 'agentId')

    const opening = this.inFlight.get(normalizedSessionKey)
    const existing = this.sessions.get(normalizedSessionKey)
    const closing = opening?.closing ?? (existing ?? opening?.session)?.closing
    if (closing) {
      await closing.catch(() => {})
      if (opening) await opening.completion.catch(() => {})
      return this.ensureSession(normalizedSessionKey, normalizedAgentId)
    }

    if (opening) return opening.completion

    if (existing) {
      try {
        if (!existing.desktop.isClosing) await this.touchSession(existing)
        if (existing.closing) return this.ensureSession(normalizedSessionKey, normalizedAgentId)
        this.assertAvailable(existing)
        return existing
      } catch (error) {
        if (existing.desktop.isClosing) return rethrowAfterCleanup(error, () => this.beginSessionClose(existing))
        throw error
      }
    }

    const creating = Promise.resolve().then(async () => {
      const active = [...this.sessions.values()].filter(session => !session.closing).length
      if (active >= this.maxSessions) await this.evictOldestSession()
      return this.createSession(normalizedSessionKey, normalizedAgentId, task)
    })
    const task: OpeningIMSession = { completion: creating.finally(() => {
      if (!task.closing) this.inFlight.delete(normalizedSessionKey)
    }) }
    this.inFlight.set(normalizedSessionKey, task)
    return task.completion
  }

  async dispatch(message: IMInboundMessage): Promise<IMSession> {
    const sessionKey = requireNonEmpty(message.sessionKey, 'sessionKey')
    const agentId = requireNonEmpty(message.agentId, 'agentId')

    let session = await this.ensureSession(sessionKey, agentId)
    while (session.closing || session.desktop.isClosing) session = await this.ensureSession(sessionKey, agentId)
    session.lastAccessTime = this.now()
    if (typeof message.accountId === 'string' && message.accountId.trim()) {
      session.accountId = message.accountId
    }
    if (typeof message.botIdentity === 'string' && message.botIdentity.trim()) {
      session.botIdentity = message.botIdentity
    }

    session.source.addMessage(
      {
        role: 'user',
        content: message.body,
      },
      message.timestamp,
    )
    await this.persistSession(session)
    console.log('[IM][SessionManager] dispatch', {
      sessionKey,
      messageId: message.messageId,
      triggerAgent: message.triggerAgent !== false,
      chatType: message.chatType,
      accountId: message.accountId,
      botIdentity: message.botIdentity,
    })
    if (!session.closing && !session.desktop.isClosing && message.triggerAgent !== false) {
      console.log('[IM][SessionManager] notifyUpdate', {
        sessionKey,
        messageId: message.messageId,
      })
      session.source.notifyUpdate()
    }

    this.emit('dispatch', { sessionKey, messageId: message.messageId })
    return session
  }

  destroySession(sessionKey: string): Promise<void> {
    const opening = this.inFlight.get(sessionKey)
    if (opening?.closing) return opening.closing
    const session = this.sessions.get(sessionKey) ?? opening?.session
    if (session) return this.beginSessionClose(session)
    if (!opening) return Promise.resolve()
    const closing = opening.completion.then(created => this.beginSessionClose(created), () => {})
      .finally(() => { this.inFlight.delete(sessionKey) })
    void closing.catch(() => {})
    return opening.closing = closing
  }

  private beginSessionClose(session: ManagedIMSession): Promise<void> {
    if (session.closing) return session.closing
    const { sessionKey } = session
    const closing = Promise.resolve().then(async () => {
      const stopped = await Promise.allSettled([Promise.resolve().then(() => session.agentDriver.stop?.())])
      const closed = await Promise.allSettled([
        Promise.resolve().then(() => session.agentDriver.dispose?.()),
        Promise.resolve().then(() => session.disposeSources?.()),
        Promise.resolve().then(async () => checkDesktopClose(await session.desktop.beginClose().completion)),
        ...session.pendingSaves,
      ])
      const ownsRow = this.sessions.get(sessionKey) === session || this.inFlight.get(sessionKey)?.session === session
      const deleted = ownsRow
        ? await Promise.allSettled([this.deletePersistedSession(sessionKey)])
        : []
      checkCloseTasks([...stopped, ...closed, ...deleted], 'IM_SESSION_CLOSE_FAILED')
    }).finally(() => {
      if (this.sessions.get(sessionKey) === session) this.sessions.delete(sessionKey)
    }).then(() => { this.emit('destroy', { sessionKey }) })
    void closing.catch(() => {})
    session.closing = closing
    return closing
  }

  async destroyAllSessions(): Promise<void> {
    const keys = new Set([...this.sessions.keys(), ...this.inFlight.keys()])
    const results = await Promise.allSettled([...keys].map(key => this.destroySession(key)))
    checkCloseTasks(results, 'IM_SESSION_CLEANUP_FAILED')
  }

  private async createSession(sessionKey: string, agentId: string, opening: OpeningIMSession): Promise<ManagedIMSession> {
    const source = this.options.createSource
      ? this.options.createSource({ sessionKey })
      : new IMDrivenSource({ sessionKey })

    const desktop = await this.options.createDesktop(sessionKey)

    let createdAgentDriver: IMAgentDriverLike | IMCreatedAgentDriver
    try {
      if (desktop.isClosing) throw new AOTUIError('DESKTOP_DISPOSED', { desktopId: desktop.id })
      createdAgentDriver = await this.options.createAgentDriver({ sessionKey, agentId, desktop, source })
    } catch (error) {
      return rethrowAfterDesktopClose(desktop, error)
    }
    const resolvedAgentDriver = 'agentDriver' in createdAgentDriver
      ? createdAgentDriver
      : { agentDriver: createdAgentDriver }

    const time = this.now()
    const parts = parseSessionParts(sessionKey)

    const session: ManagedIMSession = {
      sessionKey,
      agentId,
      channel: parts.channel,
      chatType: parts.chatType,
      peerId: parts.peerId,
      botIdentity: parts.botIdentity,
      desktop,
      agentDriver: resolvedAgentDriver.agentDriver,
      disposeSources: resolvedAgentDriver.disposeSources,
      pendingSaves: new Set(),
      source,
      sourceControls: resolvedAgentDriver.sourceControls,
      createdAt: time,
      lastAccessTime: time,
    }

    opening.session = session
    try {
      this.assertAvailable(session)
      await this.persistSession(session)
      this.assertAvailable(session)
    } catch (error) {
      return rethrowAfterCleanup(error, () => this.beginSessionClose(session))
    }
    this.sessions.set(sessionKey, session)
    return session
  }

  private assertAvailable(session: ManagedIMSession): void {
    if (session.closing || session.desktop.isClosing) throw new AOTUIError('DESKTOP_DISPOSED', { desktopId: session.desktop.id })
  }

  private async evictOldestSession(): Promise<void> {
    let oldest: ManagedIMSession | undefined

    for (const candidate of this.sessions.values()) {
      if (!candidate.closing && (!oldest || candidate.lastAccessTime < oldest.lastAccessTime)) {
        oldest = candidate
      }
    }

    if (!oldest) {
      return
    }

    await this.beginSessionClose(oldest).catch(error => console.error('[IM] Failed to evict session', { sessionKey: oldest.sessionKey, error }))
  }

  private async touchSession(session: ManagedIMSession): Promise<void> {
    session.lastAccessTime = this.now()
    await this.persistSession(session)
  }

  private persistSession(session: ManagedIMSession): Promise<void> {
    if (!this.options.persistSession || session.closing) return Promise.resolve()
    const saving = Promise.resolve().then(() => this.options.persistSession?.(session))
    session.pendingSaves.add(saving)
    return saving.finally(() => { session.pendingSaves.delete(saving) })
  }

  private async deletePersistedSession(sessionKey: string): Promise<void> {
    if (!this.options.deletePersistedSession) {
      return
    }

    await Promise.resolve(this.options.deletePersistedSession(sessionKey))
  }
}
