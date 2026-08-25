/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SideTasksBar tests — the parent chat's side task popover, focused on the
 *  inline delete button: confirm gating, cascade over nested side tasks, and the
 *  guarantee that a delete never falls through to the row's "open" handler.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  ConfigurationTarget,
  IConfigurationService,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  InstantiationService,
  observableValue,
  ServiceCollection,
  type IConfigurationService as IConfigurationServiceType,
  type IDialogService as IDialogServiceType,
} from '@universe-editor/platform'
import { SideTasksBar } from '../SideTasksBar.js'
import { ServicesContext } from '../../useService.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type IAcpSessionHistoryService as IAcpSessionHistoryServiceType,
} from '../../../services/acp/session/acpSessionHistory.js'
import {
  IAcpSessionService,
  type IAcpSession,
} from '../../../services/acp/session/acpSessionService.js'
import { IAcpChatWidgetService } from '../../../services/acp/session/acpChatWidgetService.js'

afterEach(() => cleanup())

const PARENT = 'parent-1'

function row(id: string, sideTaskOf: string, lastUsedAt = 1000): AcpSessionHistoryEntry {
  return {
    id,
    agentId: 'fake',
    sessionIdOnAgent: id,
    title: `side ${id}`,
    createdAt: lastUsedAt,
    lastUsedAt,
    sideTaskOf,
  }
}

interface Harness {
  readonly container: HTMLElement
  readonly confirm: ReturnType<typeof vi.fn>
  readonly closeSession: ReturnType<typeof vi.fn>
  readonly deleteOnAgent: ReturnType<typeof vi.fn>
  readonly remove: ReturnType<typeof vi.fn>
  readonly update: ReturnType<typeof vi.fn>
  readonly groups: EditorGroupsService
  /** Open the popover so the rows (and their delete buttons) are mounted. */
  readonly openPopover: () => void
  readonly deleteButtons: () => HTMLElement[]
}

function renderBar(
  options: {
    entries?: AcpSessionHistoryEntry[]
    /** `undefined` (the default) means the confirm dialog is enabled. */
    confirmDelete?: boolean
    confirmResult?: { confirmed: boolean; neverAskAgain?: boolean }
    /** Side task ids that are currently live (so closeSession applies). */
    live?: string[]
    /** Make closeSession reject for these ids, to exercise the per-row recovery. */
    closeFailsFor?: string[]
    deleteOutcome?: 'ok' | 'unsupported' | 'unknown' | 'error'
  } = {},
): Harness {
  let entries = options.entries ?? [row('side-1', PARENT)]
  const entriesObs = observableValue<readonly AcpSessionHistoryEntry[]>('t.entries', entries)
  const remove = vi.fn((id: string) => {
    entries = entries.filter((e) => e.id !== id)
    entriesObs.set(entries, undefined)
  })
  const history = {
    _serviceBrand: undefined,
    entries: entriesObs,
    get: (id: string) => entries.find((e) => e.id === id),
    remove,
  } as unknown as IAcpSessionHistoryServiceType

  const liveIds = new Set(options.live ?? [])
  const closeFails = new Set(options.closeFailsFor ?? [])
  const closeSession = vi.fn(async (id: string) => {
    if (closeFails.has(id)) throw new Error(`close failed: ${id}`)
  })
  const deleteOnAgent = vi.fn(async () => options.deleteOutcome ?? ('ok' as const))
  const sessions = {
    _serviceBrand: undefined,
    getById: (id: string) =>
      liveIds.has(id) ? ({ id, agentId: 'fake' } as IAcpSession) : undefined,
    closeSession,
    deleteOnAgent,
  } as unknown as IAcpSessionService

  const confirm = vi.fn(async () => ({
    confirmed: options.confirmResult?.confirmed ?? true,
    choice: 'primary' as const,
    neverAskAgain: options.confirmResult?.neverAskAgain ?? false,
  }))
  const update = vi.fn()
  const groups = new EditorGroupsService()

  const services = new ServiceCollection()
  services.set(IAcpSessionHistoryService, history)
  services.set(IAcpSessionService, sessions)
  services.set(IEditorGroupsService, groups)
  services.set(IAcpChatWidgetService, {
    _serviceBrand: undefined,
    register: () => ({ dispose() {} }),
    lastFocusedWidget: undefined,
  } as unknown as IAcpChatWidgetService)
  services.set(IDialogService, {
    _serviceBrand: undefined,
    confirm,
    prompt: vi.fn(),
  } as unknown as IDialogServiceType)
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: () => options.confirmDelete,
    update,
  } as unknown as IConfigurationServiceType)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)

  const session = {
    id: PARENT,
    agentId: 'fake',
    sessionIdOnAgent: observableValue<string | undefined>('t.sid', PARENT),
  } as unknown as IAcpSession

  const { container } = render(
    <ServicesContext.Provider value={inst}>
      <SideTasksBar session={session} />
    </ServicesContext.Provider>,
  )

  const openPopover = () => {
    fireEvent.click(container.querySelector('[data-testid="acp-side-tasks-trigger"]')!)
  }
  const deleteButtons = () => [
    ...container.querySelectorAll<HTMLElement>('[data-testid="acp-side-task-delete"]'),
  ]
  return {
    container,
    confirm,
    closeSession,
    deleteOnAgent,
    remove,
    update,
    groups,
    openPopover,
    deleteButtons,
  }
}

