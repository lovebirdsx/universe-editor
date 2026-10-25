/*---------------------------------------------------------------------------------------------
 *  Ctrl/Alt clicks on graph entries (status bar, SCM title, menus) reach the
 *  graph commands as invocation modifiers: Ctrl opens the one graph tab to the
 *  side, Alt into a new window, a plain click keeps the reveal-or-open default.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IEditorGroupsService,
  IEditorService,
  InstantiationService,
  IUriIdentityService,
  ServiceCollection,
  UriIdentityService,
  runWithInvocationModifiers,
  type IEditorService as IEditorServiceType,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { GitGraphEditorInput } from '../../services/editor/GitGraphEditorInput.js'
import { PerforceGraphEditorInput } from '../../services/editor/PerforceGraphEditorInput.js'
import { IAuxiliaryEditorWindowService } from '../../services/windows/auxiliaryEditorWindowService.js'
import { IWindowFocusService } from '../../services/windows/windowFocusService.js'
import { FakeWindowFocusService } from '../../services/windows/testing/fakeWindowFocusService.js'
import { ViewGitGraphAction } from '../gitGraphActions.js'
import { ViewPerforceGraphAction } from '../perforceGraphActions.js'

const disposables: Array<{ dispose(): void }> = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

function setup(): {
  groups: EditorGroupsService
  openEditor: ReturnType<typeof vi.fn>
  openInNewWindow: ReturnType<typeof vi.fn>
  run: (action: { run(accessor: never): unknown }) => Promise<void>
} {
  const groups = new EditorGroupsService()
  const openEditor = vi.fn()
  const openInNewWindow = vi.fn(async (editor: unknown) => ({
    ok: true,
    editor,
    window: { part: { activeGroup: groups.activeGroup } },
  }))
  const services = new ServiceCollection(
    [IEditorGroupsService, groups],
    [IEditorService, { openEditor } as unknown as IEditorServiceType],
    [IUriIdentityService, new UriIdentityService('linux')],
    [IAuxiliaryEditorWindowService, { openEditorInNewWindow: openInNewWindow } as never],
    [IWindowFocusService, new FakeWindowFocusService()],
  )
  const inst = new InstantiationService(services)
  disposables.push(groups, inst)
  return {
    groups,
    openEditor,
    openInNewWindow,
    run: async (action) => {
      await inst.invokeFunction((accessor) => action.run(accessor as never))
    },
  }
}

describe.each([
  ['Git Graph', () => new ViewGitGraphAction(), GitGraphEditorInput],
  ['Perforce Graph', () => new ViewPerforceGraphAction(), PerforceGraphEditorInput],
] as const)('%s', (_name, createAction, InputClass) => {
  it('opens through the editor service on a plain click', async () => {
    const { groups, openEditor, run } = setup()

    await run(createAction())

    expect(openEditor).toHaveBeenCalledOnce()
    expect(openEditor.mock.calls[0]?.[0]).toBeInstanceOf(InputClass)
    expect(groups.count).toBe(1)
  })

  it('opens to the side on a Ctrl click', async () => {
    const { groups, openEditor, run } = setup()

    await runWithInvocationModifiers({ ctrlKey: true }, () => run(createAction()))

    expect(openEditor).not.toHaveBeenCalled()
    expect(groups.count).toBe(2)
    expect(groups.activeGroup.activeEditor).toBeInstanceOf(InputClass)
  })

  it('opens into a new window on an Alt click', async () => {
    const { openEditor, openInNewWindow, run } = setup()

    await runWithInvocationModifiers({ altKey: true }, () => run(createAction()))

    expect(openEditor).not.toHaveBeenCalled()
    expect(openInNewWindow).toHaveBeenCalledOnce()
    expect(openInNewWindow.mock.calls[0]?.[0]).toBeInstanceOf(InputClass)
    expect(openInNewWindow.mock.calls[0]?.[1]).toMatchObject({ mode: 'open' })
  })

  it('moves an open graph to the side instead of duplicating it', async () => {
    const { groups, run } = setup()
    const source = groups.activeGroup
    const open = new InputClass()
    source.openEditor(open)

    await runWithInvocationModifiers({ ctrlKey: true }, () => run(createAction()))

    expect(source.contains(open)).toBe(false)
    expect(groups.activeGroup.activeEditor).toBe(open)
    expect(groups.groups.flatMap((g) => g.editors)).toEqual([open])
  })
})
