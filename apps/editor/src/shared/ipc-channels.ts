export const IpcChannel = {
  Ping: 'editor:ping',
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface PingResult {
  pong: true
  rendererSentAt: number
  mainReceivedAt: number
}
