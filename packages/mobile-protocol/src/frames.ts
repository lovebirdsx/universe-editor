import type { MobileErrorCode } from './errors.js'

export const MOBILE_SESSION_BUCKETS = [
  'input_needed',
  'in_progress',
  'failed',
  'completed',
] as const

export type MobileSessionBucket = (typeof MOBILE_SESSION_BUCKETS)[number]

/** Stable session key: prefer `durableId` once the agent has attached. */
export interface MobileSessionRef {
  windowId: number
  localId: string
  durableId?: string
}

/**
 * M1 minimal inbox row. M2 extends it with pending approval/question details,
 * usage, and read-only flags; keep the frame union extensible rather than
 * widening this shape ahead of time.
 */
export interface MobileSessionSummary {
  ref: MobileSessionRef
  agentId: string
  title: string
  bucket: MobileSessionBucket
  workspaceName: string
  /** Epoch milliseconds. */
  updatedAt: number
}

// Client → server

export interface HelloFrame {
  type: 'hello'
  protocolVersion: number
  /** Sent in this first frame rather than a URL query to keep it out of logs. */
  token: string
  clientVersion: string
  capabilities: string[]
}

export interface PingFrame {
  type: 'ping'
  t: number
}

export interface SubscribeInboxFrame {
  type: 'subscribe_inbox'
  /** Optimization only: reconnects always start from a snapshot. */
  afterSeq?: number
}

export interface UnsubscribeInboxFrame {
  type: 'unsubscribe_inbox'
}

export type ClientFrame = HelloFrame | PingFrame | SubscribeInboxFrame | UnsubscribeInboxFrame
export type ClientFrameType = ClientFrame['type']

// Server → client

export interface HelloOkFrame {
  type: 'hello_ok'
  protocolVersion: number
  serverVersion: string
  deviceId: string
  serverTime: number
  capabilities: string[]
}

export interface PongFrame {
  type: 'pong'
  t: number
}

export interface InboxSnapshotFrame {
  type: 'inbox_snapshot'
  seq: number
  sessions: MobileSessionSummary[]
}

export interface ServerErrorFrame {
  type: 'server_error'
  code: MobileErrorCode
  message: string
  retryable: boolean
}

export interface DeviceRevokedFrame {
  type: 'device_revoked'
}

export type ServerFrame =
  | HelloOkFrame
  | PongFrame
  | InboxSnapshotFrame
  | ServerErrorFrame
  | DeviceRevokedFrame

export type ServerFrameType = ServerFrame['type']
