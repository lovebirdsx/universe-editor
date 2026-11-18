import { afterEach, describe, expect, it } from 'vitest'
import { StrictMode, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import {
  ContextKeyService,
  EditorInput,
  Event,
  GroupDirection,
  IContextKeyService,
  IUriIdentityService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  observableValue,
  type IDisposable,
} from '@universe-editor/platform'
import { AcpSessionEditorInput } from '../../../services/acp/session/acpSessionEditorInput.js'
import type { IAcpSessionService } from '../../../services/acp/session/acpSessionService.js'
import type {
  AcpSessionHistoryEntry,
  IAcpSessionHistoryService,
} from '../../../services/acp/session/acpSessionHistory.js'
import type { IAcpChatWidgetService } from '../../../services/acp/session/acpChatWidgetService.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'
import { useEditorGroupScopedContextKey } from '../useEditorGroupScopedContextKey.js'

class FakeEditor extends EditorInput {
  constructor(private readonly _name: string) {
    super()
  }
  get typeId() {
    return 'fake'
  }
  get resource() {
    return URI.file(`D:/${this._name}.txt`)
  }
  getName() {
    return this._name
  }
}

const disposables: IDisposable[] = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const services = new ServiceCollection()
  services.set(IContextKeyService, new ContextKeyService())
  services.set(IUriIdentityService, new UriIdentityService('win32'))
  const inst = new InstantiationService(services)
  return ({ children }) => (
    <StrictMode>
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    </StrictMode>
  )
}

function setup(): EditorGroupsService {
  const groups = new EditorGroupsService()
  disposables.push(groups)
  return groups
}

describe('useEditorGroupScopedContextKey — per-group position keys', () => {
  it('reflects the group active editor even when another group is active', () => {
    const groups = setup()
    const g1 = groups.activeGroup
    const a = new FakeEditor('a')
    const b = new FakeEditor('b')
    const c = new FakeEditor('c')
    g1.openEditor(a)
    g1.openEditor(b)
    g1.openEditor(c)
    g1.setActive(a)

    const g2 = groups.addGroup(g1, GroupDirection.Right)
    g2.openEditor(new FakeEditor('other'))
    groups.activateGroup(g2)

    const { result } = renderHook(() => useEditorGroupScopedContextKey(g1), {
      wrapper: makeWrapper(),
    })

    expect(result.current.get('activeEditorId')).toBe(a.id)
    expect(result.current.get('hasActiveEditor')).toBe(true)
    expect(result.current.get('editorIsOpen')).toBe(true)
    expect(result.current.get('groupEditorsCount')).toBe(3)
    expect(result.current.get('activeEditorGroupEmpty')).toBe(false)
    expect(result.current.get('activeEditorGroupLocked')).toBe(false)
    expect(result.current.get('activeEditorIsFirstInGroup')).toBe(true)
    expect(result.current.get('activeEditorIsLastInGroup')).toBe(false)
  })

  it('updates position keys when the group active editor changes', () => {
    const groups = setup()
    const g1 = groups.activeGroup
    const a = new FakeEditor('a')
    const c = new FakeEditor('c')
    g1.openEditor(a)
    g1.openEditor(c)
    g1.setActive(a)

    const { result, rerender } = renderHook(() => useEditorGroupScopedContextKey(g1), {
      wrapper: makeWrapper(),
    })
    expect(result.current.get('activeEditorIsFirstInGroup')).toBe(true)

    g1.setActive(c)
    rerender()

    expect(result.current.get('activeEditorId')).toBe(c.id)
    expect(result.current.get('activeEditorIsFirstInGroup')).toBe(false)
    expect(result.current.get('activeEditorIsLastInGroup')).toBe(true)
  })

  it('seeds explicit empty values for an empty group', () => {
    const groups = setup()
    const empty = groups.activeGroup

    const { result } = renderHook(() => useEditorGroupScopedContextKey(empty), {
      wrapper: makeWrapper(),
    })

    expect(result.current.get('activeEditorId')).toBe('')
    expect(result.current.get('activeEditorType')).toBe('')
    expect(result.current.get('hasActiveEditor')).toBe(false)
    expect(result.current.get('editorIsOpen')).toBe(false)
    expect(result.current.get('activeEditorGroupEmpty')).toBe(true)
  })
})

function makeSessionInput() {
  const entries = observableValue<readonly AcpSessionHistoryEntry[]>('test.entries', [])
  const history = {
    _serviceBrand: undefined,
    entries,
    get: (id: string) => entries.get().find((entry) => entry.id === id),
  } as unknown as IAcpSessionHistoryService
  const sessions = {
    _serviceBrand: undefined,
    getById: () => undefined,
  } as unknown as IAcpSessionService
  const chatWidget = { _serviceBrand: undefined } as unknown as IAcpChatWidgetService
  const workspace = { _serviceBrand: undefined, current: null, onDidChangeWorkspace: Event.None }
  const input = new AcpSessionEditorInput(
    'durable-1',
    'fake',
    undefined,
    sessions,
    history,
    chatWidget,
    workspace as never,
    { _serviceBrand: undefined, platform: 'linux' } as never,
  )
  disposables.push(input)
  return { input, entries }
}

describe('useEditorGroupScopedContextKey — session automation', () => {
  it('follows acpSessionHasAutomation when history hydrates after the tab is active', () => {
    const groups = setup()
    const g1 = groups.activeGroup
    const { input, entries } = makeSessionInput()
    g1.openEditor(input)

    const { result } = renderHook(() => useEditorGroupScopedContextKey(g1), {
      wrapper: makeWrapper(),
    })
    expect(result.current.get('acpSessionHasAutomation')).toBe(false)

    act(() => {
      entries.set(
        [
          {
            id: 'durable-1',
            agentId: 'fake',
            sessionIdOnAgent: 'durable-1',
            title: 'session',
            createdAt: 1,
            lastUsedAt: 1,
            automation: { triggerId: 't', triggerName: 'T', eventKey: 'e', runId: 'r' },
          } as AcpSessionHistoryEntry,
        ],
        undefined,
      )
    })

    expect(result.current.get('acpSessionHasAutomation')).toBe(true)
  })
})
