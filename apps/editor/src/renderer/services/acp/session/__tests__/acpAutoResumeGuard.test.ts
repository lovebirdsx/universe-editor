/*---------------------------------------------------------------------------------------------
 *  Tests for shouldPauseAcpAutoResume — the crash-loop guard that pauses the
 *  automatic session restore when this window's renderer recently died of OOM.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IWindowRenderCrashInfo, IWindowsService } from '@universe-editor/platform'
import { shouldPauseAcpAutoResume } from '../acpAutoResumeGuard.js'

function stubWindows(crash: IWindowRenderCrashInfo | null | Error): IWindowsService {
  return {
    _serviceBrand: undefined,
    onDidChangeWindows: () => ({ dispose: () => {} }),
    getWindows: async () => [],
    isCurrentWindowFirst: async () => true,
    getCurrentWindowId: async () => 1,
    getFocusedWindowId: async () => 1,
    onDidChangeFocusedWindow: () => ({ dispose: () => {} }),
    getLastRenderCrash:
      crash instanceof Error ? async () => Promise.reject(crash) : async () => crash,
    focusWindow: async () => {},
    openWindow: async () => {},
    quit: async () => {},
  }
}

describe('shouldPauseAcpAutoResume', () => {
  const NOW = 10_000_000

  it('pauses when the window OOMed within the last 5 minutes', async () => {
    const crash: IWindowRenderCrashInfo = { reason: 'oom', at: NOW - 60_000 }
    await expect(shouldPauseAcpAutoResume(stubWindows(crash), NOW)).resolves.toBe(true)
  })

  it('does not pause for a non-oom crash', async () => {
    const crash: IWindowRenderCrashInfo = { reason: 'crashed', at: NOW - 60_000 }
    await expect(shouldPauseAcpAutoResume(stubWindows(crash), NOW)).resolves.toBe(false)
  })

  it('does not pause for an oom crash older than 5 minutes', async () => {
    const crash: IWindowRenderCrashInfo = { reason: 'oom', at: NOW - 6 * 60_000 }
    await expect(shouldPauseAcpAutoResume(stubWindows(crash), NOW)).resolves.toBe(false)
  })

  it('does not pause when the window never crashed', async () => {
    await expect(shouldPauseAcpAutoResume(stubWindows(null), NOW)).resolves.toBe(false)
  })

  it('fails open (no pause) when the query rejects', async () => {
    await expect(shouldPauseAcpAutoResume(stubWindows(new Error('ipc down')), NOW)).resolves.toBe(
      false,
    )
  })
})