/**
 * Drain the delete handler's async chain (confirm → close → delete → remove).
 * Deliberately generous and not tied to the number of `await`s in the handler —
 * adding one there must not silently invalidate these assertions.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('SideTasksBar delete button', () => {
  it('renders one labelled delete button per side task row', () => {
    const h = renderBar({ entries: [row('side-1', PARENT, 1000), row('side-2', PARENT, 2000)] })
    h.openPopover()
    const buttons = h.deleteButtons()
    expect(buttons.length).toBe(2)
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Delete side task')
  })

  it('confirms, then deletes the side task on the agent and locally', async () => {
    const h = renderBar({ live: ['side-1'] })
    h.openPopover()
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.confirm.mock.calls[0]?.[0]).toMatchObject({
      message: 'Delete this side task?',
      detail: 'This will delete the side task and its history.',
    })
    expect(h.closeSession).toHaveBeenCalledWith('side-1')
    expect(h.deleteOnAgent).toHaveBeenCalledWith('side-1')
    expect(h.remove).toHaveBeenCalledWith('side-1')
  })

  it('cascades over nested side tasks so no row is left orphaned', async () => {
    const h = renderBar({
      entries: [row('side-1', PARENT, 2000), row('grand-1', 'side-1', 1000)],
    })
    h.openPopover()
    // Only side-1 is listed under the parent; grand-1 hangs off side-1.
    expect(h.deleteButtons().length).toBe(1)
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    expect(h.deleteOnAgent.mock.calls.map((c) => c[0])).toEqual(['side-1', 'grand-1'])
    expect(h.remove.mock.calls.map((c) => c[0])).toEqual(['side-1', 'grand-1'])
  })

  it('tells the user how many nested side tasks go with it', async () => {
    const h = renderBar({
      entries: [row('side-1', PARENT, 2000), row('grand-1', 'side-1'), row('grand-2', 'side-1')],
    })
    h.openPopover()
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    expect(h.confirm.mock.calls[0]?.[0]).toMatchObject({
      detail: 'This also deletes its 2 nested side task(s).',
    })
  })

  it('deletes nothing when the user cancels', async () => {
    const h = renderBar({ confirmResult: { confirmed: false }, live: ['side-1'] })
    h.openPopover()
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    expect(h.closeSession).not.toHaveBeenCalled()
    expect(h.deleteOnAgent).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('persists "never ask again" into the shared session-delete setting', async () => {
    const h = renderBar({ confirmResult: { confirmed: true, neverAskAgain: true } })
    h.openPopover()
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    expect(h.update).toHaveBeenCalledWith(
      'acp.sessions.confirmDelete',
      false,
      ConfigurationTarget.User,
    )
  })

  it('skips the dialog when confirmDelete is turned off', async () => {
    const h = renderBar({ confirmDelete: false })
    h.openPopover()
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.deleteOnAgent).toHaveBeenCalledWith('side-1')
  })

  it('does not open the side task in a right split when deleting it', async () => {
    const h = renderBar()
    h.openPopover()
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    expect(h.groups.groups.length).toBe(1)
  })

  it('closes only the live rows of a cascaded subtree', async () => {
    const h = renderBar({
      entries: [row('side-1', PARENT, 2000), row('grand-1', 'side-1', 1000)],
      live: ['grand-1'],
    })
    h.openPopover()
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    // side-1 is history-only (no live instance) → nothing to close for it.
    expect(h.closeSession.mock.calls.map((c) => c[0])).toEqual(['grand-1'])
    expect(h.remove.mock.calls.map((c) => c[0])).toEqual(['side-1', 'grand-1'])
  })

  it('still drops the local row when the agent cannot delete server-side', async () => {
    const h = renderBar({ deleteOutcome: 'unsupported' })
    h.openPopover()
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    expect(h.remove).toHaveBeenCalledWith('side-1')
  })

  it('keeps cascading after a row fails to close', async () => {
    const h = renderBar({
      entries: [row('side-1', PARENT, 2000), row('grand-1', 'side-1', 1000)],
      live: ['side-1', 'grand-1'],
      closeFailsFor: ['side-1'],
    })
    h.openPopover()
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    // side-1's close threw, so its deleteOnAgent is skipped — but its local row
    // still goes and grand-1 is processed rather than stranded.
    expect(h.remove.mock.calls.map((c) => c[0])).toEqual(['side-1', 'grand-1'])
    expect(h.deleteOnAgent.mock.calls.map((c) => c[0])).toEqual(['grand-1'])
  })

  it('drops the whole bar once the last side task is deleted', async () => {
    const h = renderBar()
    h.openPopover()
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    expect(h.container.querySelector('[data-testid="acp-side-tasks-trigger"]')).toBeNull()
  })

  it('hands focus back to the trigger when rows survive the delete', async () => {
    const h = renderBar({ entries: [row('side-1', PARENT, 2000), row('side-2', PARENT, 1000)] })
    h.openPopover()
    const trigger = h.container.querySelector('[data-testid="acp-side-tasks-trigger"]')
    fireEvent.click(h.deleteButtons()[0]!)
    await settle()

    expect(document.activeElement).toBe(trigger)
  })
})
