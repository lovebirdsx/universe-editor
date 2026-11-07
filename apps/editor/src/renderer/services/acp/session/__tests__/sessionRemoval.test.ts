/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  sessionRemoval tests — the shared plan / confirm / delete pipeline used by the
 *  session list, side tasks and the Delete Agent Session command.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  ConfigurationTarget,
  Event,
  InstantiationService,
  IUriIdentityService,
  IWorkspaceService,
  ServiceCollection,
  URI,
  observableValue,
  type IConfirmOptions,
  type IConfigurationService,
  type IDialogService,
  type IEditorGroup,
  type IEditorGroupsService,
  type IWorkspaceService as IWorkspaceServiceType,
  type IUriIdentityService as IUriIdentityServiceType,
} from '@universe-editor/platform'
import { AcpSessionEditorInput } from '../acpSessionEditorInput.js'
import type { AcpSessionStatus, IAcpSession, IAcpSessionService } from '../acpSessionService.js'
import type { AcpSessionHistoryEntry, IAcpSessionHistoryService } from '../acpSessionHistory.js'
import { IAcpSessionService as IAcpSessionServiceId } from '../acpSessionService.js'
import { IAcpSessionHistoryService as IAcpSessionHistoryServiceId } from '../acpSessionHistory.js'
import {
  IAcpChatWidgetService,
  type IAcpChatWidgetService as IAcpChatWidgetServiceType,
} from '../acpChatWidgetService.js'
import {
  closeSessionEditorTabs,
  confirmSessionRemoval,
  deleteSessionPlan,
  planSessionRemoval,
} from '../sessionRemoval.js'

function makeLiveSession(opts: { id: string; durableId?: string }): IAcpSession {
  return {
    id: opts.id,
    agentId: 'fake',
    status: observableValue<AcpSessionStatus>('test.status', 'idle'),
    sessionIdOnAgent: observableValue<string | undefined>('test.durable', opts.durableId),
  } as unknown as IAcpSession
}

function makeSessions(live: readonly IAcpSession[], closeFails: ReadonlySet<string> = new Set()) {
  const closeSession = vi.fn(async (id: string) => {
    if (closeFails.has(id)) throw new Error(`close failed: ${id}`)
  })
  const deleteOnAgent = vi.fn(
    async (_sessionId: string): Promise<'ok' | 'unsupported' | 'unknown' | 'error'> => 'ok',
  )
  const service = {
    _serviceBrand: undefined,
    getById: (id: string) => live.find((s) => s.id === id || s.sessionIdOnAgent.get() === id),
    closeSession,
    deleteOnAgent,
  } as unknown as IAcpSessionService
  return { service, closeSession, deleteOnAgent }
}

function makeHistory(entries: readonly AcpSessionHistoryEntry[]) {
  const removeDeleted = vi.fn()
  const service = {
    _serviceBrand: undefined,
    get: (id: string) => entries.find((e) => e.id === id),
    list: () => entries,
    removeDeleted,
  } as unknown as IAcpSessionHistoryService
  return { service, removeDeleted }
}

function historyEntry(
  id: string,
  extra: Partial<AcpSessionHistoryEntry> = {},
): AcpSessionHistoryEntry {
  return {
    id,
    agentId: 'fake',
    sessionIdOnAgent: id,
    title: id,
    createdAt: 1,
    lastUsedAt: 1,
    ...extra,
  }
}

