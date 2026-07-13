/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wait for Swarm's runtime-only commands to be registered by the Perforce
 *  extension host. Restored editors can mount before onStartupFinished runs.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '@universe-editor/platform'

const DEFAULT_RETRY_DELAY_MS = 250
const DEFAULT_MAX_RETRIES = 20

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

export async function waitForSwarmCommand(
  commandId: string,
  signal?: AbortSignal,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
): Promise<boolean> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) return false
    if (CommandsRegistry.getCommand(commandId)) return true
    if (attempt < maxRetries) await delay(retryDelayMs, signal)
  }
  return false
}
