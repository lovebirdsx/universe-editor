/*---------------------------------------------------------------------------------------------
 *  Tests for EditorGroupView preview-tab UX (主题 11 WP2).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

describe('EditorGroupView — preview tab', () => {
  it('applies a preview class to the tab in the group preview slot', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a, { pinned: false })
    renderWithServices(
      <EditorGroupView group={svc.activeGroup} groupsService={svc} componentMap={map as never} />,
    )
    const tab = screen.getByRole('tab')
    expect(tab.className).toMatch(/preview/)
  })

  it('double-clicking a preview tab pins it (clears the preview slot)', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a, { pinned: false })
    renderWithServices(
      <EditorGroupView group={svc.activeGroup} groupsService={svc} componentMap={map as never} />,
    )
    expect(svc.activeGroup.previewEditor).toBe(a)
    const tab = screen.getByRole('tab')
    fireEvent.doubleClick(tab)
    expect(svc.activeGroup.previewEditor).toBeUndefined()
  })

  it('close button still works for a preview tab', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a, { pinned: false })
    renderWithServices(
      <EditorGroupView group={svc.activeGroup} groupsService={svc} componentMap={map as never} />,
    )
    expect(svc.activeGroup.count).toBe(1)
    fireEvent.click(screen.getByLabelText('Close a'))
    expect(svc.activeGroup.count).toBe(0)
    expect(svc.activeGroup.previewEditor).toBeUndefined()
  })

  it('middle-clicking a tab closes it', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a, { pinned: true })
    renderWithServices(
      <EditorGroupView group={svc.activeGroup} groupsService={svc} componentMap={map as never} />,
    )
    expect(svc.activeGroup.count).toBe(1)
    fireEvent(screen.getByRole('tab'), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(svc.activeGroup.count).toBe(0)
  })

  it('middle-click ignores non-middle buttons', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    svc.activeGroup.openEditor(a, { pinned: true })
    renderWithServices(
      <EditorGroupView group={svc.activeGroup} groupsService={svc} componentMap={map as never} />,
    )
    fireEvent(screen.getByRole('tab'), new MouseEvent('auxclick', { bubbles: true, button: 2 }))
    expect(svc.activeGroup.count).toBe(1)
  })
})
