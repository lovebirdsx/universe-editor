export const IpcChannel = {
  Ping: 'editor:ping',
  StorageGet: 'editor:storage:get',
  StorageSet: 'editor:storage:set',
  WindowMinimize: 'editor:window:minimize',
  WindowMaximize: 'editor:window:maximize',
  WindowClose: 'editor:window:close',
  WindowIsMaximized: 'editor:window:isMaximized',
  WindowMaximizeChange: 'editor:window:maximizeChange',
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface PingResult {
  pong: true
  rendererSentAt: number
  mainReceivedAt: number
}
