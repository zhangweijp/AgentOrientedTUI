import type { IDesktop } from '@aotui/runtime'
import type { SourceControlsSnapshot } from '../core/source-controls.js'
import type { IMDrivenSource } from './im-driven-source.js'

export type ChatType = 'direct' | 'group'
export type IMSessionScope = 'peer' | 'peer_sender' | 'peer_thread' | 'peer_thread_sender'

export interface IMRoutingConfig {
  agents?: {
    activeAgentId?: string | null
  }
  im?: {
    channels?: Record<string, {
      botAgentId?: string
      accounts?: Record<string, {
        botAgentId?: string
      }>
    }>
  }
}

export interface ResolveIMRouteParams {
  config: IMRoutingConfig
  channel: string
  chatType: ChatType
  peerId: string
  accountId?: string
  botIdentity?: string
}

export interface ResolveIMRouteResult {
  agentId: string
  sessionKey: string
}

export interface IMInboundMessage {
  sessionKey: string
  agentId: string
  channel: string
  chatType: ChatType
  peerId: string
  botIdentity?: string
  sessionScope?: IMSessionScope
  body: string
  messageId: string
  senderId: string
  chatId: string
  rootId?: string
  timestamp: number
  wasMentioned?: boolean
  triggerAgent?: boolean
  senderName?: string
  accountId?: string
}

export interface IMAgentDriverLike {
  stop?: () => void | Promise<void>
  dispose?: () => void | Promise<void>
}

export interface IMSession {
  sessionKey: string
  agentId: string
  channel: string
  chatType: ChatType
  peerId: string
  botIdentity?: string
  accountId?: string
  sourceControls?: SourceControlsSnapshot
  desktop: IDesktop
  agentDriver: IMAgentDriverLike
  source: IMDrivenSource
  createdAt: number
  lastAccessTime: number
}