function makeDialog(result: { confirmed: boolean; neverAskAgain?: boolean }) {
  const confirm = vi.fn(async (_options: IConfirmOptions) => ({
    confirmed: result.confirmed,
    choice: result.confirmed ? ('primary' as const) : ('cancel' as const),
    neverAskAgain: result.neverAskAgain ?? false,
  }))
  return {
    service: { _serviceBrand: undefined, confirm, prompt: vi.fn() } as unknown as IDialogService,
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

const stubWorkspace: IWorkspaceServiceType = {
  _serviceBrand: undefined,
  current: null,
  onDidChangeWorkspace: Event.None,
  recent: [],
  onDidChangeRecent: Event.None,
} as unknown as IWorkspaceServiceType

const stubUriIdentity: IUriIdentityServiceType = {
  _serviceBrand: undefined,
  platform: 'linux',
  isEqual: (a?: URI, b?: URI) => a?.toString() === b?.toString(),
  isEqualOrParent: () => false,
  getComparisonKey: (uri: URI) => uri.toString(),
  arePathsEqual: (a?: string, b?: string) => a === b,
  getPathComparisonKey: (p: string) => p,
  relativePathUnder: () => null,
  createResourceMap: () => new Map() as never,
  createResourceSet: () => new Set() as never,
} as unknown as IUriIdentityServiceType

function makeInput(sessionId: string): AcpSessionEditorInput {
  const history = {
    _serviceBrand: undefined,
    entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.entries', []),
    get: () => undefined,
  } as unknown as IAcpSessionHistoryService
  const sessions = {
    _serviceBrand: undefined,
    getById: () => undefined,
  } as unknown as IAcpSessionService
  const chatWidget = {
    _serviceBrand: undefined,
    focusSession: () => false,
  } as unknown as IAcpChatWidgetServiceType
  const services = new ServiceCollection()
  services.set(IAcpSessionServiceId, sessions)
  services.set(IAcpSessionHistoryServiceId, history)
  services.set(IAcpChatWidgetService, chatWidget as never)
  services.set(IWorkspaceService, stubWorkspace)
  services.set(IUriIdentityService, stubUriIdentity)
  const inst = new InstantiationService(services)
  return inst.createInstance(AcpSessionEditorInput, sessionId, 'fake', undefined)
}

function makeGroups(groups: AcpSessionEditorInput[][]) {
  const closeEditor = vi.fn()
  const service = {
    _serviceBrand: undefined,
    groups: groups.map((editors) => ({ editors, closeEditor }) as unknown as IEditorGroup),
  } as unknown as IEditorGroupsService
  return { service, closeEditor }
}

describe('planSessionRemoval', () => {
  it('treats a session without an agent id and without a history row as pending', () => {
    const sessions = makeSessions([makeLiveSession({ id: 'local-1' })])
    const history = makeHistory([])

    expect(planSessionRemoval(sessions.service, history.service, 'local-1')).toEqual({
      ids: ['local-1'],
      localOnlyIds: new Set(['local-1']),
      rootIsSideTask: false,
    })
  })

  it('maps a live local id onto the durable id and collects the side-task subtree', () => {
    const sessions = makeSessions([makeLiveSession({ id: 'local-1', durableId: 'durable-1' })])
    const history = makeHistory([
      historyEntry('durable-1'),
      historyEntry('child-1', { sideTaskOf: 'durable-1' }),
    ])

    const plan = planSessionRemoval(sessions.service, history.service, 'local-1')
    expect(plan.ids).toEqual(['durable-1', 'child-1'])
    expect(plan.localOnlyIds.size).toBe(0)
    expect(plan.rootIsSideTask).toBe(false)
  })

  it('plans a dormant history-only row without a live session', () => {
    const sessions = makeSessions([])
    const history = makeHistory([historyEntry('durable-1')])

    const plan = planSessionRemoval(sessions.service, history.service, 'durable-1')
    expect(plan.ids).toEqual(['durable-1'])
    expect(plan.rootIsSideTask).toBe(false)
  })

  it('marks a side-task root for the side-task confirmation wording', () => {
    const sessions = makeSessions([])
    const history = makeHistory([historyEntry('side-1', { sideTaskOf: 'parent-1' })])

    expect(planSessionRemoval(sessions.service, history.service, 'side-1').rootIsSideTask).toBe(
      true,
    )
  })
})

describe('confirmSessionRemoval', () => {
  it('uses the plain session wording for a lone session', async () => {
    const dialog = makeDialog({ confirmed: true })
    const config = makeConfig(undefined)

    const ok = await confirmSessionRemoval(
      { ids: ['s-1'], localOnlyIds: new Set(), rootIsSideTask: false },
      dialog.service,
      config.service,
    )
    expect(ok).toBe(true)
    expect(dialog.confirm.mock.calls[0]?.[0]).toMatchObject({
      message: 'Delete this session?',
      detail: 'This will delete the session and its history.',
    })
  })

  it('counts cascaded side tasks in the detail', async () => {
    const dialog = makeDialog({ confirmed: true })
    const config = makeConfig(undefined)

    await confirmSessionRemoval(
      { ids: ['s-1', 'child-1', 'child-2'], localOnlyIds: new Set(), rootIsSideTask: false },
      dialog.service,
      config.service,
    )
    expect(dialog.confirm.mock.calls[0]?.[0]).toMatchObject({
      detail: 'This also deletes its 2 side task(s) and their history.',
    })
  })

  it('returns false without side effects when cancelled', async () => {
    const dialog = makeDialog({ confirmed: false })
    const config = makeConfig(undefined)

    expect(
      await confirmSessionRemoval(
        { ids: ['s-1'], localOnlyIds: new Set(), rootIsSideTask: false },
        dialog.service,
        config.service,
      ),
    ).toBe(false)
    expect(config.update).not.toHaveBeenCalled()
  })

  it('remembers "never ask again" in the shared setting', async () => {
    const dialog = makeDialog({ confirmed: true, neverAskAgain: true })
    const config = makeConfig(undefined)

    await confirmSessionRemoval(
      { ids: ['s-1'], localOnlyIds: new Set(), rootIsSideTask: false },
      dialog.service,
      config.service,
    )
    expect(config.update).toHaveBeenCalledWith(
      'acp.sessions.confirmDelete',
      false,
      ConfigurationTarget.User,
    )
  })

  it('skips the dialog when confirmDelete is off', async () => {
    const dialog = makeDialog({ confirmed: false })
    const config = makeConfig(false)

    expect(
      await confirmSessionRemoval(
        { ids: ['s-1'], localOnlyIds: new Set(), rootIsSideTask: false },
        dialog.service,
        config.service,
      ),
    ).toBe(true)
    expect(dialog.confirm).not.toHaveBeenCalled()
  })
})

describe('deleteSessionPlan', () => {
  it('closes a live session by local id, then deletes and tombstones the durable id', async () => {
    const sessions = makeSessions([makeLiveSession({ id: 'local-1', durableId: 'durable-1' })])
    const history = makeHistory([historyEntry('durable-1')])
    const plan = planSessionRemoval(sessions.service, history.service, 'local-1')

    await deleteSessionPlan(plan, sessions.service, history.service)

    expect(sessions.closeSession).toHaveBeenCalledWith('local-1')
    expect(sessions.deleteOnAgent).toHaveBeenCalledWith('durable-1')
    expect(history.removeDeleted).toHaveBeenCalledWith('durable-1')
    const closeOrder = sessions.closeSession.mock.invocationCallOrder[0]!
    const deleteOrder = sessions.deleteOnAgent.mock.invocationCallOrder[0]!
    const tombstoneOrder = history.removeDeleted.mock.invocationCallOrder[0]!
    expect(closeOrder).toBeLessThan(deleteOrder)
    expect(deleteOrder).toBeLessThan(tombstoneOrder)
  })

  it('deletes a dormant row without closing anything', async () => {
    const sessions = makeSessions([])
    const history = makeHistory([historyEntry('durable-1')])
    const plan = planSessionRemoval(sessions.service, history.service, 'durable-1')

    await deleteSessionPlan(plan, sessions.service, history.service)

    expect(sessions.closeSession).not.toHaveBeenCalled()
    expect(sessions.deleteOnAgent).toHaveBeenCalledWith('durable-1')
    expect(history.removeDeleted).toHaveBeenCalledWith('durable-1')
  })

  it('only closes a pending session — no agent delete, no tombstone', async () => {
    const sessions = makeSessions([makeLiveSession({ id: 'local-1' })])
    const history = makeHistory([])
    const plan = planSessionRemoval(sessions.service, history.service, 'local-1')

    await deleteSessionPlan(plan, sessions.service, history.service)

    expect(sessions.closeSession).toHaveBeenCalledWith('local-1')
    expect(sessions.deleteOnAgent).not.toHaveBeenCalled()
    expect(history.removeDeleted).not.toHaveBeenCalled()
  })

  it('keeps deleting the rest of the subtree after one close fails', async () => {
    const sessions = makeSessions(
      [
        makeLiveSession({ id: 'root', durableId: 'root' }),
        makeLiveSession({ id: 'child', durableId: 'child' }),
      ],
      new Set(['root']),
    )
    const history = makeHistory([
      historyEntry('root'),
      historyEntry('child', { sideTaskOf: 'root' }),
    ])
    const plan = planSessionRemoval(sessions.service, history.service, 'root')

    await deleteSessionPlan(plan, sessions.service, history.service)

    expect(sessions.deleteOnAgent.mock.calls.map((call) => call[0])).toEqual(['child'])
    expect(history.removeDeleted.mock.calls.map((call) => call[0])).toEqual(['root', 'child'])
  })

  it('closes tabs matching either the durable id or the live local id, leaving others alone', async () => {
    const localInput = makeInput('local-1')
    const durableInput = makeInput('durable-1')
    const unrelated = makeInput('other-1')
    const groups = makeGroups([[localInput, unrelated], [durableInput]])
    const sessions = makeSessions([makeLiveSession({ id: 'local-1', durableId: 'durable-1' })])
    const history = makeHistory([historyEntry('durable-1')])
    const plan = planSessionRemoval(sessions.service, history.service, 'local-1')

    await deleteSessionPlan(plan, sessions.service, history.service, groups.service)

    expect(
      groups.closeEditor.mock.calls
        .map((call) => (call[0] as AcpSessionEditorInput).sessionId)
        .sort(),
    ).toEqual(['durable-1', 'local-1'])
  })
})

describe('closeSessionEditorTabs', () => {
  it('copies the editor list before closing so sibling tabs survive', () => {
    const a = makeInput('a')
    const b = makeInput('b')
    const groups = makeGroups([[a, b]])
    groups.closeEditor.mockImplementation((editor: AcpSessionEditorInput) => {
      const list = (groups.service.groups[0] as unknown as { editors: AcpSessionEditorInput[] })
        .editors
      const index = list.indexOf(editor)
      if (index >= 0) list.splice(index, 1)
    })

    closeSessionEditorTabs(new Set(['a']), groups.service)

    expect(groups.closeEditor).toHaveBeenCalledTimes(1)
    expect((groups.closeEditor.mock.calls[0]?.[0] as AcpSessionEditorInput).sessionId).toBe('a')
  })
})
