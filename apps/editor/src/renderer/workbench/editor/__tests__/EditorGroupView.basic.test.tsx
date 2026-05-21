/*---------------------------------------------------------------------------------------------
 *  Tests for EditorGroupView.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  EditorInput,
  EditorRegistry,
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
  confirm: async (): Promise<IConfirmResult> => ({ confirmed: false, choice: 'cancel' }),
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
        componentMap={map as never}
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
      <EditorGroupView group={svc.activeGroup} groupsService={svc} componentMap={map as never} />,
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
      <EditorGroupView group={svc.activeGroup} groupsService={svc} componentMap={map as never} />,
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
      <EditorGroupView group={second} groupsService={svc} componentMap={map as never} />,
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
        <EditorGroupView group={svc.activeGroup} groupsService={svc} componentMap={map as never} />,
      )
      expect(screen.getByTestId('fake-editor').textContent).toBe('a')
    } finally {
      reg.dispose()
    }
  })
})
