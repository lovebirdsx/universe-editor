import type { PingResult } from '../shared/ipc-channels.js'

export function handlePing(rendererSentAt: number, now: () => number = Date.now): PingResult {
  return {
    pong: true,
    rendererSentAt,
    mainReceivedAt: now(),
  }
}
