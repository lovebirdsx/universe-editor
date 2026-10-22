/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  sideTaskRemoval tests — confirmation gating and the best-effort cascade shared
 *  by the SideTasksBar popover and the Open Side Task quick pick.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  ConfigurationTarget,
  type IConfigurationService,
  type IConfirmOptions,
  type IDialogService,
} from '@universe-editor/platform'
import { confirmSideTaskRemoval, deleteSideTasks } from '../sideTaskRemoval.js'
import type { IAcpSession, IAcpSessionService } from '../acpSessionService.js'
import type { IAcpSessionHistoryService } from '../acpSessionHistory.js'

function makeDialog(result: { confirmed: boolean; neverAskAgain?: boolean }) {
  const confirm = vi.fn(async (_options: IConfirmOptions) => ({
    confirmed: result.confirmed,
    choice: result.confirmed ? ('primary' as const) : ('cancel' as const),
    neverAskAgain: result.neverAskAgain ?? false,
  }))
  return {
    service: {
      _serviceBrand: undefined,
      confirm,
      prompt: vi.fn(),
    } as unknown as IDialogService,
    confirm,
  }
}

function makeConfig(value: boolean | undefined) {
  const update = vi.fn()
  return {
    service: {
      _serviceBrand: undefined,
      get: () => value,
      update,
    } as unknown as IConfigurationService,
    update,
  }
}

function makeSessions(
  live: readonly { id: string; durableId: string }[],
  closeFails: ReadonlySet<string> = new Set(),
) {
  const closeSession = vi.fn(async (id: string) => {
    if (closeFails.has(id)) throw new Error(`close failed: ${id}`)
  })
  const deleteOnAgent = vi.fn(
    async (_sessionId: string): Promise<'ok' | 'unsupported' | 'unknown' | 'error'> => 'ok',
  )
  return {
    service: {
      _serviceBrand: undefined,
      // The real service resolves both the local uuid and the durable id.
      getById: (id: string) => {
        const found = live.find((s) => s.id === id || s.durableId === id)
        return found ? ({ id: found.id, agentId: 'fake' } as unknown as IAcpSession) : undefined
      },
      closeSession,
      deleteOnAgent,
    } as unknown as IAcpSessionService,
    closeSession,
    deleteOnAgent,
  }
}

function makeHistory() {
  const removeDeleted = vi.fn()
  return {
    service: {
      _serviceBrand: undefined,
      removeDeleted,
    } as unknown as IAcpSessionHistoryService,
    removeDeleted,
  }
}

describe('confirmSideTaskRemoval', () => {
  it('does not prompt when there is nothing to delete', async () => {
    const dialog = makeDialog({ confirmed: true })
    const config = makeConfig(undefined)

    expect(await confirmSideTaskRemoval([], dialog.service, config.service)).toBe(false)
    expect(dialog.confirm).not.toHaveBeenCalled()
  })

  it('uses the singular detail for a lone row', async () => {
    const dialog = makeDialog({ confirmed: true })
    const config = makeConfig(undefined)

    expect(await confirmSideTaskRemoval(['side-1'], dialog.service, config.service)).toBe(true)
    expect(dialog.confirm.mock.calls[0]?.[0]).toMatchObject({
      message: 'Delete this side task?',
      detail: 'This will delete the side task and its history.',
    })
  })

  it('counts nested side tasks in the detail', async () => {
    const dialog = makeDialog({ confirmed: true })
    const config = makeConfig(undefined)

    await confirmSideTaskRemoval(['side-1', 'grand-1', 'grand-2'], dialog.service, config.service)
    expect(dialog.confirm.mock.calls[0]?.[0]).toMatchObject({
      detail: 'This also deletes its 2 nested side task(s).',
    })
  })

  it('returns false when the user cancels', async () => {
    const dialog = makeDialog({ confirmed: false })
    const config = makeConfig(undefined)

    expect(await confirmSideTaskRemoval(['side-1'], dialog.service, config.service)).toBe(false)
    expect(config.update).not.toHaveBeenCalled()
  })

  it('remembers "never ask again" in the shared setting', async () => {
    const dialog = makeDialog({ confirmed: true, neverAskAgain: true })
    const config = makeConfig(undefined)

    await confirmSideTaskRemoval(['side-1'], dialog.service, config.service)
    expect(config.update).toHaveBeenCalledWith(
      'acp.sessions.confirmDelete',
      false,
      ConfigurationTarget.User,
    )
  })

  it('skips the dialog when confirmDelete is off', async () => {
    const dialog = makeDialog({ confirmed: false })
    const config = makeConfig(false)

    expect(await confirmSideTaskRemoval(['side-1'], dialog.service, config.service)).toBe(true)
    expect(dialog.confirm).not.toHaveBeenCalled()
  })
})

describe('deleteSideTasks', () => {
  it('closes live sessions by local id and deletes by durable id', async () => {
    const sessions = makeSessions([{ id: 'local-side', durableId: 'side-1' }])
    const history = makeHistory()

    await deleteSideTasks(['side-1'], sessions.service, history.service)

    expect(sessions.closeSession).toHaveBeenCalledWith('local-side')
    expect(sessions.deleteOnAgent).toHaveBeenCalledWith('side-1')
    expect(history.removeDeleted).toHaveBeenCalledWith('side-1')
  })

  it('skips close for history-only rows', async () => {
    const sessions = makeSessions([])
    const history = makeHistory()

    await deleteSideTasks(['side-1'], sessions.service, history.service)

    expect(sessions.closeSession).not.toHaveBeenCalled()
    expect(sessions.deleteOnAgent).toHaveBeenCalledWith('side-1')
  })

  it('keeps cascading after a close failure and still drops local rows', async () => {
    const sessions = makeSessions(
      [
        { id: 'side-1', durableId: 'side-1' },
        { id: 'grand-1', durableId: 'grand-1' },
      ],
      new Set(['side-1']),
    )
    const history = makeHistory()

    await deleteSideTasks(['side-1', 'grand-1'], sessions.service, history.service)

    expect(sessions.deleteOnAgent.mock.calls.map((call) => call[0])).toEqual(['grand-1'])
    expect(history.removeDeleted.mock.calls.map((call) => call[0])).toEqual(['side-1', 'grand-1'])
  })

  it('drops the local row even when the agent cannot delete it', async () => {
    const sessions = makeSessions([])
    sessions.deleteOnAgent.mockResolvedValue('unsupported')
    const history = makeHistory()

    await deleteSideTasks(['side-1'], sessions.service, history.service)

    // The tombstone inside `removeDeleted` is what keeps a sweep from
    // resurrecting a row the agent could not delete.
    expect(history.removeDeleted).toHaveBeenCalledWith('side-1')
  })

  it('never rejects', async () => {
    const sessions = makeSessions([{ id: 'side-1', durableId: 'side-1' }], new Set(['side-1']))
    sessions.deleteOnAgent.mockRejectedValue(new Error('boom'))
    const history = makeHistory()

    await expect(
      deleteSideTasks(['side-1'], sessions.service, history.service),
    ).resolves.toBeUndefined()
  })
})
