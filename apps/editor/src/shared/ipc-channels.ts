export const IpcChannel = {
  Ping: 'editor:ping',
  StorageGet: 'editor:storage:get',
  StorageSet: 'editor:storage:set',
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface PingResult {
  pong: true
  rendererSentAt: number
  mainReceivedAt: number
}
