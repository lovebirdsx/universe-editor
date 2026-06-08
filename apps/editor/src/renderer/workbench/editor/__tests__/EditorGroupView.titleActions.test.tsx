/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression guard: an active ACP session editor must render the 5
 *  `MenuId.EditorTitle` navigation icons (jumpToPlan + 4 timeline moves),
 *  gated by `activeEditorType == 'acp.session'`. A non-ACP editor must not.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  EditorInput,
  EditorRegistry,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  registerAction2,
  ServiceCollection,
  URI,
  type IDisposable,
  type ICommandService as ICommandServiceType,
  type IConfirmResult,
  type IDialogService as IDialogServiceType,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'
import { AcpSessionEditorInput } from '../../../services/acp/acpSessionEditorInput.js'
import {
  FocusBottomAcpTimelineAction,
  FocusNextAcpTimelineItemAction,
  FocusPreviousAcpTimelineItemAction,
  FocusTopAcpTimelineAction,
  JumpToAcpPlanAction,
} from '../../../actions/agentActions.js'

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
  ['agents.session', FakeComponent],
  ['fake', FakeComponent],
])

const NAV_COMMANDS_IN_ORDER = [
  JumpToAcpPlanAction.ID, // order 1
  FocusPreviousAcpTimelineItemAction.ID, // order 2
  FocusNextAcpTimelineItemAction.ID, // order 3
  FocusTopAcpTimelineAction.ID, // order 4
  FocusBottomAcpTimelineAction.ID, // order 5
]

const disposables: IDisposable[] = []

afterEach(() => {
  while (disposables.length) disposables.pop()!.dispose()
})

function registerNavActions() {
  disposables.push(
    registerAction2(JumpToAcpPlanAction),
    registerAction2(FocusPreviousAcpTimelineItemAction),
    registerAction2(FocusNextAcpTimelineItemAction),
    registerAction2(FocusTopAcpTimelineAction),
    registerAction2(FocusBottomAcpTimelineAction),
  )
}

describe('EditorGroupView — EditorTitle nav icons for ACP session', () => {
  it('renders the 5 navigation icons (in order) for an active acp.session editor', async () => {
    registerNavActions()
    const reg = EditorRegistry.registerEditorProvider({
      typeId: AcpSessionEditorInput.TYPE_ID,
      componentKey: 'agents.session',
    })
    disposables.push(reg)

    const svc = new EditorGroupsService()
    disposables.push(svc)
    svc.activeGroup.openEditor(new FakeEditor('sess', AcpSessionEditorInput.TYPE_ID))

    const { container } = renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        componentMap={componentMap as never}
      />,
    )

    // The scoped contextKey is set in a parent effect; wait for the first icon.
    await screen.findByTestId(`view-title-action-${JumpToAcpPlanAction.ID}`)

    for (const cmd of NAV_COMMANDS_IN_ORDER) {
      expect(screen.getByTestId(`view-title-action-${cmd}`)).toBeTruthy()
    }

    const renderedOrder = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid^="view-title-action-"]'),
    ).map((el) => el.dataset['testid']!.replace('view-title-action-', ''))
    expect(renderedOrder).toEqual(NAV_COMMANDS_IN_ORDER)
  })

  it('does not render the ACP nav icons for a non-acp editor', async () => {
    registerNavActions()
    const reg = EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' })
    disposables.push(reg)

    const svc = new EditorGroupsService()
    disposables.push(svc)
    svc.activeGroup.openEditor(new FakeEditor('plain', 'fake'))

    renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        componentMap={componentMap as never}
      />,
    )

    // Editor body renders, proving the group mounted — but no ACP nav icons.
    await screen.findByTestId('fake-editor')
    for (const cmd of NAV_COMMANDS_IN_ORDER) {
      expect(screen.queryByTestId(`view-title-action-${cmd}`)).toBeNull()
    }
  })
})
