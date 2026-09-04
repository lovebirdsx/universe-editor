/*---------------------------------------------------------------------------------------------
 *  Tests for EditorGroupView.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  EditorInput,
  EditorRegistry,
  Event,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  IUriIdentityService,
  IWorkspaceService,
  observableValue,
  ServiceCollection,
  URI,
  type ICommandService as ICommandServiceType,
  type IConfirmResult,
  type IDialogService as IDialogServiceType,
  type IUriIdentityService as IUriIdentityServiceType,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'
import { AcpSessionEditorInput } from '../../../services/acp/session/acpSessionEditorInput.js'
import {
  IAcpSessionService,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../../services/acp/session/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type IAcpSessionHistoryService as IAcpSessionHistoryServiceType,
} from '../../../services/acp/session/acpSessionHistory.js'
import {
  IAcpChatWidgetService,
  type IAcpChatWidgetService as IAcpChatWidgetServiceType,
} from '../../../services/acp/session/acpChatWidgetService.js'

const stubDialog: IDialogServiceType = {
  _serviceBrand: undefined,
  confirm: async (): Promise<IConfirmResult> => ({ confirmed: false, choice: 'cancel' }),
  prompt: async () => undefined,
}

const stubCommand: ICommandServiceType = {
  _serviceBrand: undefined,
  async executeCommand() {
    return undefined
  },
}

const stubUriIdentity: IUriIdentityServiceType = {
  _serviceBrand: undefined,
  platform: 'linux',
  isEqual: (a?: URI, b?: URI) => a?.toString() === b?.toString(),
  isEqualOrParent: () => false,
  getComparisonKey: (uri: URI) => uri.toString(),
  arePathsEqual: (a?: string, b?: string) => a === b,
  getPathComparisonKey: (p: string) => p,
  relativePathUnder: (root: string, child: string) => {
    const normRoot = root.replace(/\\/g, '/').replace(/\/$/, '')
    const normChild = child.replace(/\\/g, '/')
    if (normChild === normRoot) return ''
    return normChild.startsWith(normRoot + '/') ? normChild.slice(normRoot.length + 1) : null
  },
  createResourceMap: () => new Map() as never,
  createResourceSet: () => new Set() as never,
} as unknown as IUriIdentityServiceType

function makeWorkspace(folder?: string): IWorkspaceServiceType {
  return {
    _serviceBrand: undefined,
    current: folder ? { folder: URI.file(folder), name: 'workspace' } : null,
    onDidChangeWorkspace: Event.None,
    recent: [],
    onDidChangeRecent: Event.None,
  } as unknown as IWorkspaceServiceType
}

function renderWithServices(node: React.ReactNode) {
  const services = new ServiceCollection()
  services.set(IDialogService, stubDialog)
  services.set(ICommandService, stubCommand)
  services.set(IContextKeyService, new ContextKeyService())
  const inst = new InstantiationService(services)
  return render(<ServicesContext.Provider value={inst}>{node}</ServicesContext.Provider>)
}

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

function FakeComponent({ input }: { input: { label: string } }) {
  return <div data-testid="fake-editor">{input.label}</div>
}

const map = new Map<string, React.ComponentType<{ input: { label: string } }>>([
  ['fake', FakeComponent],
])

describe('EditorGroupView', () => {
  it('renders fallback when group has no editors', () => {
    const svc = new EditorGroupsService()
    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
        fallback={<span>welcome-fallback</span>}
      />,
    )
    expect(screen.getByText('welcome-fallback')).toBeTruthy()
  })

  it('renders one tab per editor', () => {
    const svc = new EditorGroupsService()
    svc.activeGroup.openEditor(new FakeEditor('a'))
    svc.activeGroup.openEditor(new FakeEditor('b'))
    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
      />,
    )
    expect(screen.getAllByRole('tab').length).toBe(2)
  })

  it('clicking a tab activates that editor', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    const b = new FakeEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
      />,
    )
    const tabs = screen.getAllByRole('tab')
    fireEvent.click(tabs[0]!)
    expect(svc.activeGroup.activeEditor).toBe(a)
  })

  it('mousedown on a non-active group activates it', () => {
    const svc = new EditorGroupsService()
    const second = svc.addGroup(svc.activeGroup, 3 /* Right */)
    // svc.activeGroup is still the first group
    const onChange = vi.fn()
    svc.onDidActiveGroupChange(onChange)
    const { container } = renderWithServices(
      <EditorGroupView
        group={second}
        groupsService={svc}
        resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
      />,
    )
    fireEvent.mouseDown(container.firstElementChild!)
    expect(svc.activeGroup).toBe(second)
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('active editor renders via componentMap', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    const reg = EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' })
    try {
      svc.activeGroup.openEditor(a)
      renderWithServices(
        <EditorGroupView
          group={svc.activeGroup}
          groupsService={svc}
          resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
        />,
      )
      expect(screen.getByTestId('fake-editor').textContent).toBe('a')
    } finally {
      reg.dispose()
    }
  })

  it('renders the branch badge only on side-task session tabs', () => {
    const rows: AcpSessionHistoryEntry[] = [
      {
        id: 'side-1',
        agentId: 'fake',
        sessionIdOnAgent: 'side-1',
        title: 'side chat',
        createdAt: 1,
        lastUsedAt: 1,
        sideTaskOf: 'parent-1',
      },
      {
        id: 'plain-1',
        agentId: 'fake',
        sessionIdOnAgent: 'plain-1',
        title: 'plain chat',
        createdAt: 2,
        lastUsedAt: 2,
      },
    ]
    const inst = makeSessionInst(rows)

    const svc = new EditorGroupsService()
    svc.activeGroup.openEditor(inst.createInstance(AcpSessionEditorInput, 'side-1', 'fake', 'side'))
    svc.activeGroup.openEditor(
      inst.createInstance(AcpSessionEditorInput, 'plain-1', 'fake', 'plain'),
    )
    render(
      <ServicesContext.Provider value={inst}>
        <EditorGroupView
          group={svc.activeGroup}
          groupsService={svc}
          resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
        />
      </ServicesContext.Provider>,
    )

    const badges = screen.getAllByTestId('editor-tab-side-task-badge')
    expect(badges.length).toBe(1)
    expect(badges[0]!.closest('[role="tab"]')?.textContent).toContain('side chat')
  })

  it('renders the folder badge only for a session cwd strictly inside the workspace', () => {
    const rows: AcpSessionHistoryEntry[] = [
      {
        id: 'sub-1',
        agentId: 'fake',
        sessionIdOnAgent: 'sub-1',
        title: 'sub chat',
        createdAt: 1,
        lastUsedAt: 1,
        cwd: 'X:/workspace/apps/editor',
      },
      {
        id: 'root-1',
        agentId: 'fake',
        sessionIdOnAgent: 'root-1',
        title: 'root chat',
        createdAt: 2,
        lastUsedAt: 2,
        cwd: 'X:/workspace',
      },
    ]
    const inst = makeSessionInst(rows, 'X:/workspace')

    const svc = new EditorGroupsService()
    svc.activeGroup.openEditor(inst.createInstance(AcpSessionEditorInput, 'sub-1', 'fake', 'sub'))
    svc.activeGroup.openEditor(inst.createInstance(AcpSessionEditorInput, 'root-1', 'fake', 'root'))
    render(
      <ServicesContext.Provider value={inst}>
        <EditorGroupView
          group={svc.activeGroup}
          groupsService={svc}
          resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
        />
      </ServicesContext.Provider>,
    )

    const badges = screen.getAllByTestId('editor-tab-cwd-badge')
    expect(badges.length).toBe(1)
    expect(badges[0]!.closest('[role="tab"]')?.textContent).toContain('sub chat')
  })
})

function makeSessionInst(rows: AcpSessionHistoryEntry[], workspaceFolder?: string) {
  const services = new ServiceCollection()
  services.set(IDialogService, stubDialog)
  services.set(ICommandService, stubCommand)
  services.set(IContextKeyService, new ContextKeyService())
  services.set(IAcpSessionService, {
    _serviceBrand: undefined,
    getById: () => undefined,
  } as unknown as IAcpSessionServiceType)
  services.set(IAcpSessionHistoryService, {
    _serviceBrand: undefined,
    entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.history', rows),
    get: (id: string) => rows.find((e) => e.sessionIdOnAgent === id),
  } as unknown as IAcpSessionHistoryServiceType)
  services.set(IAcpChatWidgetService, {
    _serviceBrand: undefined,
    focusSessionInput: () => false,
  } as unknown as IAcpChatWidgetServiceType)
  services.set(IWorkspaceService, makeWorkspace(workspaceFolder))
  services.set(IUriIdentityService, stubUriIdentity)
  return new InstantiationService(services)
}
