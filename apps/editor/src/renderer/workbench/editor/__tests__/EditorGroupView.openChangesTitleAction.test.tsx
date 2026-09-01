/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Guards the workbench half of the unified Open Changes entry: with two
 *  providers owning the same file, `resourceScmProvider` / `scmActiveResourceHasChanges`
 *  still resolve so the title icon renders, and it renders once rather than once
 *  per owning provider. The extension half — neither manifest re-contributing an
 *  `editor/title` entry — is guarded in each extension's own
 *  `openChangeContribution.test.ts`, since extension menus never reach this
 *  render path.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  EditorRegistry,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  IUriIdentityService,
  observableValue,
  registerAction2,
  ServiceCollection,
  URI,
  UriIdentityService,
  type IDisposable,
  type ICommandService as ICommandServiceType,
  type IConfirmResult,
  type IDialogService as IDialogServiceType,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'
import { OpenChangesAction } from '../../../actions/dirtyDiffActions.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import {
  IScmDecorationsService,
  scmPathKey,
  type IScmDecorationsService as IScmDecorationsServiceType,
} from '../../../services/scm/ScmDecorationsService.js'
import {
  IScmService,
  type IScmService as IScmServiceType,
} from '../../../services/extensions/ScmService.js'

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

function FakeComponent({ input }: { input: { label: string } }) {
  return <div data-testid="fake-editor">{input.label}</div>
}

const componentMap = new Map<string, React.ComponentType<{ input: { label: string } }>>([
  ['file', FakeComponent],
])

function scmDecorationsFor(resource: URI): IScmDecorationsServiceType {
  const snapshot = observableValue('testScmDecorations', {
    files: new Map([[scmPathKey(resource.fsPath), { color: '#e2c08d', letter: 'M' }]]),
    folders: new Map(),
    supplementary: new Map(),
  })
  return {
    _serviceBrand: undefined,
    decorations: snapshot,
    getFile: (uri) => snapshot.get().files.get(scmPathKey(uri.fsPath)),
    getFolder: (uri) => snapshot.get().folders.get(scmPathKey(uri.fsPath)),
    getSupplementary: (uri) => snapshot.get().supplementary.get(scmPathKey(uri.fsPath)),
    hasChanges: (uri) => snapshot.get().files.has(scmPathKey(uri.fsPath)),
  }
}

/** Two providers own the same root — the core scenario the unified action guards. */
function scmService(): IScmServiceType {
  const sourceControls = observableValue('testScmSourceControls', [
    { id: 'git', rootUri: 'D:/repo' },
    { id: 'perforce', rootUri: 'D:/repo' },
  ])
  return {
    _serviceBrand: undefined,
    sourceControls,
  } as unknown as IScmServiceType
}

function renderWithServices(
  node: React.ReactNode,
  configure?: (services: ServiceCollection) => void,
) {
  const services = new ServiceCollection()
  services.set(IDialogService, stubDialog)
  services.set(ICommandService, stubCommand)
  services.set(IContextKeyService, new ContextKeyService())
  services.set(IUriIdentityService, new UriIdentityService('win32'))
  configure?.(services)
  const inst = new InstantiationService(services)
  const tree = <ServicesContext.Provider value={inst}>{node}</ServicesContext.Provider>
  return render(tree)
}

const disposables: IDisposable[] = []

afterEach(() => {
  while (disposables.length) disposables.pop()!.dispose()
})

describe('EditorGroupView — unified Open Changes title action', () => {
  it('renders a single openChanges icon when two providers own the same file', async () => {
    disposables.push(registerAction2(OpenChangesAction))
    disposables.push(
      EditorRegistry.registerEditorProvider({
        typeId: FileEditorInput.TYPE_ID,
        componentKey: 'file',
      }),
    )

    const svc = new EditorGroupsService()
    disposables.push(svc)
    const resource = URI.file('D:/repo/changed.ts')
    svc.activeGroup.openEditor(new FileEditorInput(resource, {} as never))

    const { container } = renderWithServices(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => (componentMap as Map<string, unknown>).get(k)) as never}
      />,
      (services) => {
        services.set(IScmDecorationsService, scmDecorationsFor(resource))
        services.set(IScmService, scmService())
      },
    )

    await screen.findByTestId(`view-title-action-${OpenChangesAction.ID}`)

    const openChangesButtons = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid^="view-title-action-"]'),
    ).filter((el) => el.dataset['testid'] === `view-title-action-${OpenChangesAction.ID}`)
    expect(openChangesButtons).toHaveLength(1)
  })
})
