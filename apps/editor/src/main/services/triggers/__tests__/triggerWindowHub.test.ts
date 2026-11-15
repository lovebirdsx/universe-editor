/*---------------------------------------------------------------------------------------------
 *  Tests for TriggerWindowHub ready acknowledgements. A forward IPC ack cannot
 *  identify its caller, so the per-window channel must stamp the sender; a plain
 *  workspace-name ack must never mark another window of the same workspace.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { URI, type ILogger } from '@universe-editor/platform'
import type { ITriggerRunHost } from '../../../../shared/ipc/triggerService.js'
import { TriggerWindowHub } from '../triggerWindowHub.js'

const WORKSPACE = URI.file('X:/workspace')

function host(): ITriggerRunHost {
  return {
    _serviceBrand: undefined,
    startRun: vi.fn(async () => ({ sessionId: 'session-1' })),
    cancelRun: vi.fn(async () => undefined),
    isWorkspaceTrusted: vi.fn(async () => true),
  }
}

function createHub(onHostReady = vi.fn()): TriggerWindowHub {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ILogger
  return new TriggerWindowHub({
    logger,
    hostWaitTimeoutMs: 10,
    hostWaitPollMs: 1,
    isRemoteIoAllowed: () => true,
    failRunsForWindow: () => undefined,
    onWorkspaceFolder: () => undefined,
    onHostRegistered: () => undefined,
    onHostReady,
    onWindowFoldersChanged: () => undefined,
  })
}

describe('TriggerWindowHub ready ack', () => {
  it('marks only the acknowledging window when two windows share a workspace', () => {
    const hub = createHub()
    hub.registerHost(1, host(), WORKSPACE)
    hub.registerHost(2, host(), WORKSPACE)
    expect(hub.isHostReady(1)).toBe(false)
    expect(hub.isHostReady(2)).toBe(false)

    hub.markHostReady(WORKSPACE.toString(), 1)
    expect(hub.isHostReady(1)).toBe(true)
    expect(hub.isHostReady(2)).toBe(false)

    hub.markHostReady(WORKSPACE.toString(), 2)
    expect(hub.isHostReady(2)).toBe(true)
  })

  it('ignores an ack stamped with a window that has no registered host', () => {
    const hub = createHub()
    hub.registerHost(1, host(), WORKSPACE)

    hub.markHostReady(WORKSPACE.toString(), 99)
    expect(hub.isHostReady(99)).toBe(false)
  })

  it('does not broadcast an unidentified ack to multiple same-workspace windows', () => {
    const hub = createHub()
    hub.registerHost(1, host(), WORKSPACE)
    hub.registerHost(2, host(), WORKSPACE)

    hub.markHostReady(WORKSPACE.toString())
    expect(hub.isHostReady(1)).toBe(false)
    expect(hub.isHostReady(2)).toBe(false)
  })

  it('marks a sole same-workspace window for backward-compatible direct callers', () => {
    const onHostReady = vi.fn()
    const hub = createHub(onHostReady)
    hub.registerHost(1, host(), WORKSPACE)

    hub.markHostReady(WORKSPACE.toString())
    expect(hub.isHostReady(1)).toBe(true)
    expect(onHostReady).toHaveBeenCalledTimes(1)
  })
})
