/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest'
import { SessionSwitcherMainService } from '../sessionSwitcherMainService.js'
import type {
  IRendererSessionsService,
  RendererSessionSummary,
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
})
