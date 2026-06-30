/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression guard: a markdown preview editor's title-bar buttons (Open Source /
 *  Find / Help) must stay visible even when another editor group becomes active.
 *  They are gated by the *group-scoped* `activeEditorType` key, not the global
 *  `activeEditorTypeId` (which only reflects the currently active group's editor).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  EditorInput,
  EditorRegistry,
  GroupDirection,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  registerAction2,
  ServiceCollection,
  URI,
  type IDisposable,
  type IEditorInput,
  type ICommandService as ICommandServiceType,
  type IConfirmResult,
  type IDialogService as IDialogServiceType,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'
import { MarkdownPreviewInput } from '../../../services/editor/MarkdownPreviewInput.js'
import {
  OpenMarkdownSourceAction,
  MarkdownPreviewFindAction,
  MarkdownPreviewHelpAction,
} from '../../../actions/markdownActions.js'

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

function FakeComponent() {
  return <div data-testid="fake-editor">fake</div>
}
function PreviewComponent() {
  return <div data-testid="markdown-preview">preview</div>
}

const componentMap = new Map<string, React.ComponentType<{ input: IEditorInput }>>([
  ['fake', FakeComponent as never],
  ['markdown.preview', PreviewComponent as never],
])

const PREVIEW_TITLE_COMMANDS = [
  OpenMarkdownSourceAction.ID,
  MarkdownPreviewFindAction.ID,
  MarkdownPreviewHelpAction.ID,
]

const disposables: IDisposable[] = []

afterEach(() => {
  while (disposables.length) disposables.pop()!.dispose()
})

describe('EditorGroupView — markdown preview EditorTitle buttons survive group switch', () => {
  it('keeps the preview title buttons when another group becomes active', async () => {
    disposables.push(
      registerAction2(OpenMarkdownSourceAction),
      registerAction2(MarkdownPreviewFindAction),
      registerAction2(MarkdownPreviewHelpAction),
    )
    disposables.push(
      EditorRegistry.registerEditorProvider({
        typeId: MarkdownPreviewInput.TYPE_ID,
        componentKey: 'markdown.preview',
      }),
      EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' }),
    )

    const svc = new EditorGroupsService()
    disposables.push(svc)

    // Right group holds a markdown preview; left group holds a plain file.
    const rightGroup = svc.activeGroup
    rightGroup.openEditor(new MarkdownPreviewInput(URI.file('D:/doc.md')))
    const leftGroup = svc.addGroup(rightGroup, GroupDirection.Left)
    leftGroup.openEditor(new FakeEditor('plain'))

    renderWithServices(
      <>
        <EditorGroupView
          group={leftGroup}
          groupsService={svc}
          componentMap={componentMap as never}
        />
        <EditorGroupView
          group={rightGroup}
          groupsService={svc}
          componentMap={componentMap as never}
        />
      </>,
    )

    await screen.findByTestId('markdown-preview')

    const previewButtonCount = () =>
      PREVIEW_TITLE_COMMANDS.map((cmd) => screen.queryByTestId(`view-title-action-${cmd}`)).filter(
        Boolean,
      ).length

    // With the preview group active, all three buttons render.
    expect(previewButtonCount()).toBe(PREVIEW_TITLE_COMMANDS.length)

    // Activate the left group — the preview's buttons must NOT disappear.
    await act(async () => {
      svc.activateGroup(leftGroup)
    })

    expect(previewButtonCount()).toBe(PREVIEW_TITLE_COMMANDS.length)
  })
})
