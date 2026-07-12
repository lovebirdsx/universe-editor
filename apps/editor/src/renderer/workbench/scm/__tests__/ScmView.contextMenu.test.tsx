/*---------------------------------------------------------------------------------------------
 *  Regression: SCM file rows and group headers must open a context menu on
 *  right-click, surfacing provider commands that live in non-inline menu groups.
 *
 *  The reported p4 bug: "Move to Changelist" (and the other reopen/shelve commands)
 *  sat in `2_modify` / `1_edit` groups, but the file row only rendered `inline`
 *  actions and the view had no context menu — so those commands had no UI entry
 *  point at all. This guards the right-click menu + that it includes non-inline
 *  commands.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  Event,
  CommandsRegistry,
  ICommandService,
  IEditorGroupsService,
  IEditorResolverService,
  IStorageService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  type IDisposable,
  type ICommandService as ICommandServiceType,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IEditorResolverService as IEditorResolverServiceType,
  type IStorageService as IStorageServiceType,
} from '@universe-editor/platform'
import { ScmView } from '../ScmView.js'
import { IScmService, ScmService } from '../../../services/extensions/ScmService.js'
import { scmViewState } from '../scmViewState.js'
import { ServicesContext } from '../../useService.js'

const stubStorage: IStorageServiceType = {
  _serviceBrand: undefined,
  async get() {
    return undefined
  },
  async set() {},
  async remove() {},
  onDidChangeWorkspaceScope: Event.None,
}

function setup() {
  const scm = new ScmService()
  const executeCommand = vi.fn().mockResolvedValue(undefined)
  const stubCommand: ICommandServiceType = { _serviceBrand: undefined, executeCommand }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, stubCommand)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: { openEditor() {}, closeEditor() {}, indexOf: () => -1 },
  } as unknown as IEditorGroupsServiceType)
  services.set(IStorageService, stubStorage)
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose() {} }),
    resolveEditors: () => [],
    openEditor: vi.fn().mockResolvedValue(undefined),
  } as unknown as IEditorResolverServiceType)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <ScmView />
    </ServicesContext.Provider>,
  )
  return { scm, executeCommand }
}

afterEach(() => cleanup())

describe('ScmView — file-row context menu', () => {
  let contributions: IDisposable[] = []
  afterEach(() => {
    contributions.forEach((d) => d.dispose())
    contributions = []
  })

  it('right-clicking a file row shows a non-inline provider command and runs it with the selection', async () => {
    // Contribute a non-inline command exactly like perforce's "Move to Changelist"
    // (group 2_modify): it must NOT render as an inline button, but MUST appear in
    // the right-click menu.
    contributions.push(
      MenuRegistry.addMenuItem(MenuId.ScmResourceStateContext, {
        command: 'perforce.reopen',
        title: 'Move to Changelist',
        when: 'scmProvider == perforce && scmResourceState == E',
        group: '2_modify',
        order: 1,
      }),
    )

    const { scm, executeCommand } = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'perforce', 'Perforce', 'D:/repo')
      await scm.$registerGroup(0, 1, 'default', 'Default Changelist')
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/foo.txt', contextValue: 'E' },
      ])
    })

    const label = await screen.findByText('foo.txt')
    const row = label.closest('[role="treeitem"]') as HTMLElement
    expect(row).not.toBeNull()

    // The command lives in a non-inline group, so it must not be an inline button.
    expect(screen.queryByRole('button', { name: 'Move to Changelist' })).toBeNull()

    fireEvent.contextMenu(row)

    const menuItem = await screen.findByText('Move to Changelist')
    fireEvent.click(menuItem)

    expect(executeCommand).toHaveBeenCalledWith(
      'perforce.reopen',
      expect.objectContaining({ resourceUri: 'D:/repo/foo.txt', scmResourceGroupId: 'default' }),
      expect.arrayContaining([expect.objectContaining({ resourceUri: 'D:/repo/foo.txt' })]),
    )
  })
})

describe('ScmView — folder-row context menu (tree mode)', () => {
  let contributions: IDisposable[] = []
  afterEach(() => {
    contributions.forEach((d) => d.dispose())
    contributions = []
    scmViewState.setViewMode('list')
  })

  it('right-clicking a folder runs a folder command over every file beneath it', async () => {
    scmViewState.setViewMode('tree')
    contributions.push(
      MenuRegistry.addMenuItem(MenuId.ScmResourceFolderContext, {
        command: 'perforce.reopen',
        title: 'Move to Changelist',
        when: 'scmProvider == perforce',
        group: 'inline',
        order: 1,
      }),
    )

    const { scm, executeCommand } = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'perforce', 'Perforce', 'D:/repo')
      await scm.$registerGroup(0, 1, 'default', 'Default Changelist')
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/src/a.txt', contextValue: 'E' },
        { resourceUri: 'D:/repo/src/b.txt', contextValue: 'E' },
      ])
    })

    // The folder row for "src" must exist and be right-clickable.
    const folderLabel = await screen.findByText('src')
    const folderRow = folderLabel.closest('[role="treeitem"]') as HTMLElement
    expect(folderRow).not.toBeNull()

    fireEvent.contextMenu(folderRow)
    const menu = await screen.findByRole('menu')
    const menuItem = within(menu).getByText('Move to Changelist')
    fireEvent.click(menuItem)

    // Primary arg is the folder path (isDirectory), selection is every file below.
    expect(executeCommand).toHaveBeenCalledWith(
      'perforce.reopen',
      expect.objectContaining({ isDirectory: true, scmResourceGroupId: 'default' }),
      expect.arrayContaining([
        expect.objectContaining({ resourceUri: 'D:/repo/src/a.txt' }),
        expect.objectContaining({ resourceUri: 'D:/repo/src/b.txt' }),
      ]),
    )
  })
})

describe('ScmView — drag files onto a changelist group', () => {
  let registered: IDisposable | undefined
  afterEach(() => {
    registered?.dispose()
    registered = undefined
  })

  it('dropping file URIs on a group header runs the provider reopen-to command', async () => {
    // The group becomes a drop target only because the provider registers the
    // `<providerId>.reopenTo` convention command (probed via CommandsRegistry).
    registered = CommandsRegistry.registerCommand('perforce.reopenTo', () => undefined)

    const { scm, executeCommand } = setup()
    await act(async () => {
      await scm.$registerSourceControl(0, 'perforce', 'Perforce', 'D:/repo')
      await scm.$registerGroup(0, 1, 'cl:5', '#5: feature')
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/foo.txt', contextValue: 'E' },
      ])
    })

    const groupRow = (await screen.findByText('#5: feature')).closest(
      '[role="treeitem"]',
    ) as HTMLElement
    expect(groupRow).not.toBeNull()

    const dataTransfer = {
      types: ['text/uri-list'],
      files: [] as unknown as FileList,
      getData: (type: string) => (type === 'text/uri-list' ? 'file:///D:/repo/bar.txt' : ''),
      setData: () => {},
      dropEffect: 'none',
      effectAllowed: 'all',
    }

    fireEvent.drop(groupRow, { dataTransfer })

    expect(executeCommand).toHaveBeenCalledWith(
      'perforce.reopenTo',
      expect.objectContaining({ scmResourceGroupId: 'cl:5' }),
      expect.arrayContaining([
        expect.objectContaining({ resourceUri: 'D:/repo/bar.txt', scmResourceGroupId: 'cl:5' }),
      ]),
    )
  })
})
