/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest'
import {
  SessionSwitcherMainService,
  createWindowScopedSessionSwitcher,
} from '../sessionSwitcherMainService.js'
import type {
  IRendererSessionsService,
  RendererSessionSummary,
  SessionStatusCounts,
} from '../../../../shared/ipc/sessionSwitcher.js'

function rendererStub(
  sessions: readonly RendererSessionSummary[] | Promise<never>,
): IRendererSessionsService {
  return {
    _serviceBrand: undefined,
    listSessions: () => (sessions instanceof Promise ? sessions : Promise.resolve(sessions)),
    reveal: () => Promise.resolve(),
  }
}

const SESSION = (id: string): RendererSessionSummary => ({
  sessionId: id,
  title: `title-${id}`,
  status: 'idle',
  agentId: 'claude-code',
})

describe('SessionSwitcherMainService', () => {
  it('tags each session with windowId + workspaceName', async () => {
    const svc = new SessionSwitcherMainService()
    svc.registerWindow(1, {
      rendererSessions: rendererStub([SESSION('a')]),
      getWorkspaceName: () => 'projA',
      focus: () => {},
    })
    svc.registerWindow(2, {
      rendererSessions: rendererStub([SESSION('b'), SESSION('c')]),
      getWorkspaceName: () => 'projB',
      focus: () => {},
    })

    const all = await svc.getAllSessions()
    expect(all).toHaveLength(3)
    expect(all.find((s) => s.sessionId === 'a')).toMatchObject({
      windowId: 1,
      workspaceName: 'projA',
    })
    expect(all.find((s) => s.sessionId === 'c')).toMatchObject({
      windowId: 2,
      workspaceName: 'projB',
    })
  })

  it('skips windows whose listSessions rejects', async () => {
    const svc = new SessionSwitcherMainService()
    svc.registerWindow(1, {
      rendererSessions: rendererStub(Promise.reject(new Error('dead'))),
      getWorkspaceName: () => 'projA',
      focus: () => {},
    })
    svc.registerWindow(2, {
      rendererSessions: rendererStub([SESSION('b')]),
      getWorkspaceName: () => 'projB',
      focus: () => {},
    })

    const all = await svc.getAllSessions()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ sessionId: 'b', windowId: 2 })
  })

  it('drops unregistered windows', async () => {
    const svc = new SessionSwitcherMainService()
    svc.registerWindow(1, {
      rendererSessions: rendererStub([SESSION('a')]),
      getWorkspaceName: () => 'projA',
      focus: () => {},
    })
    svc.unregisterWindow(1)
    expect(await svc.getAllSessions()).toHaveLength(0)
  })

  it('reveal focuses the owning window and forwards to its renderer', async () => {
    const svc = new SessionSwitcherMainService()
    const focus = vi.fn()
    const reveal = vi.fn(() => Promise.resolve())
    svc.registerWindow(7, {
      rendererSessions: {
        _serviceBrand: undefined,
        listSessions: () => Promise.resolve([]),
        reveal,
      },
      getWorkspaceName: () => 'projA',
      focus,
    })

    await svc.reveal(7, 'sess-1')
    expect(focus).toHaveBeenCalledOnce()
    expect(reveal).toHaveBeenCalledWith('sess-1')
  })

  it('reveal is a no-op for an unknown window', async () => {
    const svc = new SessionSwitcherMainService()
    await expect(svc.reveal(99, 'x')).resolves.toBeUndefined()
  })

  it('aggregates counts across windows and rebroadcasts on change', async () => {
    const svc = new SessionSwitcherMainService()
    const seen: SessionStatusCounts[] = []
    svc.onDidChangeCounts((c) => seen.push(c))

    await svc.reportSessionCounts({ running: 1, ask: 0 }, 1)
    await svc.reportSessionCounts({ running: 2, ask: 1 }, 2)
    expect(await svc.getSessionCounts()).toEqual({ running: 3, ask: 1 })
    expect(seen).toEqual([
      { running: 1, ask: 0 },
      { running: 3, ask: 1 },
    ])

    await svc.reportSessionCounts({ running: 0, ask: 0 }, 1)
    expect(await svc.getSessionCounts()).toEqual({ running: 2, ask: 1 })
  })

  it('does not rebroadcast when a window re-reports identical counts', async () => {
    const svc = new SessionSwitcherMainService()
    const seen: SessionStatusCounts[] = []
    svc.onDidChangeCounts((c) => seen.push(c))

    await svc.reportSessionCounts({ running: 1, ask: 0 }, 1)
    await svc.reportSessionCounts({ running: 1, ask: 0 }, 1)
    expect(seen).toHaveLength(1)
  })

  it('drops a closed window from the aggregate and rebroadcasts', async () => {
    const svc = new SessionSwitcherMainService()
    const seen: SessionStatusCounts[] = []
    svc.onDidChangeCounts((c) => seen.push(c))

    await svc.reportSessionCounts({ running: 1, ask: 0 }, 1)
    await svc.reportSessionCounts({ running: 3, ask: 0 }, 2)
    svc.unregisterWindow(2)
    expect(await svc.getSessionCounts()).toEqual({ running: 1, ask: 0 })
    expect(seen[seen.length - 1]).toEqual({ running: 1, ask: 0 })
  })

  it('ignores a report without a windowId', async () => {
    const svc = new SessionSwitcherMainService()
    await svc.reportSessionCounts({ running: 5, ask: 5 })
    expect(await svc.getSessionCounts()).toEqual({ running: 0, ask: 0 })
  })

  it('scoped facade injects its windowId into reports', async () => {
    const svc = new SessionSwitcherMainService()
    const scoped1 = createWindowScopedSessionSwitcher(svc, 1)
    const scoped2 = createWindowScopedSessionSwitcher(svc, 2)

    await scoped1.reportSessionCounts({ running: 1, ask: 0 })
    await scoped2.reportSessionCounts({ running: 3, ask: 1 })
    expect(await scoped1.getSessionCounts()).toEqual({ running: 4, ask: 1 })
  })
})
