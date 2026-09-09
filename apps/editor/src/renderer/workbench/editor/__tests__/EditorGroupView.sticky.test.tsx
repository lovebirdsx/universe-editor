/*---------------------------------------------------------------------------------------------
 *  Tests for EditorGroupView sticky (pinned) tab UX.
 *  A sticky tab sits at the group front, renders an unpin button in place of
 *  the close button, ignores middle-click close, and re-renders when the
 *  sticky count changes.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  EditorInput,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  ServiceCollection,
  URI,
  type ICommandService as ICommandServiceType,
  type IConfirmResult,
  type IDialogService as IDialogServiceType,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'

const stubDialog: IDialogServiceType = {
  _serviceBrand: undefined,
  confirm: async (): Promise<IConfirmResult> => ({ confirmed: true, choice: 'primary' }),
  prompt: async () => undefined,
}

const stubCommand: ICommandServiceType = {
  _serviceBrand: undefined,
  async executeCommand() {
    return undefined
  },
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

const map = new Map()

afterEach(() => cleanup())

describe('EditorGroupView — sticky tab', () => {
  it('renders an unpin button instead of the close button on a sticky tab', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a, { sticky: true })
    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
      />,
    )
    expect(screen.getByTestId('editor-tab-unpin')).toBeTruthy()
    expect(screen.queryByLabelText('Close a')).toBeNull()
  })

  it('a non-sticky tab keeps the close button and shows no unpin button', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a)
    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
      />,
    )
    expect(screen.queryByTestId('editor-tab-unpin')).toBeNull()
    expect(screen.getByLabelText('Close a')).toBeTruthy()
  })

  it('clicking the unpin button unsticks the tab', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a, { sticky: true })
    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
      />,
    )
    expect(svc.activeGroup.stickyCount).toBe(1)
    fireEvent.click(screen.getByTestId('editor-tab-unpin'))
    expect(svc.activeGroup.stickyCount).toBe(0)
    expect(svc.activeGroup.isSticky(a)).toBe(false)
  })

  it('middle-click ignores a sticky tab', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a, { sticky: true })
    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
      />,
    )
    fireEvent(screen.getByRole('tab'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(svc.activeGroup.count).toBe(1)
  })

  it('re-renders when the sticky count changes (stick → unpin button appears)', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a)
    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (map as Map<string, unknown>).get(k)) as never}
      />,
    )
    expect(screen.queryByTestId('editor-tab-unpin')).toBeNull()
    act(() => svc.activeGroup.stickEditor(a))
    expect(screen.getByTestId('editor-tab-unpin')).toBeTruthy()
  })
})
