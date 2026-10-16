/*---------------------------------------------------------------------------------------------
 *  EditorGroupView.ignoredTab — the tab's check-ignore declaration.
 *
 *  `isIgnored` is a pure read now, so a tab that only read would never be
 *  queried. These tests pin the tab's half of the contract: it declares itself
 *  visible (a tab is on screen by definition), reads the cache instead of
 *  querying, re-declares on every version bump so an answer dropped while the
 *  tab stays open is re-asked, and stays out of the channel entirely once an SCM
 *  decoration already owns the tab's colour.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  EditorRegistry,
  ICommandService,
  IContextKeyService,
  IDialogService,
  InstantiationService,
  ServiceCollection,
  URI,
  observableValue,
  type IDisposable,
  type ICommandService as ICommandServiceType,
  type IConfirmResult,
  type IDialogService as IDialogServiceType,
} from '@universe-editor/platform'
import { EditorGroupView } from '../EditorGroupView.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { ServicesContext } from '../../useService.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import {
  IScmDecorationsService,
  scmPathKey,
  type IScmDecorationsService as IScmDecorationsServiceType,
} from '../../../services/scm/ScmDecorationsService.js'
import {
  IScmIgnoredResourcesService,
  type IScmIgnoredResourcesService as IIgnoredResourcesServiceType,
} from '../../../services/scm/ScmIgnoredResourcesService.js'

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

class FakeIgnoredResources {
  declare readonly _serviceBrand: undefined
  readonly version = observableValue<number>('testIgnoredVersion', 0)
  readonly markVisible = vi.fn()
  isIgnored = vi.fn((): boolean | undefined => undefined)
}

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

function FakeComponent() {
  return <div data-testid="fake-editor" />
}

const componentMap = new Map<string, React.ComponentType>([['file', FakeComponent]])

const disposables: IDisposable[] = []

afterEach(() => {
  while (disposables.length) disposables.pop()!.dispose()
})

function renderTab(
  resource: URI,
  ignored: FakeIgnoredResources,
  opts: { withDecoration?: boolean } = {},
) {
  disposables.push(
    EditorRegistry.registerEditorProvider({
      typeId: FileEditorInput.TYPE_ID,
      componentKey: 'file',
    }),
  )
  const svc = new EditorGroupsService()
  disposables.push(svc)
  svc.activeGroup.openEditor(new FileEditorInput(resource, {} as never))

  const services = new ServiceCollection()
  services.set(IDialogService, stubDialog)
  services.set(ICommandService, stubCommand)
  services.set(IContextKeyService, new ContextKeyService())
  services.set(IScmIgnoredResourcesService, ignored as unknown as IIgnoredResourcesServiceType)
  if (opts.withDecoration) services.set(IScmDecorationsService, scmDecorationsFor(resource))

  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        resolveComponent={((k: string) => componentMap.get(k)) as never}
      />
    </ServicesContext.Provider>,
  )
}

describe('EditorGroupView — check-ignore declaration from a tab', () => {
  it('declares the tab visible and reads the cache instead of querying', async () => {
    const resource = URI.file('D:/repo/ignored.ts')
    const ignored = new FakeIgnoredResources()
    renderTab(resource, ignored)

    await screen.findByTestId('fake-editor')

    expect(ignored.markVisible).toHaveBeenCalledWith([resource])
    expect(ignored.isIgnored).toHaveBeenCalledWith(resource)
  })

  it('re-declares the tab on every version bump', async () => {
    const resource = URI.file('D:/repo/ignored.ts')
    const ignored = new FakeIgnoredResources()
    renderTab(resource, ignored)
    await screen.findByTestId('fake-editor')
    const before = ignored.markVisible.mock.calls.length
    expect(before).toBeGreaterThan(0)

    // An answer dropped while the tab stays open (a .gitignore save, an
    // invalidation) bumps the version — that is the tab's only signal to
    // re-declare; nothing else would, as the tab never re-mounts.
    await act(async () => {
      ignored.version.set(ignored.version.get() + 1, undefined)
    })

    expect(ignored.markVisible.mock.calls.length).toBe(before + 1)
  })

  it('stays out of the channel when an SCM decoration already owns the tab', async () => {
    const resource = URI.file('D:/repo/changed.ts')
    const ignored = new FakeIgnoredResources()
    renderTab(resource, ignored, { withDecoration: true })

    await screen.findByTestId('fake-editor')

    // The decoration short-circuits the ignored path, so the channel is never
    // consulted — same gate as the Explorer's rows.
    expect(ignored.markVisible).not.toHaveBeenCalled()
    expect(ignored.isIgnored).not.toHaveBeenCalled()
  })
})
