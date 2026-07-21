/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the editor-title `…` overflow menu and the group-lock indicator.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  Action2,
  ContextKeyService,
  EditorInput,
  EditorRegistry,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  MenuId,
  ServiceCollection,
  URI,
  registerAction2,
  type IConfirmResult,
  type ICommandService as ICommandServiceType,
  type IDialogService as IDialogServiceType,
  type IDisposable,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'

const stubDialog: IDialogServiceType = {
  _serviceBrand: undefined,
  confirm: async (): Promise<IConfirmResult> => ({ confirmed: false, choice: 'cancel' }),
  prompt: async () => undefined,
}

const executed: string[] = []
const stubCommand: ICommandServiceType = {
  _serviceBrand: undefined,
  async executeCommand(id: string) {
    executed.push(id)
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
  constructor(
    private readonly _name: string,
    private readonly _typeId: string,
  ) {
    super()
  }
  get typeId() {
    return this._typeId
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

const componentMap = new Map<string, React.ComponentType<{ input: { label: string } }>>([
  ['fake', FakeComponent],
])

class PrimaryTitleAction extends Action2 {
  static readonly ID = 'test.title.primary'
  constructor() {
    super({
      id: PrimaryTitleAction.ID,
      title: 'Primary',
      icon: 'more',
      menu: [{ id: MenuId.EditorTitle, group: 'navigation' }],
    })
  }
  override run(): void {}
}

class OverflowTitleAction extends Action2 {
  static readonly ID = 'test.title.overflow'
  constructor() {
    super({
      id: OverflowTitleAction.ID,
      title: 'Overflow Item',
      menu: [{ id: MenuId.EditorTitle, group: '1_close', order: 5 }],
    })
  }
  override run(): void {}
}

const disposables: IDisposable[] = []

afterEach(() => {
  executed.length = 0
  while (disposables.length) disposables.pop()!.dispose()
})

describe('EditorGroupView — editor-title overflow menu', () => {
  it('shows the … overflow button only when a non-navigation item exists', async () => {
    disposables.push(registerAction2(PrimaryTitleAction))
    disposables.push(
      EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' }),
    )
    const svc = new EditorGroupsService()
    disposables.push(svc)
    svc.activeGroup.openEditor(new FakeEditor('a', 'fake'))

    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (componentMap as Map<string, unknown>).get(k)) as never}
      />,
    )
    await screen.findByTestId('fake-editor')
    // Only a navigation item is registered → no overflow button.
    expect(screen.queryByTestId('editor-title-overflow')).toBeNull()
  })

  it('opens a ContextMenu with the non-navigation items on click', async () => {
    disposables.push(registerAction2(PrimaryTitleAction))
    disposables.push(registerAction2(OverflowTitleAction))
    disposables.push(
      EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' }),
    )
    const svc = new EditorGroupsService()
    disposables.push(svc)
    svc.activeGroup.openEditor(new FakeEditor('a', 'fake'))

    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (componentMap as Map<string, unknown>).get(k)) as never}
      />,
    )
    const overflow = await screen.findByTestId('editor-title-overflow')
    await act(async () => {
      fireEvent.click(overflow)
    })
    // The overflow item shows up in the popped menu but the primary (navigation) does not.
    const item = await screen.findByText('Overflow Item')
    expect(screen.queryByText('Primary')).toBeNull()
    await act(async () => {
      fireEvent.click(item)
    })
    expect(executed).toContain(OverflowTitleAction.ID)
  })
})

describe('EditorGroupView — group lock indicator', () => {
  it('renders the lock indicator only when the group is locked', async () => {
    disposables.push(
      EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' }),
    )
    const svc = new EditorGroupsService()
    disposables.push(svc)
    svc.activeGroup.openEditor(new FakeEditor('a', 'fake'))

    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (componentMap as Map<string, unknown>).get(k)) as never}
      />,
    )
    await screen.findByTestId('fake-editor')
    expect(screen.queryByTestId('editor-group-lock-indicator')).toBeNull()

    await act(async () => {
      svc.activeGroup.lock(true)
    })
    await screen.findByTestId('editor-group-lock-indicator')
  })

  it('clicking the lock indicator runs the toggle-lock command (unlock)', async () => {
    disposables.push(
      EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' }),
    )
    const svc = new EditorGroupsService()
    disposables.push(svc)
    svc.activeGroup.openEditor(new FakeEditor('a', 'fake'))
    svc.activeGroup.lock(true)

    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (componentMap as Map<string, unknown>).get(k)) as never}
      />,
    )
    const indicator = await screen.findByTestId('editor-group-lock-indicator')
    await act(async () => {
      fireEvent.click(indicator)
    })
    expect(executed).toContain('workbench.action.toggleEditorGroupLock')
  })
})
